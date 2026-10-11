import { describe, expect, it } from 'vitest';
import { tokenize } from '../../src/c64script/lexer';
import { parse } from '../../src/c64script/parser';
import { check } from '../../src/c64script/checker';
import { generate } from '../../src/c64script/codegen';
import { link } from '../../src/c64script/linker';
import { writePrg } from '../../src/c64script/prg-writer';
import { CodeGenError } from '../../src/c64script/errors';

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

  it('rejects 16-bit addition instead of emitting an 8-bit add', () => {
    expect(() => compile('let @zp s: u16 = 0; program @ 0xC000 { s = s + 1; }')).toThrow(CodeGenError);
  });

  it('rejects a call to an undefined function', () => {
    expect(() => compile('program @ 0xC000 { undefinedFunc(); }')).toThrow(/undefined function/);
  });

  it('emits LDA #0 before STA $D020 for COLOR_BLACK constant assignment', () => {
    // First set border to 7, then assign COLOR_BLACK (=0); with bug A still holds 7
    const prg = compile('program @ 0xC000 { VIC2.borderColor = 7; VIC2.borderColor = COLOR_BLACK; }');
    const bytes = Array.from(prg);
    // Sequence: LDA #0 (0xA9 0x00) immediately followed by STA $D020 (0x8D 0x20 0xD0)
    const idx = bytes.findIndex((_, i) =>
      bytes[i] === 0xA9 && bytes[i + 1] === 0x00 &&
      bytes[i + 2] === 0x8D && bytes[i + 3] === 0x20 && bytes[i + 4] === 0xD0,
    );
    expect(idx).toBeGreaterThanOrEqual(0);
  });

  it('emits ADC zp for ZP variable RHS in addition', () => {
    // a + b where both are @zp — RHS must use ADC zp (0x65), not just be dropped
    const prg = compile('let @zp a: u8 = 3; let @zp b: u8 = 4; program @ 0xC000 { a = a + b; }');
    const bytes = Array.from(prg);
    // ADC zp = 0x65
    expect(bytes).toContain(0x65);
  });

  it('emits JMP for break inside while loop', () => {
    // break must emit a JMP, adding a third JMP on top of while-back + infinite-loop
    const prg = compile('let @zp x: u8 = 5; program @ 0xC000 { while (x != 0) { break; } }');
    const bytes = Array.from(prg);
    // Without break: 2 JMPs (loop-back + infinite-loop). With break: 3 JMPs.
    const jmpCount = bytes.filter(b => b === 0x4C).length;
    expect(jmpCount).toBeGreaterThanOrEqual(3);
  });

  it('emits LDA/ADC/STA pattern for hardware field increment', () => {
    const prg = compile('program @ 0xC000 { VIC2.borderColor++; }');
    const bytes = Array.from(prg);
    // Must contain: LDA abs (0xAD) and STA abs (0x8D) and ADC #1 (0x69 0x01)
    expect(bytes).toContain(0xAD);
    expect(bytes).toContain(0x8D);
    const adcIdx = bytes.indexOf(0x69);
    expect(adcIdx).toBeGreaterThan(0);
    expect(bytes[adcIdx + 1]).toBe(0x01);
  });

  it('emits two branch instructions for > comparison', () => {
    // while (x > 0) needs BCC + BEQ pair to skip when <=
    const prg = compile('let @zp x: u8 = 3; program @ 0xC000 { while (x > 0) { x--; } }');
    const bytes = Array.from(prg);
    const bccCount = bytes.filter(b => b === 0x90).length;
    const beqCount = bytes.filter(b => b === 0xF0).length;
    expect(bccCount).toBeGreaterThanOrEqual(1);
    expect(beqCount).toBeGreaterThanOrEqual(1);
  });

  it('emits else branch code in if/else statement', () => {
    // The else body (LDA #2; STA $D020) must appear after the skip label
    const prg = compile('let @zp x: u8 = 0; program @ 0xC000 { if (x == 1) { VIC2.borderColor = 1; } else { VIC2.borderColor = 2; } }');
    const bytes = Array.from(prg);
    // Must contain LDA #2 (0xA9 0x02) somewhere — the else branch
    expect(bytes).toContain(0x02); // value 2 appears (also used as STA $D020 lo byte but LDA #2 makes it explicit)
    // More specifically: both 0x01 and 0x02 as LDA immediate operands
    const lda01 = bytes.findIndex((b, i) => b === 0xA9 && bytes[i + 1] === 0x01);
    const lda02 = bytes.findIndex((b, i) => b === 0xA9 && bytes[i + 1] === 0x02);
    expect(lda01).toBeGreaterThan(0);
    expect(lda02).toBeGreaterThan(0);
  });
});
