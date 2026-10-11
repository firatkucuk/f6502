import { describe, expect, it } from 'vitest';
import { compile } from '../../src/c64script/index';
import { background, border, boot, expectError } from './helpers';

describe('asm blocks run', () => {
  it('fills screen RAM with an indexed store loop', () => {
    const c = boot(`
      program @ 0x0810 {
        asm {
          lda #$A0
          ldx #0
        fill:
          sta \${screen(0, 0)},x
          sta \${screen(0, 0) + 256},x
          sta \${screen(0, 0) + 512},x
          sta \${screen(0, 0) + 744},x
          inx
          bne fill
        }
        loop {}
      }`);
    for (const addr of [0x0400, 0x04ff, 0x0500, 0x05ff, 0x0600, 0x06ff, 0x07e7]) {
      expect(c.peek(addr), `$${addr.toString(16)}`).toBe(0xa0);
    }
    expect(c.peek(0x07e8)).not.toBe(0xa0);
  });

  it('reads and writes a zero-page variable', () => {
    const c = boot(`
      let @zp n: u8 = 5;
      program @ 0x0810 {
        asm {
          inc \${n}
          lda \${n}
          sta $D020
        }
        loop {}
      }`);
    expect(border(c)).toBe(6);
  });

  it('uses a constant as an immediate', () => {
    const c = boot(`
      const MAX: u8 = 7;
      program @ 0x0810 {
        asm {
          lda #\${MAX}
          sta $D021
        }
        loop {}
      }`);
    expect(background(c)).toBe(7);
  });

  it('lo() and hi() of a constant, with an offset on a variable', () => {
    const c = boot(`
      const TABLE: u16 = 0x1234;
      let @zp w: u16 = 0;
      program @ 0x0810 {
        asm {
          lda #lo(\${TABLE})
          sta \${w}
          lda #hi(\${TABLE})
          sta \${w} + 1
        }
        VIC2.borderColor = lo(w);
        VIC2.bgColor0 = hi(w);
        loop {}
      }`);
    expect(border(c)).toBe(4);
    expect(background(c)).toBe(2);
  });

  it('calls a C64Script function with jsr ${f}', () => {
    const c = boot(`
      fn paint(): void { VIC2.borderColor = 9; }
      program @ 0x0810 {
        asm { jsr \${paint} }
        loop {}
      }`);
    expect(border(c)).toBe(9);
  });

  it('a function called only from asm is still emitted', () => {
    const c = boot(`
      fn paint(): void { VIC2.bgColor0 = 3; }
      program @ 0x0810 { asm { jsr \${paint} } loop {} }`);
    expect(background(c)).toBe(3);
  });

  it('asm inside an @inline function, expanded twice, gets unique labels', () => {
    const c = boot(`
      @inline fn spin(): void {
        asm {
          ldx #3
        again:
          dex
          bne again
        }
      }
      program @ 0x0810 {
        spin();
        spin();
        VIC2.borderColor = 4;
        loop {}
      }`);
    expect(border(c)).toBe(4);
  });

  it('forward and backward branches, with a keyword as a label', () => {
    const c = boot(`
      program @ 0x0810 {
        asm {
          lda #0
          beq skip
          lda #9
        skip:
          sta $D020
          ldx #2
        loop:
          inc $D021
          dex
          bne loop
        }
        loop {}
      }`);
    expect(border(c)).toBe(0);
    expect(background(c)).toBe(2);
  });

  it('(zp),y indirect store', () => {
    const c = boot(`
      let @zp p: u16 = 0x0500;
      program @ 0x0810 {
        asm {
          ldy #2
          lda #9
          sta (\${p}),y
        }
        loop {}
      }`);
    expect(c.peek(0x0502)).toBe(9);
  });

  it('accumulator shifts, in any letter case', () => {
    const c = boot(`
      program @ 0x0810 {
        asm {
          LDA #3
          ASL A
          asl
          STA $D020
        }
        loop {}
      }`);
    expect(border(c)).toBe(12);
  });

  it('several instructions on one line, and a character literal', () => {
    const c = boot("program @ 0x0810 { asm { lda #'H' sta $0400 } loop {} }");
    expect(c.peek(0x0400)).toBe(8);
  });

  it('resolves names against the enclosing function scope', () => {
    const c = boot(`
      fn f(): void { let t: u8 = 6; asm { lda \${t} sta $D020 } }
      program @ 0x0810 { f(); loop {} }`);
    expect(border(c)).toBe(6);
  });

  it('assembles lda $10,y as absolute,Y (no zero-page,Y form)', () => {
    const prg = compile('program @ 0x0810 { asm { lda $10,y } loop {} }');
    const bytes = Array.from(prg);
    const at = bytes.findIndex(
      (b, i) => b === 0xb9 && bytes[i + 1] === 0x10 && bytes[i + 2] === 0x00,
    );
    expect(at).toBeGreaterThan(1);
  });

  it('assembles lda $FF as zero page and lda $100 as absolute', () => {
    const bytes = Array.from(compile('program @ 0x0810 { asm { lda $FF lda $100 } loop {} }'));
    const zp = bytes.findIndex((b, i) => b === 0xa5 && bytes[i + 1] === 0xff);
    const abs = bytes.findIndex(
      (b, i) => b === 0xad && bytes[i + 1] === 0x00 && bytes[i + 2] === 0x01,
    );
    expect(zp).toBeGreaterThan(1);
    expect(abs).toBeGreaterThan(zp);
  });
});

describe('asm errors', () => {
  // `program` is line 1 and `asm {` line 2, so the first body line is line 3.
  const wrap = (body: string) => `program @ 0x0810 {\n  asm {\n${body}\n  }\n  loop {}\n}`;

  it('unknown and undocumented instructions', () => {
    expectError(wrap('    frob'), 'codegen', /unknown instruction 'FROB'/, 3);
    expectError(wrap('    lax $10'), 'codegen', /undocumented/, 3);
  });

  it('unsupported addressing mode and out-of-range values', () => {
    expectError(wrap('    sta #5'), 'codegen', /does not support/, 3);
    expectError(wrap('    lda #300'), 'codegen', /0\.\.255/, 3);
    expectError(wrap('    stx $1234,y'), 'codegen', /zero page/, 3);
    expectError(wrap('    lda'), 'codegen', /needs an operand/, 3);
  });

  it('undefined and duplicate labels', () => {
    expectError(wrap('    bne nowhere'), 'codegen', /undefined label 'nowhere'/, 3);
    expectError(
      wrap('  here:\n    nop\n  here:\n    nop'),
      'codegen',
      /label 'here' is defined twice/,
      5,
    );
  });

  it('a branch farther than 127 bytes names the label and the line', () => {
    const nops = Array.from({ length: 140 }, () => '    nop').join('\n');
    expectError(
      wrap(`    bne far\n${nops}\n  far:\n    nop`),
      'codegen',
      /branch out of range to 'far'/,
      3,
    );
  });

  it('# on a variable, and writing to a constant', () => {
    expectError(
      'let @zp v: u8 = 1;\nprogram @ 0x0810 {\n  asm {\n    lda #${v}\n  }\n  loop {}\n}',
      'codegen',
      /lo\(/,
      4,
    );
    expectError(
      'const K: u8 = 1;\nprogram @ 0x0810 {\n  asm {\n    sta ${K}\n  }\n  loop {}\n}',
      'codegen',
      /cannot write to constant/,
      4,
    );
  });

  it('an offset on a label', () => {
    expectError(wrap('  l:\n    jmp l + 1'), 'codegen', /offset.*label/, 4);
  });

  it('a label where a zero-page address is required', () => {
    expectError(wrap('  l:\n    lda (l),y'), 'codegen', /zero-page address/, 4);
  });

  it('${…} that is neither a name nor a constant', () => {
    expectError(
      'let @zp a: u8 = 1;\nlet @zp b: u8 = 2;\nprogram @ 0x0810 {\n  asm {\n    lda ${a + b}\n  }\n  loop {}\n}',
      'codegen',
      /compile-time constant/,
      5,
    );
  });

  it('a u16 constant is an address and may be stored to', () => {
    expect(() =>
      compile('const BUF: u16 = 0x0500;\nprogram @ 0x0810 { asm { sta ${BUF} } loop {} }'),
    ).not.toThrow();
  });

  it('reading a constant address is allowed (lda ${CONST})', () => {
    expect(() =>
      compile('const K: u8 = 5;\nprogram @ 0x0810 { asm { lda ${K} } loop {} }'),
    ).not.toThrow();
  });
});
