import { describe, expect, it } from 'vitest';
import { compile } from '../../src/c64script/index';
import { boot, expectError } from './helpers';

const bytes = (src: string): number[] => Array.from(compile(src));

describe('constants in address positions', () => {
  it('program @ CONST loads at the constant, byte-identical to the literal', () => {
    const named = bytes(
      'const START: u16 = 0x0810;\nprogram @ START { VIC2.borderColor = 5; loop {} }',
    );
    const literal = bytes('program @ 0x0810 { VIC2.borderColor = 5; loop {} }');
    expect(named).toEqual(literal);
    expect(named.slice(0, 2)).toEqual([0x10, 0x08]);
  });

  it('the constant may be declared after the program block', () => {
    const named = bytes('program @ START { loop {} }\nconst START: u16 = 0x0810;');
    expect(named.slice(0, 2)).toEqual([0x10, 0x08]);
  });

  it('accepts a constant expression', () => {
    const named = bytes('const BASE: u16 = 0x0800;\nprogram @ BASE + 0x10 { loop {} }');
    expect(named.slice(0, 2)).toEqual([0x10, 0x08]);
  });

  it('data @addr(CONST) lands where the literal would put it', () => {
    const body = 'program @ 0x0810 { loop {} }';
    const named = bytes(
      `const TABLE: u16 = 0x0C00;\ndata @addr(TABLE) { t: [u8; 3] = [1, 2, 3]; }\n${body}`,
    );
    const literal = bytes(`data @addr(0x0C00) { t: [u8; 3] = [1, 2, 3]; }\n${body}`);
    expect(named).toEqual(literal);
  });

  it('data @addr(CONST + n) and a constant declared later', () => {
    const named = bytes(
      'data @addr(TABLE + 0x20) { t: [u8; 2] = [7, 8]; }\nprogram @ 0x0810 { loop {} }\nconst TABLE: u16 = 0x0C00;',
    );
    const at = (a: number) => named[2 + a - 0x0810];
    expect([at(0x0c20), at(0x0c21)]).toEqual([7, 8]);
  });

  it('let @addr(CONST) names a fixed address', () => {
    const c = boot(`
      const CELL: u16 = 0x0400;
      let @addr(CELL) cell: u8;
      program @ 0x0810 { cell = 5; loop {} }`);
    expect(c.peek(0x0400)).toBe(5);
  });

  it('works in an assembly operand too', () => {
    const c = boot(`
      const TABLE: u16 = 0x0C00;
      data @addr(TABLE) { shades: [u8; 2] = [COLOR_RED, COLOR_GREEN]; }
      program @ 0x0810 {
        asm {
          ldx #1
          lda \${TABLE},x
          sta $D020
        }
        loop {}
      }`);
    expect(c.peek(0xd020) & 15).toBe(5);
  });
});

describe('address errors are located', () => {
  it('a program address that is not a constant', () => {
    expectError(
      'let @zp a: u8 = 0;\nprogram @ a {\n  loop {}\n}',
      'type',
      /program address must be a compile-time constant/,
      2,
    );
  });

  it('a program address out of range', () => {
    expectError(
      'program @ 0x10000 {\n  loop {}\n}',
      'type',
      /program address 65536 is out of range 0\.\.65535/,
      1,
    );
  });

  it('a data address that is not a constant', () => {
    expectError(
      'let @zp a: u8 = 0;\ndata @addr(a) { t: [u8; 1] = [1]; }\nprogram @ 0x0810 { loop {} }',
      'type',
      /@addr\(\.\.\.\) must be a compile-time constant/,
      2,
    );
  });

  it('a variable address that is not a constant, or is declared below it', () => {
    expectError(
      'let @addr(LATER) cell: u8;\nconst LATER: u16 = 0x0400;\nprogram @ 0x0810 { loop {} }',
      'type',
      /@addr\(\.\.\.\) must be a compile-time constant/,
      1,
    );
  });

  it('an undefined name is still reported', () => {
    expectError(
      'program @ NOWHERE {\n  loop {}\n}',
      'type',
      /program address must be a compile-time constant/,
      1,
    );
  });
});
