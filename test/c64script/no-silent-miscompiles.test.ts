import { describe, expect, it } from 'vitest';
import { compile } from '../../src/c64script/index';
import { background, border, boot, expectError } from './helpers';

describe('name resolution', () => {
  it('rejects an undefined variable on read, with its line', () => {
    expectError(
      'program @ 0x0810 {\n  VIC2.borderColor = nope;\n  loop {}\n}',
      'type',
      /undefined variable 'nope'/,
      2,
    );
  });

  it('rejects an undefined variable on assignment', () => {
    expectError(
      'program @ 0x0810 {\n  nope = 3;\n  loop {}\n}',
      'type',
      /undefined variable 'nope'/,
      2,
    );
  });

  it('rejects a call to an undefined function', () => {
    expectError(
      'program @ 0x0810 {\n  missing();\n  loop {}\n}',
      'type',
      /undefined function 'missing'/,
      2,
    );
  });

  it('rejects a call with the wrong number of arguments', () => {
    expectError(
      'fn f(a: u8): void { VIC2.borderColor = a; }\nprogram @ 0x0810 {\n  f(1, 2);\n  loop {}\n}',
      'type',
      /expects 1 argument/,
      3,
    );
  });

  it('rejects assignment to a constant', () => {
    expectError(
      'const LIMIT: u8 = 3;\nprogram @ 0x0810 {\n  LIMIT = 4;\n  loop {}\n}',
      'type',
      /cannot assign to constant 'LIMIT'/,
      3,
    );
    expectError(
      'program @ 0x0810 {\n  COLOR_RED = 3;\n  loop {}\n}',
      'type',
      /cannot assign to constant 'COLOR_RED'/,
      2,
    );
  });
});

describe('variables', () => {
  it('un-annotated global let is a real mutable variable', () => {
    const c = boot(`
      let x: u8 = 5;
      program @ 0x0810 {
        VIC2.borderColor = x;
        x = x + 1;
        VIC2.bgColor0 = x;
        loop {}
      }`);
    expect(border(c)).toBe(5);
    expect(background(c)).toBe(6);
  });

  it('a global let without initialiser starts at zero', () => {
    // `pad` pushes x up to $48, where fresh RAM holds $FF, so only the zeroing makes it 0.
    const c = boot(
      'let pad: [u8; 70];\nlet x: u8;\nprogram @ 0x0810 { VIC2.borderColor = 7; VIC2.borderColor = x; loop {} }',
    );
    expect(border(c)).toBe(0);
  });

  it('block-local let works', () => {
    const c = boot(
      'program @ 0x0810 { let c: u8 = 3; VIC2.bgColor0 = 0; VIC2.borderColor = c; loop {} }',
    );
    expect(border(c)).toBe(3);
  });

  it('for (let …) runs and increments', () => {
    const c = boot(`
      program @ 0x0810 {
        for (let i: u8 = 0; i < 10; i++) { VIC2.borderColor = i; }
        loop {}
      }`);
    expect(border(c)).toBe(9);
  });

  it('two functions can each declare a local of the same name', () => {
    const c = boot(`
      fn a(): void { let t: u8 = 1; VIC2.bgColor0 = 15; VIC2.borderColor = t; }
      fn b(): void { let t: u8 = 2; VIC2.spriteEnable = 0; VIC2.bgColor0 = t; }
      program @ 0x0810 { a(); b(); loop {} }`);
    expect(border(c)).toBe(1);
    expect(background(c)).toBe(2);
  });

  it('rejects a name declared twice in one scope', () => {
    expectError(
      'program @ 0x0810 {\n  let t: u8 = 1;\n  let t: u8 = 2;\n  loop {}\n}',
      'type',
      /'t' already defined/,
      3,
    );
  });

  it('global initialisers may be constant expressions', () => {
    const c = boot(`
      const A: u8 = 2;
      let @zp c: u8 = A + COLOR_RED + 1;
      program @ 0x0810 { VIC2.borderColor = c; loop {} }`);
    expect(border(c)).toBe(5);
  });

  it('rejects a non-constant global initialiser', () => {
    expectError(
      'let @zp a: u8 = 1;\nlet @zp b: u8 = a;\nprogram @ 0x0810 { loop {} }',
      'type',
      /compile-time constant/,
      2,
    );
  });

  it('const names fold into expressions', () => {
    const c = boot('const N: u8 = 7;\nprogram @ 0x0810 { VIC2.borderColor = N; loop {} }');
    expect(border(c)).toBe(7);
  });
});

describe('u16', () => {
  it('assignment stores both bytes', () => {
    const c = boot(`
      let @zp w: u16 = 0;
      program @ 0x0810 {
        w = 0x1234;
        VIC2.borderColor = lo(w) & 15;
        VIC2.bgColor0 = hi(w) & 15;
        loop {}
      }`);
    expect(border(c)).toBe(4);
    expect(background(c)).toBe(2);
  });

  it('copies a u16 variable into another', () => {
    const c = boot(`
      let @zp a: u16 = 0x0506;
      let @zp b: u16 = 0;
      program @ 0x0810 {
        b = a;
        VIC2.borderColor = lo(b);
        VIC2.bgColor0 = hi(b);
        loop {}
      }`);
    expect(border(c)).toBe(6);
    expect(background(c)).toBe(5);
  });

  it('zero-extends a u8 assigned to a u16', () => {
    const c = boot(`
      let @zp w: u16 = 0x0900;
      let @zp b: u8 = 7;
      program @ 0x0810 {
        w = b;
        VIC2.borderColor = lo(w);
        VIC2.bgColor0 = hi(w);
        loop {}
      }`);
    expect(border(c)).toBe(7);
    expect(background(c)).toBe(0);
  });

  it('compares the whole 16-bit value, not its low byte', () => {
    // 300 = 0x012C: the low byte alone (44) is below 100 and below 300.
    const c = boot(`
      let @zp w: u16 = 300;
      program @ 0x0810 {
        if (w < 100) { VIC2.borderColor = 1; }
        if (w == 300) { VIC2.bgColor0 = 2; }
        loop {}
      }`);
    expect(border(c)).toBe(0);
    expect(background(c)).toBe(2);
  });
});

describe('compound assignment', () => {
  it('+=, -=, |=, &=, ^= update the variable', () => {
    const c = boot(`
      let @zp x: u8 = 2;
      program @ 0x0810 {
        x += 3;
        x -= 1;
        x |= 8;
        x &= 0x0F;
        x ^= 1;
        VIC2.borderColor = x;
        loop {}
      }`);
    expect(border(c)).toBe(13);
  });

  it('works on hardware registers', () => {
    const c = boot('program @ 0x0810 { VIC2.borderColor = 3; VIC2.borderColor += 2; loop {} }');
    expect(border(c)).toBe(5);
  });

  it('rejects operators it cannot generate', () => {
    expectError(
      'let @zp x: u8 = 1;\nprogram @ 0x0810 {\n  x *= 2;\n  loop {}\n}',
      'codegen',
      /'\*='/,
      3,
    );
  });
});

describe('unsupported constructs are errors, not no-ops', () => {
  it('an unknown instruction inside asm {}', () => {
    expectError(
      'program @ 0x0810 {\n  asm { frob }\n  loop {}\n}',
      'codegen',
      /unknown instruction 'FROB'/,
      2,
    );
  });

  it('indexing something that is not an array', () => {
    expectError(
      'let @zp a: u8 = 0;\nprogram @ 0x0810 {\n  a = a[1];\n  loop {}\n}',
      'type',
      /'a' is not an array/,
      3,
    );
  });

  it('multiplication and other unsupported operators', () => {
    expectError(
      'let @zp a: u8 = 2;\nprogram @ 0x0810 {\n  a = a * 3;\n  loop {}\n}',
      'codegen',
      /operator '\*'/,
      3,
    );
  });

  it('a right operand that is not a literal, variable or register', () => {
    expectError(
      'let @zp a: u8 = 2;\nlet @zp b: u8 = 1;\nprogram @ 0x0810 {\n  a = a + (b + 1);\n  loop {}\n}',
      'codegen',
      /right-hand operand/,
      4,
    );
  });

  it('&& and || in a condition', () => {
    expectError(
      'let @zp a: u8 = 2;\nprogram @ 0x0810 {\n  if (a == 1 && a == 2) { a = 0; }\n  loop {}\n}',
      'codegen',
      /&&/,
      3,
    );
  });

  it('a bitwise condition tests non-zero instead of comparing', () => {
    const c = boot(`
      let @zp x: u8 = 3;
      program @ 0x0810 {
        if (x & 1) { VIC2.borderColor = 5; } else { VIC2.borderColor = 9; }
        if (x & 4) { VIC2.bgColor0 = 6; } else { VIC2.bgColor0 = 2; }
        loop {}
      }`);
    expect(border(c)).toBe(5);
    expect(background(c)).toBe(2);
  });
});

describe('functions', () => {
  it('a parameter keeps its value after A is clobbered', () => {
    const c = boot(`
      fn paint(c: u8): void { VIC2.bgColor0 = 0; VIC2.borderColor = c; VIC2.bgColor0 = c + 1; }
      program @ 0x0810 { paint(5); loop {} }`);
    expect(border(c)).toBe(5);
    expect(background(c)).toBe(6);
  });

  it('binds two parameters in order', () => {
    const c = boot(`
      fn paint(a: u8, b: u8): void { VIC2.borderColor = a; VIC2.bgColor0 = b; }
      program @ 0x0810 { paint(3, 9); loop {} }`);
    expect(border(c)).toBe(3);
    expect(background(c)).toBe(9);
  });

  it('returns a value', () => {
    const c = boot(`
      fn two(): u8 { return 2; }
      let @zp x: u8 = 0;
      program @ 0x0810 { x = two(); VIC2.borderColor = x + 4; loop {} }`);
    expect(border(c)).toBe(6);
  });

  it('an inline function binds parameters too', () => {
    const c = boot(`
      @inline fn paint(c: u8): void { VIC2.bgColor0 = 0; VIC2.borderColor = c; VIC2.bgColor0 = c + 2; }
      program @ 0x0810 { paint(4); loop {} }`);
    expect(border(c)).toBe(4);
    expect(background(c)).toBe(6);
  });

  it('rejects return inside an inline function', () => {
    expectError(
      '@inline fn f(): u8 {\n  return 1;\n}\nprogram @ 0x0810 { VIC2.borderColor = f(); loop {} }',
      'codegen',
      /return/,
      2,
    );
  });

  it('rejects direct recursion (there is no stack frame)', () => {
    expectError(
      'fn f(): void {\n  f();\n}\nprogram @ 0x0810 { f(); loop {} }',
      'type',
      /recurs/,
      2,
    );
  });

  it('rejects a u16 parameter', () => {
    expectError(
      'fn f(a: u16): void { VIC2.borderColor = lo(a); }\nprogram @ 0x0810 { loop {} }',
      'type',
      /u16 parameter/,
      1,
    );
  });
});

describe('data blocks', () => {
  it('rejects a data block that code would overlap', () => {
    expectError(
      'data @addr(0x0812) { t: [u8; 2] = [1, 2]; }\nprogram @ 0x0810 { VIC2.borderColor = 1; loop {} }',
      'codegen',
      /overlap|overflow/,
    );
  });

  it('emits data blocks in address order regardless of declaration order', () => {
    const prg = compile(`
      data @addr(0x0A00) { hi: [u8; 2] = [7, 8]; }
      data @addr(0x0900) { lo: [u8; 2] = [1, 2]; }
      program @ 0x0810 { loop {} }`);
    const at = (a: number) => prg[2 + a - 0x0810];
    expect([at(0x0900), at(0x0901), at(0x0a00), at(0x0a01)]).toEqual([1, 2, 7, 8]);
  });

  it('rejects a data block without @addr', () => {
    expectError('data { t: [u8; 2] = [1, 2]; }\nprogram @ 0x0810 { loop {} }', 'codegen', /@addr/);
  });
});
