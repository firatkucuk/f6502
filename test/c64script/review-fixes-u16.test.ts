import { describe, expect, it } from 'vitest';
import { boot, expectError } from './helpers';

describe('final-review fixes', () => {
  it('(w + 1) as u8 narrows a 16-bit expression', () => {
    const c = boot(
      'let w: u16 = 0x1234;\nprogram @ 0x0810 {\n  let x: u8 = (w + 1) as u8;\n  poke(0x0900, x);\n  loop {}\n}',
      3,
    );
    expect(c.peek(0x0900)).toBe(0x35);
  });

  it('a user @addr inside the compiler-reserved zero page is an error', () => {
    expectError(
      'let @addr(0x00F8) x: u8;\nprogram @ 0x0810 {\n  loop {}\n}',
      'type',
      /overlaps \$F8-\$FF, which are reserved by the compiler/,
      1,
    );
    // a u16 that starts below but ends inside the reserved bytes
    expectError(
      'let @addr(0x00F7) w: u16;\nprogram @ 0x0810 {\n  loop {}\n}',
      'type',
      /overlaps \$F8-\$FF, which are reserved by the compiler/,
      1,
    );
  });

  it('an @addr at $F7 (u8) and at $0100 are fine', () => {
    boot(
      'let @addr(0x00F7) a: u8;\nlet @addr(0x0100) b: u8;\nprogram @ 0x0810 {\n  a = 1;\n  loop {}\n}',
      2,
    );
  });

  it('a u16 scalar field in a data block takes two bytes, so later fields line up', () => {
    const c = boot(
      `data @addr(0x0C00) { n: u16 = 0x1234; t: [u8; 2] = [11, 22]; }
program @ 0x0810 {
  poke(0x0900, t[0]);
  loop {}
}`,
      3,
    );
    expect(c.peek(0x0c00)).toBe(0x34);
    expect(c.peek(0x0c01)).toBe(0x12);
    expect(c.peek(0x0c02)).toBe(11);
    expect(c.peek(0x0900)).toBe(11);
  });
});
