import { describe, expect, it } from 'vitest';
import { tokenize } from '../../src/c64script/lexer';
import { parse } from '../../src/c64script/parser';
import { check } from '../../src/c64script/checker';
import { generate } from '../../src/c64script/codegen';
import { link } from '../../src/c64script/linker';
import { writePrg } from '../../src/c64script/prg-writer';

function compile(src: string): Uint8Array {
  return writePrg(link(generate(check(parse(tokenize(src))))));
}

describe('code generator', () => {
  it('emits CLD as first instruction in program block', () => {
    const prg = compile('program @ 0xC000 {}');
    // offset 2 = first byte after PRG header; CLD = 0xD8
    expect(prg[2]).toBe(0xD8);
  });

  it('PRG header matches load address', () => {
    const prg = compile('program @ 0xC000 {}');
    expect(prg[0]).toBe(0x00); // lo of 0xC000
    expect(prg[1]).toBe(0xC0); // hi of 0xC000
  });

  it('emits LDA/STA for ZP variable assignment', () => {
    const prg = compile('let @zp x: u8 = 5; program @ 0xC000 { x = 10; }');
    const bytes = Array.from(prg);
    // STA $02 (0x85 0x02) — x is at ZP $02
    expect(bytes).toContain(0x85);
  });

  it('emits INC for u8 increment', () => {
    const prg = compile('let @zp x: u8 = 0; program @ 0xC000 { x++; }');
    const bytes = Array.from(prg);
    // INC zp = 0xE6
    expect(bytes).toContain(0xE6);
  });

  it('emits STA $D020 for VIC2.borderColor assignment', () => {
    const prg = compile('program @ 0xC000 { VIC2.borderColor = 2; }');
    const bytes = Array.from(prg);
    // STA abs = 0x8D; $D020 = 32, 208
    const staIdx = bytes.indexOf(0x8D);
    expect(staIdx).toBeGreaterThan(0);
    expect(bytes[staIdx + 1]).toBe(0x20);
    expect(bytes[staIdx + 2]).toBe(0xD0);
  });

  it('emits JSR for function call', () => {
    const prg = compile('fn f(): void { } program @ 0xC000 { f(); }');
    const bytes = Array.from(prg);
    // JSR = 0x20
    expect(bytes).toContain(0x20);
  });

  it('emits BEQ/BNE for while loop', () => {
    const prg = compile('let @zp x: u8 = 0; program @ 0xC000 { while (x != 0) {} }');
    const bytes = Array.from(prg);
    // BEQ = 0xF0 or BNE = 0xD0
    expect(bytes.some(b => b === 0xF0 || b === 0xD0)).toBe(true);
  });

  it('emits CLC for u16 carry chain addition', () => {
    const prg = compile('let @zp s: u16 = 0; program @ 0xC000 { s = s + 1; }');
    const bytes = Array.from(prg);
    // CLC = 0x18 before ADC in carry chain
    expect(bytes).toContain(0x18);
  });
});
