import { describe, expect, it } from 'vitest';
import { boot, expectError } from './helpers';

const word = (c: ReturnType<typeof boot>, addr: number) => c.peek(addr) | (c.peek(addr + 1) << 8);

// Results are kept at fixed addresses so the tests can read them back.
const run = (body: string, head = '') =>
  boot(
    `${head}
let @addr(0x0900) out: u16;
let @addr(0x0902) out2: u16;
program @ 0x0810 {
${body}
  loop {}
}`,
    4,
  );

describe('u16 addition and subtraction', () => {
  it('carries across the byte boundary', () => {
    const c = run('let a: u16 = 0x00FF;\n out = a + 1;');
    expect(word(c, 0x0900)).toBe(0x0100);
  });

  it('borrows across the byte boundary', () => {
    const c = run('let a: u16 = 0x0100;\n out = a - 1;');
    expect(word(c, 0x0900)).toBe(0x00ff);
  });

  it('wraps at 16 bits in both directions', () => {
    const c = run('let a: u16 = 0;\n let b: u16 = 0xFFFF;\n out = a - 1;\n out2 = b + 2;');
    expect(word(c, 0x0900)).toBe(0xffff);
    expect(word(c, 0x0902)).toBe(0x0001);
  });

  it('adds two u16 variables', () => {
    const c = run('let a: u16 = 0x12F0;\n let b: u16 = 0x0345;\n out = a + b;');
    expect(word(c, 0x0900)).toBe(0x1635);
  });

  it('zero-extends a u8 on either side', () => {
    const c = run('let w: u16 = 0x0200;\n let n: u8 = 200;\n out = w + n;\n out2 = 0xD000 + n;');
    expect(word(c, 0x0900)).toBe(0x02c8);
    expect(word(c, 0x0902)).toBe(0xd0c8);
  });

  it('chains: (a + b) - c', () => {
    const c = run('let a: u16 = 1000;\n let b: u16 = 500;\n let d: u16 = 1;\n out = a + b - d;');
    expect(word(c, 0x0900)).toBe(1499);
  });

  it('+= and -= on a u16', () => {
    const c = run('let a: u16 = 0x00FE;\n a += 3;\n out = a;\n a -= 0x0100;\n out2 = a;');
    expect(word(c, 0x0900)).toBe(0x0101);
    expect(word(c, 0x0902)).toBe(0x0001);
  });

  it('reads a u16 global at an absolute address', () => {
    const c = run('out = 0x1234;\n out2 = out + 0x0101;');
    expect(word(c, 0x0902)).toBe(0x1335);
  });

  it('lo() and hi() of a 16-bit sum', () => {
    const c = run(
      'let a: u16 = 0x00FF;\n let l: u8 = lo(a + 1);\n let h: u8 = hi(a + 1);\n out = l;\n out2 = h;',
    );
    expect(word(c, 0x0900)).toBe(0x00);
    expect(word(c, 0x0902)).toBe(0x01);
  });

  it('keeps the 8-bit rule: a u16 still cannot be stored in a u8 without lo()', () => {
    expectError(
      'program @ 0x0810 {\n let a: u16 = 5;\n let b: u8 = a + 1;\n loop {}\n}',
      'codegen',
      /a 16-bit value cannot be stored in 'b'/,
      3,
    );
  });

  it('keeps the right-operand restriction', () => {
    expectError(
      'program @ 0x0810 {\n let a: u16 = 5;\n let b: u8 = 1;\n let c: u16 = a + (b + 1);\n loop {}\n}',
      'codegen',
      /right-hand operand must be a literal, a variable or a hardware register/,
      4,
    );
  });
});
