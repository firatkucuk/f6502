import { describe, expect, it } from 'vitest';
import { C64 } from '../../src/machine/c64';
import type { RomSet } from '../../src/machine/memory';
import { compile } from '../../src/c64script/index';

function makeRoms(): RomSet {
  return {
    kernal:  new Uint8Array(8192).fill(0xEA), // NOPs — lets reset vector land at $0000
    basic:   new Uint8Array(8192).fill(0x00),
    chargen: new Uint8Array(4096).fill(0x00),
  };
}

function loadAndRun(src: string, steps: number): C64 {
  const prg = compile(src);
  const lo = prg[0] ?? 0;
  const hi = prg[1] ?? 0;
  const loadAddr = lo | (hi << 8);
  const c64 = new C64(makeRoms());
  const code = prg.subarray(2);
  for (let i = 0; i < code.length; i++) c64.pokeRam(loadAddr + i, code[i]!);
  c64.cpu.regs.pc = loadAddr;
  for (let i = 0; i < steps; i++) c64.cpu.step();
  return c64;
}

describe('c64script e2e', () => {
  it('@zp variable is initialized in RAM', () => {
    const src = `let @zp x: u8 = 42; program @ 0xC000 { loop {} }`;
    const c64 = loadAndRun(src, 20);
    // ZP init writes 42 to $02 before the program loop
    expect(c64.peek(0x02)).toBe(42);
  });

  it('border color assignment reaches VIC2 register $D020', () => {
    const src = `program @ 0xC000 { VIC2.borderColor = 2; loop {} }`;
    const c64 = loadAndRun(src, 20);
    // VIC peek at $D020 OR-masks the high nibble with $F0; mask it off
    expect(c64.peek(0xD020) & 0x0F).toBe(2);
  });

  it('CLD clears decimal mode flag', () => {
    const src = `program @ 0xC000 { loop {} }`;
    const prg = compile(src);
    const lo = prg[0] ?? 0;
    const hi = prg[1] ?? 0;
    const loadAddr = lo | (hi << 8);
    const c64 = new C64(makeRoms());
    const code = prg.subarray(2);
    for (let i = 0; i < code.length; i++) c64.pokeRam(loadAddr + i, code[i]!);
    c64.cpu.regs.pc = loadAddr;
    c64.cpu.regs.p |= 0x08; // forcibly set D flag
    for (let i = 0; i < 5; i++) c64.cpu.step();
    expect(c64.cpu.regs.p & 0x08).toBe(0);
  });

  it('while loop runs until condition false', () => {
    const src = `
      let @zp x: u8 = 5;
      program @ 0xC000 {
        while (x != 0) { x--; }
        loop {}
      }`;
    const c64 = loadAndRun(src, 200);
    // After 5 decrements the loop exits; x in RAM at $02 should be 0
    expect(c64.peek(0x02)).toBe(0);
  });

  it('function call executes subroutine body', () => {
    const src = `
      fn setBlue(): void {
        VIC2.borderColor = 6;
      }
      program @ 0xC000 {
        setBlue();
        loop {}
      }`;
    const c64 = loadAndRun(src, 30);
    expect(c64.peek(0xD020) & 0x0F).toBe(6);
  });

  it('COLOR_BLACK color constant folds to zero at runtime', () => {
    // First paint the border 7 so any missing LDA leaves A=7 — proving COLOR_BLACK=0 was actually emitted
    const src = `program @ 0xC000 {
      VIC2.borderColor = 7;
      VIC2.borderColor = COLOR_BLACK;
      loop {}
    }`;
    const c64 = loadAndRun(src, 20);
    expect(c64.peek(0xD020) & 0x0F).toBe(0);
  });

  it('if/else executes else branch when condition is false', () => {
    const src = `
      let @zp x: u8 = 0;
      program @ 0xC000 {
        if (x == 1) { VIC2.borderColor = 1; }
        else { VIC2.borderColor = 2; }
        loop {}
      }`;
    const c64 = loadAndRun(src, 50);
    expect(c64.peek(0xD020) & 0x0F).toBe(2);
  });

  it('break exits while loop before body decrement', () => {
    const src = `
      let @zp x: u8 = 5;
      program @ 0xC000 {
        while (x != 0) { break; }
        VIC2.borderColor = x;
        loop {}
      }`;
    const c64 = loadAndRun(src, 100);
    expect(c64.peek(0xD020) & 0x0F).toBe(5);
  });

  it('ZP variable addition produces correct result', () => {
    const src = `
      let @zp a: u8 = 3;
      let @zp b: u8 = 4;
      program @ 0xC000 {
        a = a + b;
        VIC2.borderColor = a;
        loop {}
      }`;
    const c64 = loadAndRun(src, 100);
    expect(c64.peek(0xD020) & 0x0F).toBe(7);
  });

  it('hardware field ++ increments register value', () => {
    const src = `program @ 0xC000 {
      VIC2.borderColor = 3;
      VIC2.borderColor++;
      loop {}
    }`;
    const c64 = loadAndRun(src, 30);
    expect(c64.peek(0xD020) & 0x0F).toBe(4);
  });

  it('while loop with > does not execute when x is below threshold', () => {
    // x=1 < 2, so while (x > 2) should never run; buggy BEQ impl would loop forever
    const src = `
      let @zp x: u8 = 1;
      program @ 0xC000 {
        while (x > 2) { VIC2.borderColor = 15; }
        VIC2.borderColor = x;
        loop {}
      }`;
    const c64 = loadAndRun(src, 200);
    expect(c64.peek(0xD020) & 0x0F).toBe(1);
  });
});
