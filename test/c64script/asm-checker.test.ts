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
    // codegen is not wired yet in this task's first commit; only the checker must not object
    try {
      compile('program @ 0x0810 { asm clobbers(a, X, y, FLAGS) { nop } loop {} }');
    } catch (err) {
      expect((err as Error).message).not.toMatch(/unknown register/);
    }
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
});
