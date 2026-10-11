import { describe, expect, it } from 'vitest';
import { expectError } from './helpers';
import { compile } from '../../src/c64script/index';

describe('asm checks', () => {
  it('rejects an unknown register in clobbers()', () => {
    expectError(
      'program @ 0x0810 {\n  asm clobbers(A, Z) { nop }\n  loop {}\n}',
      'type',
      /unknown register 'Z'/,
      2,
    );
  });

  it('accepts A, X, Y and flags in any case', () => {
    expect(() =>
      compile('program @ 0x0810 { asm clobbers(a, X, y, FLAGS) { nop } loop {} }'),
    ).not.toThrow();
  });

  it('rejects an undefined name inside ${…}', () => {
    expectError(
      'program @ 0x0810 {\n  asm {\n    lda ${nothing}\n  }\n  loop {}\n}',
      'type',
      /undefined variable 'nothing'/,
      3,
    );
  });

  it('a function named in ${…} counts as a call, so recursion is still caught', () => {
    expectError(
      'fn f(): void {\n  asm {\n    jsr ${f}\n  }\n}\nprogram @ 0x0810 { f(); loop {} }',
      'type',
      /recurs|called from within itself/,
      3,
    );
  });

  it("taking a function's address is not a call (no false recursion error)", () => {
    expect(() =>
      compile(
        'fn f(): void { asm { lda #lo(${f}) sta $D020 } }\nprogram @ 0x0810 { f(); loop {} }',
      ),
    ).not.toThrow();
  });

  it('jmp ${f} inside f is still recursion', () => {
    expectError(
      'fn f(): void {\n  asm {\n    jmp ${f}\n  }\n}\nprogram @ 0x0810 { f(); loop {} }',
      'type',
      /called from within itself/,
      3,
    );
  });

  it('a variable and a function may not share a name', () => {
    expectError(
      'let @zp f: u8 = 1;\nfn f(): void { }\nprogram @ 0x0810 { loop {} }',
      'type',
      /'f' is already defined as a variable/,
      2,
    );
    expectError(
      'fn f(): void { }\nlet @zp f: u8 = 1;\nprogram @ 0x0810 { loop {} }',
      'type',
      /'f' is already defined as a function/,
      2,
    );
    expectError(
      'fn f(): void { }\nprogram @ 0x0810 {\n  let f: u8 = 1;\n  loop {}\n}',
      'type',
      /'f' is already defined as a function/,
      3,
    );
  });
});
