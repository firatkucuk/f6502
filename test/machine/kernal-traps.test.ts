import { describe, expect, it } from 'vitest';
import { C64 } from '../../src/machine/c64';
import { D64, petscii } from '../../src/machine/d64';
import { D64Source } from '../../src/machine/container';
import { filled } from './helpers';

function machine() {
  const kernal = filled(8192, 0x60); // RTS everywhere: unhandled calls return at once
  const jmpInd = (entry: number, vec: number) =>
    kernal.set([0x6c, vec & 0xff, vec >> 8], entry - 0xe000);
  jmpInd(0xffd5, 0x0330);
  jmpInd(0xffd8, 0x0332);
  jmpInd(0xffc0, 0x031a);
  jmpInd(0xffc3, 0x031c);
  jmpInd(0xffc6, 0x031e);
  jmpInd(0xffc9, 0x0320);
  jmpInd(0xffcf, 0x0324);
  jmpInd(0xffd2, 0x0326);
  kernal[0x1ffc] = 0x00;
  kernal[0x1ffd] = 0xc0; // reset vector -> $C000
  const c64 = new C64({ kernal, basic: filled(8192, 0), chargen: filled(4096, 0) });
  // The KERNAL init would set these RAM vectors; point them at distinct RTS stubs in ROM.
  const targets: Record<number, number> = {
    0x0330: 0xf000,
    0x0332: 0xf010,
    0x031a: 0xf020,
    0x031c: 0xf030,
    0x031e: 0xf040,
    0x0320: 0xf050,
    0x0324: 0xf060,
    0x0326: 0xf070,
    0x0322: 0xf080,
    0x032c: 0xf090,
    0x032a: 0xf0a0,
  };
  for (const [v, t] of Object.entries(targets)) {
    c64.pokeRam(Number(v), t & 0xff);
    c64.pokeRam(Number(v) + 1, t >> 8);
  }
  const d = D64.format('DISK', '01');
  d.writeFile(petscii('HELLO'), 2, Uint8Array.from([0x01, 0x08, 0xde, 0xad, 0xbe, 0xef]));
  c64.drive(8).mount(new D64Source(d));
  return c64;
}

/** Runs `JSR entry` from $C100 and returns once the RTS has come back to the BRK-free halt loop. */
function call(
  c64: C64,
  entry: number,
  regs: { a?: number; x?: number; y?: number } = {},
  cycles = 60,
) {
  const prog = [0x20, entry & 0xff, entry >> 8, 0x4c, 0x03, 0xc1]; // JSR entry; JMP * (self loop at $C103)
  prog.forEach((b, i) => c64.pokeRam(0xc100 + i, b));
  c64.cpu.regs.pc = 0xc100;
  c64.cpu.regs.a = regs.a ?? 0;
  c64.cpu.regs.x = regs.x ?? 0;
  c64.cpu.regs.y = regs.y ?? 0;
  c64.runCycles(cycles);
  return { ...c64.cpu.regs };
}

function setName(c64: C64, text: string, device = 8, sa = 0) {
  const bytes = petscii(text);
  bytes.forEach((b, i) => c64.pokeRam(0x0200 + i, b));
  c64.pokeRam(0xb7, bytes.length);
  c64.pokeRam(0xbb, 0x00);
  c64.pokeRam(0xbc, 0x02);
  c64.pokeRam(0xb9, sa);
  c64.pokeRam(0xba, device);
  c64.pokeRam(0x9d, 0x00); // not direct mode: no messages
}

describe('KERNAL traps', () => {
  it('LOAD to the address in X/Y (secondary address 0) returns the end address', () => {
    const c64 = machine();
    setName(c64, 'HELLO', 8, 0);
    const r = call(c64, 0xffd5, { a: 0, x: 0x00, y: 0x20 });
    expect(r.p & 1).toBe(0); // carry clear
    expect(c64.peek(0x2000)).toBe(0xde);
    expect(c64.peek(0x2003)).toBe(0xef);
    expect(r.x | (r.y << 8)).toBe(0x2004);
    expect(c64.peek(0x90)).toBe(0x40);
  });

  it('LOAD with secondary address 1 loads to the file address', () => {
    const c64 = machine();
    setName(c64, 'HELLO', 8, 1);
    call(c64, 0xffd5, { a: 0, x: 0x00, y: 0x20 });
    expect(c64.peek(0x0801)).toBe(0xde);
  });

  it('a missing file sets carry with error 4; a missing name is error 8', () => {
    const c64 = machine();
    setName(c64, 'NOPE');
    let r = call(c64, 0xffd5);
    expect(r.p & 1).toBe(1);
    expect(r.a).toBe(4);
    setName(c64, '');
    r = call(c64, 0xffd5);
    expect(r.a).toBe(8);
  });

  it('VERIFY compares and sets the status bit on a mismatch', () => {
    const c64 = machine();
    setName(c64, 'HELLO', 8, 1);
    call(c64, 0xffd5, { a: 0 });
    call(c64, 0xffd5, { a: 1 });
    expect(c64.peek(0x90) & 0x10).toBe(0);
    c64.pokeRam(0x0801, 0x00);
    const r = call(c64, 0xffd5, { a: 1 });
    expect(c64.peek(0x90) & 0x10).toBe(0x10);
    expect(r.p & 1).toBe(0);
  });

  it('SAVE writes the memory range as a PRG', () => {
    const c64 = machine();
    for (let i = 0; i < 4; i++) c64.pokeRam(0x3000 + i, 0x10 + i);
    // What the KERNAL's SAVE entry has stored before jumping through the vector:
    c64.pokeRam(0xc1, 0x00); // start $3000
    c64.pokeRam(0xc2, 0x30);
    c64.pokeRam(0xae, 0x04); // end $3004
    c64.pokeRam(0xaf, 0x30);
    setName(c64, 'SAVED', 8, 1);
    const r = call(c64, 0xffd8, { a: 0xfb, x: 0x04, y: 0x30 });
    expect(r.p & 1).toBe(0);
    const out = c64.drive(8).loadFile(petscii('SAVED'));
    expect('data' in out && [...out.data]).toEqual([0x00, 0x30, 0x10, 0x11, 0x12, 0x13]);
  });

  it('OPEN/CKOUT/CHROUT/CLOSE write a sequential file, OPEN/CHKIN/CHRIN read it', () => {
    const c64 = machine();
    c64.pokeRam(0xb8, 2);
    setName(c64, 'DATA,S,W', 8, 2);
    c64.pokeRam(0xb8, 2);
    call(c64, 0xffc0); // OPEN
    call(c64, 0xffc9, { x: 2 }); // CKOUT
    for (const ch of petscii('HI')) call(c64, 0xffd2, { a: ch }); // CHROUT
    call(c64, 0xffc3, { a: 2 }); // CLOSE
    setName(c64, 'DATA,S,R', 8, 2);
    c64.pokeRam(0xb8, 3);
    call(c64, 0xffc0);
    call(c64, 0xffc6, { x: 3 }); // CHKIN
    const a = call(c64, 0xffcf).a;
    const b = call(c64, 0xffcf).a;
    expect(String.fromCharCode(a, b)).toBe('HI');
    expect(c64.peek(0x90)).toBe(0x40);
  });

  it('prints the SEARCHING FOR and LOADING messages through CHROUT in direct mode', () => {
    const c64 = machine();
    // CHROUT vector -> a RAM routine that logs A and preserves X like the real CHROUT
    [0x86, 0xfd, 0xa6, 0xfe, 0x9d, 0x00, 0x06, 0xe6, 0xfe, 0xa6, 0xfd, 0x60].forEach((b, i) =>
      c64.pokeRam(0xc200 + i, b),
    );
    c64.pokeRam(0x0326, 0x00);
    c64.pokeRam(0x0327, 0xc2);
    c64.pokeRam(0xfe, 0);
    setName(c64, 'HELLO', 8, 0);
    c64.pokeRam(0x9d, 0x80); // direct mode
    const r = call(c64, 0xffd5, { a: 0, x: 0x00, y: 0x20 }, 4000);
    const n = c64.peek(0xfe);
    const logged = Array.from({ length: n }, (_, k) => String.fromCharCode(c64.peek(0x0600 + k)));
    expect(logged.join('')).toBe('SEARCHING FOR HELLO\rLOADING\r');
    expect(r.p & 1).toBe(0);
    expect(c64.peek(0x2000)).toBe(0xde);
    expect(r.x | (r.y << 8)).toBe(0x2004);
  });

  it('calls for other devices are left to the ROM', () => {
    const c64 = machine();
    setName(c64, 'HELLO', 4, 0);
    c64.pokeRam(0x2000, 0x77);
    const r = call(c64, 0xffd5, { a: 0, x: 0, y: 0x20 });
    expect(c64.peek(0x2000)).toBe(0x77); // untouched: the (RTS) ROM routine ran
    expect(r.p & 1).toBe(0);
  });

  it('an unmounted drive is not claimed', () => {
    const c64 = machine();
    c64.drive(8).unmount();
    setName(c64, 'HELLO', 8, 0);
    c64.pokeRam(0x2000, 0x77);
    call(c64, 0xffd5, { a: 0, x: 0, y: 0x20 });
    expect(c64.peek(0x2000)).toBe(0x77);
  });
});
