import { describe, expect, it } from 'vitest';
import { boot, expectError } from './helpers';

describe('runtime poke and peek', () => {
  it('pokes through a computed address', () => {
    const c = boot(
      `program @ 0x0810 {
  let base: u16 = 0x0C00;
  let i: u8 = 5;
  poke(base + i, 77);
  loop {}
}`,
      3,
    );
    expect(c.peek(0x0c05)).toBe(77);
  });

  it('the value may itself need the accumulator (peek inside poke)', () => {
    const c = boot(
      `program @ 0x0810 {
  poke(0x0C00, 9);
  let a: u16 = 0x0C00;
  let b: u16 = 0x0D00;
  poke(b, peek(a) + 1);
  loop {}
}`,
      3,
    );
    expect(c.peek(0x0d00)).toBe(10);
  });

  it('peek reads a constant and a computed address', () => {
    const c = boot(
      `program @ 0x0810 {
  poke(0x0C10, 41);
  let p: u16 = 0x0C00;
  let k: u8 = 0x10;
  poke(0x0900, peek(0x0C10));
  poke(0x0901, peek(p + k));
  loop {}
}`,
      3,
    );
    expect([c.peek(0x0900), c.peek(0x0901)]).toEqual([41, 41]);
  });
});

describe('runtime screen() and color()', () => {
  const corners: Array<[number, number]> = [
    [0, 0],
    [0, 39],
    [24, 0],
    [24, 39],
    [12, 20],
    [1, 0],
    [7, 33],
  ];
  for (const [r, col] of corners) {
    it(`screen(${r}, ${col}) and color(${r}, ${col}) with variables`, () => {
      const c = boot(
        `program @ 0x0810 {
  let r: u8 = ${r};
  let c: u8 = ${col};
  poke(screen(r, c), 0xA0);
  poke(color(r, c), 7);
  loop {}
}`,
        3,
      );
      expect(c.peek(0x0400 + r * 40 + col)).toBe(0xa0);
      expect(c.peek(0xd800 + r * 40 + col) & 15).toBe(7);
    });
  }

  it('row and column may be expressions', () => {
    const c = boot(
      `program @ 0x0810 {
  let r: u8 = 3;
  poke(screen(r + 1, r + 2), 5);
  loop {}
}`,
      3,
    );
    expect(c.peek(0x0400 + 4 * 40 + 5)).toBe(5);
  });

  it('fills the screen with nested loops', () => {
    const c = boot(
      `program @ 0x0810 {
  for (let r: u8 = 0; r < 25; r++) {
    for (let c: u8 = 0; c < 40; c++) { poke(screen(r, c), 0x41); }
  }
  loop {}
}`,
      12,
    );
    for (const cell of [0, 39, 40, 500, 999]) expect(c.peek(0x0400 + cell)).toBe(0x41);
    expect(c.peek(0x0400 + 1000)).not.toBe(0x41);
  });

  it('constant arguments still fold, with their range checks', () => {
    expectError(
      'program @ 0x0810 { poke(screen(25, 0), 1); loop {} }',
      'type',
      /screen\(\): row 25 is out of range 0\.\.24/,
      1,
    );
  });

  it('a 16-bit row is rejected', () => {
    expectError(
      'program @ 0x0810 { let r: u16 = 3; poke(screen(r, 0), 1); loop {} }',
      'codegen',
      /screen\(\): the row and the column must be 8-bit values/,
      1,
    );
  });
});
