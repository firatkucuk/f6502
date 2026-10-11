import { describe, expect, it } from 'vitest';
import { background, border, boot, expectError } from './helpers';

describe('arithmetic', () => {
  it('chained - and + do not leak a carry from the left operand', () => {
    const c = boot(`
      let @zp a: u8 = 5; let @zp b: u8 = 2; let @zp k: u8 = 1; let @zp x: u8 = 0;
      program @ 0x0810 { x = a - b + k; VIC2.borderColor = x; loop {} }`);
    expect(border(c)).toBe(4);
    const d = boot(`
      let @zp a: u8 = 3; let @zp b: u8 = 4; let @zp k: u8 = 2; let @zp x: u8 = 0;
      program @ 0x0810 { x = a + b - k; VIC2.borderColor = x; loop {} }`);
    expect(border(d)).toBe(5);
  });

  it('a carry left by a called function does not leak into the sum', () => {
    const c = boot(`
      fn f(): u8 { let t: u8 = 250; t = t + 10; return 3; }
      let @zp x: u8 = 0;
      program @ 0x0810 { x = f() + 1; VIC2.borderColor = x; loop {} }`);
    expect(border(c)).toBe(4);
  });
});

describe('scoping', () => {
  it('rejects a local that shadows a global, wherever it is declared', () => {
    expectError(
      'let g: u8 = 1;\nprogram @ 0x0810 {\n  VIC2.borderColor = g;\n  let g: u8 = 5;\n  loop {}\n}',
      'type',
      /'g' already defined/,
      4,
    );
  });

  it('rejects a parameter that shadows a global', () => {
    expectError(
      'let g: u8 = 1;\nfn f(g: u8): void { VIC2.borderColor = g; }\nprogram @ 0x0810 { f(1); loop {} }',
      'type',
      /'g' already defined/,
      2,
    );
  });

  it('allows the same loop variable in sibling blocks', () => {
    const c = boot(`
      program @ 0x0810 {
        for (let i: u8 = 0; i < 4; i++) { VIC2.borderColor = i; }
        for (let i: u8 = 0; i < 7; i++) { VIC2.bgColor0 = i; }
        loop {}
      }`);
    expect(border(c)).toBe(3);
    expect(background(c)).toBe(6);
  });

  it('rejects redeclaring a name that is visible from an enclosing block', () => {
    expectError(
      'program @ 0x0810 {\n  let i: u8 = 1;\n  if (i == 1) {\n    let i: u8 = 2;\n  }\n  loop {}\n}',
      'type',
      /'i' already defined/,
      4,
    );
  });

  it('rejects the same name with a different type in a sibling block', () => {
    expectError(
      'program @ 0x0810 {\n  for (let i: u8 = 0; i < 2; i++) {}\n  for (let i: u16 = 0; i < 2; i++) {}\n  loop {}\n}',
      'type',
      /different type/,
      3,
    );
  });

  it('a local declared without an initialiser starts at zero', () => {
    const c = boot(`
      let pad: [u8; 70];
      program @ 0x0810 { VIC2.borderColor = 7; let t: u8; VIC2.borderColor = t; loop {} }`);
    expect(border(c)).toBe(0);
  });

  it('rejects a user function named like a built-in', () => {
    expectError(
      'fn clrscr(): void { VIC2.borderColor = 5; }\nprogram @ 0x0810 { loop {} }',
      'type',
      /'clrscr' already defined/,
      1,
    );
  });
});

describe('parameter slots', () => {
  it('rejects an argument whose evaluation calls the function being called', () => {
    expectError(
      [
        'fn g(x: u8, y: u8): void { VIC2.borderColor = x; VIC2.bgColor0 = y; }',
        'fn h(): u8 { g(5, 6); return 3; }',
        'program @ 0x0810 {',
        '  g(1, h());',
        '  loop {}',
        '}',
      ].join('\n'),
      'type',
      /argument of 'g' calls 'h'/,
      4,
    );
  });

  it('allows an argument that calls an unrelated function', () => {
    const c = boot(`
      fn g(x: u8, y: u8): void { VIC2.borderColor = x; VIC2.bgColor0 = y; }
      fn k(): u8 { return 6; }
      program @ 0x0810 { g(1, k()); loop {} }`);
    expect(border(c)).toBe(1);
    expect(background(c)).toBe(6);
  });
});

describe('logic', () => {
  it('! is logical NOT, in a condition and in a constant', () => {
    const c = boot(`
      let @zp x: u8 = 2;
      let @zp z: u8 = 0;
      program @ 0x0810 {
        if (!x) { VIC2.borderColor = 1; } else { VIC2.borderColor = 2; }
        if (!z) { VIC2.bgColor0 = 3; } else { VIC2.bgColor0 = 4; }
        loop {}
      }`);
    expect(border(c)).toBe(2);
    expect(background(c)).toBe(3);
    const d = boot('const F: u8 = !2;\nprogram @ 0x0810 { VIC2.bgColor0 = F + 5; loop {} }');
    expect(background(d)).toBe(5);
  });

  it('a u16 used as a condition tests both bytes, not just the low one', () => {
    const c = boot(
      'let @zp w: u16 = 0x0100;\nprogram @ 0x0810 {\n  if (w) { VIC2.borderColor = 1; }\n  loop {}\n}',
    );
    expect(c.peek(0xd020) & 15).toBe(1); // the low byte is 0, the high byte is not
  });

  it('break and continue outside a loop are errors', () => {
    expectError('program @ 0x0810 {\n  break;\n  loop {}\n}', 'type', /break.*outside/, 2);
    expectError('program @ 0x0810 {\n  continue;\n  loop {}\n}', 'type', /continue.*outside/, 2);
    expectError(
      '@inline fn f(): void {\n  break;\n}\nprogram @ 0x0810 { loop { f(); } }',
      'type',
      /break.*outside/,
      2,
    );
  });
});

describe('values that do not fit', () => {
  it('rejects a constant above 255 for a u8', () => {
    expectError(
      'const A: u8 = 300;\nprogram @ 0x0810 { loop {} }',
      'type',
      /300 does not fit in u8/,
      1,
    );
    expectError(
      'let x: u8 = 300;\nprogram @ 0x0810 { loop {} }',
      'type',
      /300 does not fit in u8/,
      1,
    );
  });

  it('rejects an out-of-range assignment, argument and poke value', () => {
    expectError(
      'let @zp x: u8 = 0;\nprogram @ 0x0810 {\n  x = 300;\n  loop {}\n}',
      'codegen',
      /300 does not fit/,
      3,
    );
    expectError(
      'fn f(a: u8): void { VIC2.borderColor = a; }\nprogram @ 0x0810 {\n  f(300);\n  loop {}\n}',
      'codegen',
      /300 does not fit/,
      3,
    );
    expectError(
      'program @ 0x0810 {\n  poke(0x0400, 300);\n  loop {}\n}',
      'codegen',
      /300 does not fit/,
      2,
    );
  });

  it('rejects storing a u16 in a u8 unless it is narrowed explicitly', () => {
    expectError(
      'let @zp w: u16 = 0x0105;\nlet @zp x: u8 = 0;\nprogram @ 0x0810 {\n  x = w;\n  loop {}\n}',
      'codegen',
      /16-bit value/,
      4,
    );
    const c = boot(`
      let @zp w: u16 = 0x0105;
      let @zp x: u8 = 0;
      program @ 0x0810 { x = w as u8; VIC2.borderColor = x; VIC2.bgColor0 = lo(w) + 1; loop {} }`);
    expect(border(c)).toBe(5);
    expect(background(c)).toBe(6);
  });

  it('rejects a u16 return type', () => {
    expectError(
      'fn f(): u16 { return 300; }\nprogram @ 0x0810 { loop {} }',
      'type',
      /u16 return/,
      1,
    );
  });

  it('hi() of an 8-bit variable is an error, not the next variable', () => {
    expectError(
      'let @zp a: u8 = 1;\nprogram @ 0x0810 {\n  VIC2.borderColor = hi(a);\n  loop {}\n}',
      'codegen',
      /hi\(\)/,
      3,
    );
  });

  it('data: wrong value count and values above 255 are errors', () => {
    expectError(
      'data @addr(0x0900) { t: [u8; 2] = [1, 2, 3]; }\nprogram @ 0x0810 { loop {} }',
      'codegen',
      /3 values/,
      1,
    );
    expectError(
      'data @addr(0x0900) { t: [u8; 2] = [1, 300]; }\nprogram @ 0x0810 { loop {} }',
      'codegen',
      /300 does not fit/,
      1,
    );
  });
});

describe('write-only registers and const annotations', () => {
  it('compound assignment and ++ on a write-only register read it, so they are errors', () => {
    expectError(
      'program @ 0x0810 {\n  VIC2.rasterIRQ += 1;\n  loop {}\n}',
      'type',
      /cannot read from writeonly/,
      2,
    );
    expectError(
      'program @ 0x0810 {\n  VIC2.rasterIRQ++;\n  loop {}\n}',
      'type',
      /cannot read from writeonly/,
      2,
    );
  });

  it('a const cannot carry a storage annotation', () => {
    expectError(
      'const @zp X: u8 = 5;\nprogram @ 0x0810 { loop {} }',
      'type',
      /const.*annotation/,
      1,
    );
  });

  it('zero-page exhaustion is reported at the declaration', () => {
    expectError(
      'let @zp big: [u8; 250];\nprogram @ 0x0810 { loop {} }',
      'type',
      /zero-page budget/,
      1,
    );
  });
});
