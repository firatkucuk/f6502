import { describe, expect, it } from 'vitest';
import { boot, expectError } from './helpers';

describe('screen(row, col) and color(row, col)', () => {
  it('fold to screen RAM and colour RAM addresses inside poke()', () => {
    const c = boot(`
      program @ 0x0810 {
        poke(screen(12, 15), 9);
        poke(color(12, 15), 1);
        poke(screen(0, 0), 2);
        poke(color(24, 39), 3);
        loop {}
      }`);
    expect(c.peek(0x05ef)).toBe(9);
    expect(c.peek(0xd9ef) & 0x0f).toBe(1);
    expect(c.peek(0x0400)).toBe(2);
    expect(c.peek(0xdbe7) & 0x0f).toBe(3);
  });

  it('take part in constant expressions', () => {
    const c = boot(`
      const NEXT: u16 = screen(1, 0) + 3;
      program @ 0x0810 { poke(NEXT, 7); loop {} }`);
    expect(c.peek(0x0400 + 40 + 3)).toBe(7);
  });

  it('can initialise and be copied into a 16-bit variable', () => {
    const c = boot(`
      const HOME: u16 = screen(2, 5);
      let @zp w: u16 = 0;
      program @ 0x0810 {
        w = HOME;
        VIC2.borderColor = hi(w);
        VIC2.bgColor0 = lo(w) & 15;
        loop {}
      }`);
    // $0400 + 2*40 + 5 = $0455
    expect(c.peek(0xd020) & 0x0f).toBe(4);
    expect(c.peek(0xd021) & 0x0f).toBe(5);
  });

  it('rejects a row or column off the screen, at the call', () => {
    expectError(
      'program @ 0x0810 {\n  poke(screen(25, 0), 1);\n  loop {}\n}',
      'type',
      /screen\(\): row 25 is out of range 0\.\.24/,
      2,
    );
    expectError(
      'program @ 0x0810 {\n  poke(screen(0, 40), 1);\n  loop {}\n}',
      'type',
      /screen\(\): column 40 is out of range 0\.\.39/,
      2,
    );
    expectError(
      'program @ 0x0810 {\n  poke(color(0, 40), 1);\n  loop {}\n}',
      'type',
      /color\(\): column 40 is out of range 0\.\.39/,
      2,
    );
  });

  it('need both arguments', () => {
    expectError(
      'program @ 0x0810 {\n  poke(screen(1), 1);\n  loop {}\n}',
      'type',
      /expects 2 arguments, got 1/,
      2,
    );
  });

  it('accept a runtime row or column', () => {
    const c = boot(
      'let @zp r: u8 = 3;\nprogram @ 0x0810 {\n  poke(screen(r, 0), 1);\n  loop {}\n}',
      2,
    );
    expect(c.peek(0x0400 + 3 * 40)).toBe(1);
  });

  it('do not fit in a u8: the address is 16-bit', () => {
    expectError(
      'let @zp x: u8 = 0;\nprogram @ 0x0810 {\n  x = screen(0, 0);\n  loop {}\n}',
      'codegen',
      /does not fit/,
      3,
    );
  });

  it('are reserved names for user functions', () => {
    expectError(
      'fn screen(): void { VIC2.borderColor = 1; }\nprogram @ 0x0810 { loop {} }',
      'type',
      /'screen' already defined/,
      1,
    );
  });

  it('leave a variable called color alone', () => {
    const c = boot(`
      let @zp color: u8 = 4;
      program @ 0x0810 { VIC2.borderColor = color; poke(color(0, 0), 1); loop {} }`);
    expect(c.peek(0xd020) & 0x0f).toBe(4);
    expect(c.peek(0xd800) & 0x0f).toBe(1);
  });
});
