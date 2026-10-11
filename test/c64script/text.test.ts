import { describe, expect, it } from 'vitest';
import { boot, expectError } from './helpers';
import { tokenize } from '../../src/c64script/lexer';

const at = (c: ReturnType<typeof boot>, row: number, col: number) =>
  c.peek(0x0400 + row * 40 + col);
const colourAt = (c: ReturnType<typeof boot>, row: number, col: number) =>
  c.peek(0xd800 + row * 40 + col) & 0x0f;

describe('character literals', () => {
  it.each([
    ['A', 1],
    ['H', 8],
    ['Z', 26],
    ['@', 0],
    ['[', 27],
    [']', 29],
    [' ', 32],
    ['!', 33],
    ['*', 42],
    ['.', 46],
    ['/', 47],
    ['0', 48],
    ['9', 57],
    ['?', 63],
  ] as const)("'%s' is screen code %i", (ch, code) => {
    const c = boot(`program @ 0x0810 { poke(0x0400, 99); poke(0x0400, '${ch}'); loop {} }`);
    expect(c.peek(0x0400)).toBe(code);
  });

  it("'\\'' is the apostrophe (screen code 39)", () => {
    const c = boot("program @ 0x0810 { poke(0x0400, '\\''); loop {} }");
    expect(c.peek(0x0400)).toBe(39);
  });

  it('are plain constants: usable in const expressions and comparisons', () => {
    const c = boot(`
      const NEXT: u8 = 'H' + 1;
      let @zp x: u8 = 'I';
      program @ 0x0810 {
        poke(0x0400, NEXT);
        if (x == 'I') { poke(0x0401, 7); }
        loop {}
      }`);
    expect(c.peek(0x0400)).toBe(9);
    expect(c.peek(0x0401)).toBe(7);
  });

  it('reject lowercase letters, naming the uppercase one', () => {
    expectError(
      "program @ 0x0810 {\n  poke(0x0400, 'h');\n  loop {}\n}",
      'lex',
      /lowercase 'h'.*use 'H'/,
      2,
    );
  });

  it('reject empty, multi-character and unterminated literals', () => {
    expectError(
      "program @ 0x0810 {\n  poke(0x0400, '');\n  loop {}\n}",
      'lex',
      /empty character literal/,
      2,
    );
    expectError(
      "program @ 0x0810 {\n  poke(0x0400, 'AB');\n  loop {}\n}",
      'lex',
      /exactly one character/,
      2,
    );
    expectError("program @ 0x0810 {\n  poke(0x0400, 'A);\n  loop {}\n}", 'lex', /unterminated/, 2);
  });

  it('reject characters without a screen code and unknown escapes', () => {
    expectError(
      "program @ 0x0810 {\n  poke(0x0400, '~');\n  loop {}\n}",
      'lex',
      /no screen code for '~'/,
      2,
    );
    expectError(
      "program @ 0x0810 {\n  poke(0x0400, '\\n');\n  loop {}\n}",
      'lex',
      /unknown escape/,
      2,
    );
  });

  it('are lexed as integer literals (no parser change)', () => {
    const kinds = tokenize("'H'").map((t) => `${t.kind}:${t.text}`);
    expect(kinds).toEqual(['int_lit:8', 'eof:']);
  });
});

describe('puts(row, col, "TEXT" [, colour])', () => {
  it('writes the text as screen codes', () => {
    const c = boot('program @ 0x0810 { puts(12, 15, "HELLO C64"); loop {} }');
    const codes = Array.from({ length: 9 }, (_, i) => at(c, 12, 15 + i));
    expect(codes).toEqual([8, 5, 12, 12, 15, 32, 3, 0x36, 0x34]);
  });

  it('colours every character cell when given a colour', () => {
    const c = boot('program @ 0x0810 { puts(3, 4, "AB C", COLOR_WHITE); loop {} }');
    expect([at(c, 3, 4), at(c, 3, 5), at(c, 3, 6), at(c, 3, 7)]).toEqual([1, 2, 32, 3]);
    for (let i = 0; i < 4; i++) expect(colourAt(c, 3, 4 + i)).toBe(1);
    expect(colourAt(c, 3, 3)).not.toBe(1);
    expect(colourAt(c, 3, 8)).not.toBe(1);
  });

  it('does not write outside the text', () => {
    const c = boot(
      'program @ 0x0810 { poke(0x05ef, 99); poke(0x05f8, 98); puts(12, 16, "AB"); loop {} }',
    );
    expect(at(c, 12, 15)).toBe(99);
    expect(at(c, 12, 16)).toBe(1);
    expect(at(c, 12, 17)).toBe(2);
    expect(at(c, 12, 18)).not.toBe(2);
  });

  it('keeps // and quotes inside a string', () => {
    const c = boot(
      `program @ 0x0810 { puts(0, 0, "A//B"); puts(1, 0, "IT'S"); puts(2, 0, "SAY \\"HI\\""); loop {} }`,
    );
    expect([0, 1, 2, 3].map((i) => at(c, 0, i))).toEqual([1, 47, 47, 2]);
    expect([0, 1, 2, 3].map((i) => at(c, 1, i))).toEqual([9, 20, 39, 19]);
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((i) => at(c, 2, i))).toEqual([19, 1, 25, 32, 34, 8, 9, 34]);
  });

  it('works with positions built by screen()', () => {
    const c = boot('program @ 0x0810 { puts(24, 39, "X"); loop {} }');
    expect(at(c, 24, 39)).toBe(24);
  });

  it('rejects text that runs off the right edge, at the call', () => {
    expectError(
      'program @ 0x0810 {\n  puts(0, 35, "HELLO WORLD");\n  loop {}\n}',
      'type',
      /puts\(\): 11 characters starting at column 35 run past column 39/,
      2,
    );
  });

  it('rejects a row off the screen, a bad colour and lowercase text', () => {
    expectError(
      'program @ 0x0810 {\n  puts(25, 0, "A");\n  loop {}\n}',
      'type',
      /puts\(\): row 25 is out of range/,
      2,
    );
    expectError(
      'program @ 0x0810 {\n  puts(0, 0, "A", 16);\n  loop {}\n}',
      'type',
      /puts\(\): colour/,
      2,
    );
    expectError(
      'program @ 0x0810 {\n  puts(0, 0, "Hi");\n  loop {}\n}',
      'lex',
      /lowercase 'i'.*use 'I'/,
      2,
    );
  });

  it('rejects wrong arity, a non-string text and an empty string', () => {
    expectError(
      'program @ 0x0810 {\n  puts(1, 2);\n  loop {}\n}',
      'type',
      /expects 3 or 4 arguments, got 2/,
      2,
    );
    expectError(
      "program @ 0x0810 {\n  puts(1, 2, 'A');\n  loop {}\n}",
      'type',
      /third argument must be a string literal/,
      2,
    );
    expectError('program @ 0x0810 {\n  puts(1, 2, "");\n  loop {}\n}', 'lex', /empty string/, 2);
  });

  it('rejects a runtime row or column, explaining why', () => {
    expectError(
      'let @zp r: u8 = 3;\nprogram @ 0x0810 {\n  puts(r, 0, "A");\n  loop {}\n}',
      'codegen',
      /puts\(\): row and column must be compile-time constants/,
      3,
    );
  });

  it('a string anywhere else is an error that says where strings are allowed', () => {
    expectError(
      'let @zp x: u8 = 0;\nprogram @ 0x0810 {\n  x = "A";\n  loop {}\n}',
      'type',
      /only allowed as the third argument of puts\(\)/,
      3,
    );
    expectError(
      'program @ 0x0810 {\n  poke(0x0400, "A");\n  loop {}\n}',
      'type',
      /only allowed as the third argument of puts\(\)/,
      2,
    );
  });

  it('is a reserved function name', () => {
    expectError(
      'fn puts(): void { VIC2.borderColor = 1; }\nprogram @ 0x0810 { loop {} }',
      'type',
      /'puts' already defined/,
      1,
    );
  });
});
