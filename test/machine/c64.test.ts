import { describe, expect, it } from 'vitest';
import { C64 } from '../../src/machine/c64';
import { PALETTE } from '../../src/machine/palette';
import { PrgError } from '../../src/machine/prg';
import { FRAME_WIDTH } from '../../src/machine/vic';
import { filled } from './helpers';

/**
 * A synthetic KERNAL: sets up the VIC, writes screen code 1 / colour 1 to the first cell, loops.
 * Glyph for screen code 1 is $F0 on every row.
 */
function syntheticRoms() {
  const kernal = filled(8192, 0xea);
  const code = [
    0x78, // SEI
    0xa9,
    0x1b,
    0x8d,
    0x11,
    0xd0, // LDA #$1B ; STA $D011
    0xa9,
    0x08,
    0x8d,
    0x16,
    0xd0, // LDA #$08 ; STA $D016
    0xa9,
    0x14,
    0x8d,
    0x18,
    0xd0, // LDA #$14 ; STA $D018 (VM $0400, CB $1000 = chargen ROM)
    0xa9,
    0x0e,
    0x8d,
    0x20,
    0xd0, // border light blue
    0xa9,
    0x06,
    0x8d,
    0x21,
    0xd0, // background blue
    0xa9,
    0x01,
    0x8d,
    0x00,
    0x04, // LDA #1 ; STA $0400
    0xa9,
    0x01,
    0x8d,
    0x00,
    0xd8, // LDA #1 ; STA $D800 (white)
    0x4c,
    0x00,
    0x00, // JMP * (target patched below)
  ];
  kernal.set(code, 0);
  const jmpAt = code.length - 3;
  kernal[jmpAt + 1] = (0xe000 + jmpAt) & 0xff;
  kernal[jmpAt + 2] = (0xe000 + jmpAt) >> 8;
  kernal[0x1ffc] = 0x00; // reset vector -> $E000
  kernal[0x1ffd] = 0xe0;
  const chargen = filled(4096, 0);
  for (let row = 0; row < 8; row++) chargen[1 * 8 + row] = 0xf0; // screen code 1
  return { kernal, basic: filled(8192, 0), chargen };
}

/** A machine whose keyboard buffer state is initialised as the KERNAL would leave it. */
function newMachine(): C64 {
  const c64 = new C64(syntheticRoms());
  c64.pokeRam(0xc6, 0); // NDX: no characters queued (power-on RAM holds $FF there)
  c64.pokeRam(0x0289, 10); // XMAX: keyboard buffer length
  return c64;
}

function typed(c64: C64): string {
  return Array.from({ length: c64.peek(0xc6) }, (_, i) =>
    String.fromCharCode(c64.peek(0x0277 + i)),
  ).join('');
}

describe('C64 integration with a synthetic KERNAL', () => {
  it('renders a glyph, colours and border after a couple of frames', () => {
    const c64 = newMachine();
    c64.runFrame();
    c64.runFrame();
    const { pixels } = c64.frame;
    expect(pixels[0]).toBe(PALETTE[14]); // border
    expect(pixels[36 * FRAME_WIDTH + 32]).toBe(PALETTE[1]); // glyph foreground
    expect(pixels[36 * FRAME_WIDTH + 36]).toBe(PALETTE[6]); // background
  });

  it('exposes frame geometry', () => {
    const c64 = newMachine();
    expect(c64.frame.width).toBe(384);
    expect(c64.frame.height).toBe(272);
    expect(c64.frame.pixels).toHaveLength(384 * 272);
  });

  it('runFrame advances exactly one VIC frame (19,656 cycles each)', () => {
    const c64 = newMachine();
    c64.runFrame();
    const start = c64.cpu.cycles;
    for (let i = 0; i < 10; i++) c64.runFrame();
    expect(c64.cpu.cycles - start).toBe(19_656 * 10);
  });

  it('screenText converts screen codes (1 -> A) and isReady is false without READY.', () => {
    const c64 = newMachine();
    c64.runFrame();
    c64.runFrame();
    expect(c64.screenText()[0]!.startsWith('A')).toBe(true);
    expect(c64.isReady()).toBe(false);
  });

  it('runUntilReady times out cleanly (returns false) instead of hanging', () => {
    const c64 = newMachine();
    expect(c64.runUntilReady(3)).toBe(false);
  });

  it('isReady detects READY. in screen RAM', () => {
    const c64 = newMachine();
    c64.runFrame();
    const ready = [0x12, 0x05, 0x01, 0x04, 0x19, 0x2e];
    ready.forEach((code, i) => c64.pokeRam(0x0400 + 40 + i, code));
    expect(c64.isReady()).toBe(true);
    expect(c64.runUntilReady(1)).toBe(true);
  });
});

describe('typing', () => {
  it('writes into the KERNAL keyboard buffer ($0277, count at $C6)', () => {
    const c64 = newMachine();
    c64.type('RUN\r');
    c64.runFrame();
    expect(c64.peek(0xc6)).toBe(4);
    expect(typed(c64)).toBe('RUN\r');
  });

  it('maps £ ↑ ← to their PETSCII codes and skips characters with no PETSCII equivalent', () => {
    const c64 = newMachine();
    c64.type('A£^_{|}~`\\B');
    c64.runFrame();
    expect(Array.from({ length: c64.peek(0xc6) }, (_, i) => c64.peek(0x0277 + i))).toEqual([
      0x41, 0x5c, 0x5e, 0x5f, 0x42,
    ]);
  });

  it('queues more than the buffer holds and feeds it as it drains', () => {
    const c64 = newMachine();
    c64.type('A'.repeat(25));
    c64.runFrame();
    expect(c64.peek(0xc6)).toBe(10);
    c64.pokeRam(0xc6, 0); // the KERNAL consumed them
    c64.runFrame();
    expect(c64.peek(0xc6)).toBe(10);
    c64.pokeRam(0xc6, 0);
    c64.runFrame();
    expect(c64.peek(0xc6)).toBe(5);
  });
});

describe('loadPrg', () => {
  it('copies a BASIC program, fixes VARTAB/ARYTAB/STREND and types RUN', () => {
    const c64 = newMachine();
    const prg = Uint8Array.from([
      0x01, 0x08, 0x0b, 0x08, 0x0a, 0x00, 0x99, 0x22, 0x48, 0x49, 0x22, 0x00, 0x00, 0x00,
    ]);
    c64.loadPrg(prg, { whenReady: false });
    c64.runFrame();
    expect(c64.peek(0x0801)).toBe(0x0b);
    const end = 0x0801 + 12;
    for (const lo of [0x2d, 0x2f, 0x31]) {
      expect(c64.peek(lo)).toBe(end & 0xff);
      expect(c64.peek(lo + 1)).toBe(end >> 8);
    }
    expect(typed(c64)).toBe('RUN\r');
  });

  it('types SYS <address> for machine code at another address', () => {
    const c64 = newMachine();
    c64.loadPrg(Uint8Array.from([0x00, 0xc0, 0x60]), { whenReady: false });
    c64.runFrame();
    expect(c64.peek(0xc000)).toBe(0x60);
    expect(typed(c64)).toBe('SYS 49152\r');
  });

  it('explicit address/start places a raw binary and SYSes the start', () => {
    const c64 = newMachine();
    c64.loadPrg(Uint8Array.from([0xea, 0x60]), {
      address: 0xc000,
      start: 0xc001,
      whenReady: false,
    });
    c64.runFrame();
    expect(c64.peek(0xc000)).toBe(0xea);
    expect(typed(c64)).toBe('SYS 49153\r');
  });

  it("run: 'none' only copies", () => {
    const c64 = newMachine();
    c64.loadPrg(Uint8Array.from([0x01, 0x08, 0x05]), { run: 'none', whenReady: false });
    c64.runFrame();
    expect(c64.peek(0x0801)).toBe(0x05);
    expect(c64.peek(0xc6)).toBe(0);
  });

  it('defers until READY. is on screen by default (a load before boot would be wiped by NEW)', () => {
    const c64 = newMachine();
    c64.pokeRam(0x0801, 0x77); // sentinel
    c64.loadPrg(Uint8Array.from([0x01, 0x08, 0x05]), { run: 'none' });
    expect(c64.peek(0x0801)).toBe(0x77);
    c64.runFrame();
    c64.runFrame();
    expect(c64.peek(0x0801)).toBe(0x77); // still not ready
    c64.runFrame();
    [0x12, 0x05, 0x01, 0x04, 0x19, 0x2e].forEach((code, i) => c64.pokeRam(0x0400 + 40 + i, code));
    c64.runFrame();
    expect(c64.peek(0x0801)).toBe(0x05);
  });

  it('a deferred load starts the program once it lands', () => {
    const c64 = newMachine();
    c64.loadPrg(Uint8Array.from([0x00, 0xc0, 0x60]));
    expect(typed(c64)).toBe('');
    c64.runFrame();
    [0x12, 0x05, 0x01, 0x04, 0x19, 0x2e].forEach((code, i) => c64.pokeRam(0x0400 + 40 + i, code));
    c64.runFrame();
    expect(typed(c64)).toBe('SYS 49152\r');
  });

  it('a malformed PRG is rejected immediately even when the load would be deferred', () => {
    const c64 = newMachine();
    expect(() => c64.loadPrg(Uint8Array.from([0x01, 0x08]))).toThrow(PrgError);
  });

  it('rejects a truncated PRG without writing anything', () => {
    const c64 = newMachine();
    c64.pokeRam(0x0801, 0x77);
    expect(() => c64.loadPrg(Uint8Array.from([0x01, 0x08]))).toThrow(PrgError);
    expect(c64.peek(0x0801)).toBe(0x77);
  });
});

describe('keyboard and RESTORE', () => {
  it('RESTORE raises an NMI edge the CPU takes', () => {
    const c64 = newMachine();
    c64.runFrame();
    const before = c64.cpu.regs.sp;
    c64.restore();
    c64.runCycles(50);
    expect(c64.cpu.regs.sp).not.toBe(before); // interrupt sequence pushed to the stack
  });

  it('keyDown is visible through CIA1 (column select via $DC00, rows via $DC01)', () => {
    const c64 = newMachine();
    c64.runFrame();
    c64.keyDown('A');
    c64.busWrite(0xdc02, 0xff); // DDRA: all outputs, as the KERNAL sets it
    c64.busWrite(0xdc00, 0b1111_1101); // select column 1
    expect(c64.peek(0xdc01)).toBe(0b1111_1011);
    c64.keyUp('A');
    expect(c64.peek(0xdc01)).toBe(0xff);
  });
});
