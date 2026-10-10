import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { C64 } from '../../src/machine/c64';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '..', '..', '.testdata', 'openroms', 'bin');

function roms() {
  const read = (name: string) => {
    const file = join(DIR, name);
    if (!existsSync(file)) throw new Error(`${file} missing: run "npm run fetch-test-data"`);
    return new Uint8Array(readFileSync(file));
  };
  return {
    kernal: read('kernal_generic.rom'),
    basic: read('basic_generic.rom'),
    chargen: read('chargen_openroms.rom'),
  };
}

function runFrames(c64: C64, n: number) {
  for (let i = 0; i < n; i++) c64.runFrame();
}

describe('OpenROMs boot', () => {
  it('reaches the READY. prompt within 600 frames', () => {
    const c64 = new C64(roms());
    expect(c64.runUntilReady(600)).toBe(true);
  });

  it('accepts typed input: PRINT "HELLO" prints HELLO', () => {
    // The OpenROMs dev build has no floating-point BASIC (PRINT 2+2 answers ?NOT IMPLEMENTED
    // ERROR), so typing is proven with a string literal.
    const c64 = new C64(roms());
    expect(c64.runUntilReady(600)).toBe(true);
    c64.type('PRINT "HELLO"\r');
    runFrames(c64, 60);
    expect(c64.screenText().some((line) => line.trim() === 'HELLO')).toBe(true);
  });

  it('reports an unsupported statement as an error and returns to READY. (typed keys reach BASIC)', () => {
    const c64 = new C64(roms());
    expect(c64.runUntilReady(600)).toBe(true);
    c64.type('PRINT 2+2\r');
    runFrames(c64, 60);
    const lines = c64.screenText();
    expect(lines.some((line) => line.startsWith('PRINT 2+2'))).toBe(true);
    expect(lines.filter((line) => line.includes('READY.')).length).toBe(2);
  });

  it('runs a BASIC .prg: 10 PRINT "HI"', () => {
    const c64 = new C64(roms());
    expect(c64.runUntilReady(600)).toBe(true);
    const prg = Uint8Array.from([
      0x01, 0x08, 0x0b, 0x08, 0x0a, 0x00, 0x99, 0x22, 0x48, 0x49, 0x22, 0x00, 0x00, 0x00,
    ]);
    c64.loadPrg(prg);
    runFrames(c64, 120);
    expect(c64.screenText().some((line) => line.trim() === 'HI')).toBe(true);
  });

  it('a loadPrg issued before boot is deferred until READY. and then runs', () => {
    const c64 = new C64(roms());
    const prg = Uint8Array.from([
      0x01, 0x08, 0x0b, 0x08, 0x0a, 0x00, 0x99, 0x22, 0x48, 0x49, 0x22, 0x00, 0x00, 0x00,
    ]);
    c64.loadPrg(prg); // power-on: BASIC's NEW would wipe an immediate copy
    expect(c64.runUntilReady(600)).toBe(true);
    runFrames(c64, 120);
    expect(c64.screenText().some((line) => line.trim() === 'HI')).toBe(true);
  });

  it('runs a machine-code .prg via SYS and returns to READY.', () => {
    const c64 = new C64(roms());
    expect(c64.runUntilReady(600)).toBe(true);
    // $C000: LDA #$08 ; STA $0400 ; RTS  (screen code 8 = 'H' in the top-left cell)
    const before = c64.screenText().filter((l) => l.includes('READY.')).length;
    c64.loadPrg(Uint8Array.from([0x00, 0xc0, 0xa9, 0x08, 0x8d, 0x00, 0x04, 0x60]));
    runFrames(c64, 120);
    expect(c64.peek(0x0400)).toBe(0x08);
    const readyCount = c64.screenText().filter((l) => l.includes('READY.')).length;
    expect(readyCount).toBe(before + 1);
    expect(c64.cpu.halted).toBe(false);
  });
});
