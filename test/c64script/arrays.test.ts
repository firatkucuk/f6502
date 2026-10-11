import { describe, expect, it } from 'vitest';
import { boot, expectError } from './helpers';

describe('array indexing', () => {
  it('reads a data table by index', () => {
    const c = boot(
      `data @addr(0x0C00) { t: [u8; 4] = [10, 20, 30, 40]; }
program @ 0x0810 {
  let i: u8 = 2;
  poke(0x0900, t[i]);
  poke(0x0901, t[0]);
  poke(0x0902, t[3]);
  loop {}
}`,
      3,
    );
    expect([c.peek(0x0900), c.peek(0x0901), c.peek(0x0902)]).toEqual([30, 10, 40]);
  });

  it('writes elements of an @addr array', () => {
    const c = boot(
      `let @addr(0x0C00) buf: [u8; 8];
program @ 0x0810 {
  for (let i: u8 = 0; i < 8; i++) { buf[i] = i + 100; }
  loop {}
}`,
      4,
    );
    expect(Array.from({ length: 8 }, (_, i) => c.peek(0x0c00 + i))).toEqual([
      100, 101, 102, 103, 104, 105, 106, 107,
    ]);
  });

  it('indexes with a u16 across a page boundary', () => {
    const c = boot(
      `let @addr(0x0CF0) big: [u8; 300];
program @ 0x0810 {
  let i: u16 = 0;
  while (i < 300) { big[i] = 7; i += 1; }
  loop {}
}`,
      30,
    );
    expect(c.peek(0x0cf0)).toBe(7);
    expect(c.peek(0x0cf0 + 299)).toBe(7);
    expect(c.peek(0x0cf0 + 300)).not.toBe(7);
    expect(c.peek(0x0cef)).not.toBe(7);
  });

  it('a[i] += 1 and a[i]++', () => {
    const c = boot(
      `let @addr(0x0C00) a: [u8; 4];
program @ 0x0810 {
  let i: u8 = 1;
  a[i] = 5;
  a[i] += 3;
  a[i]++;
  loop {}
}`,
      3,
    );
    expect(c.peek(0x0c01)).toBe(9);
  });

  it('an index that is itself an indexed read', () => {
    const c = boot(
      `data @addr(0x0C00) { order: [u8; 3] = [2, 0, 1]; }
data @addr(0x0C10) { vals: [u8; 3] = [11, 22, 33]; }
program @ 0x0810 {
  let k: u8 = 0;
  poke(0x0900, vals[order[k]]);
  loop {}
}`,
      3,
    );
    expect(c.peek(0x0900)).toBe(33);
  });

  it('the value of a store may use the accumulator (indexed read as the value)', () => {
    const c = boot(
      `data @addr(0x0C00) { src: [u8; 3] = [4, 5, 6]; }
let @addr(0x0C10) dst: [u8; 3];
program @ 0x0810 {
  let i: u16 = 2;
  dst[i] = src[i];
  loop {}
}`,
      3,
    );
    expect(c.peek(0x0c12)).toBe(6);
  });

  it('a zero-page array', () => {
    const c = boot(
      `let @zp z: [u8; 4];
program @ 0x0810 {
  let i: u8 = 3;
  z[i] = 9;
  poke(0x0900, z[3]);
  loop {}
}`,
      3,
    );
    expect(c.peek(0x0900)).toBe(9);
  });

  it('an array name is its address in a constant expression', () => {
    const c = boot(
      `data @addr(0x2000) { shape: [u8; 2] = [1, 2]; }
program @ 0x0810 {
  poke(SPRITE_PTRS, spritePtr(shape));
  loop {}
}`,
      3,
    );
    expect(c.peek(0x07f8)).toBe(128);
  });

  it('a second data field follows the first', () => {
    const c = boot(
      `data @addr(0x0C00) { a: [u8; 2] = [1, 2]; b: [u8; 2] = [3, 4]; }
program @ 0x0810 {
  poke(0x0900, b[0]);
  loop {}
}`,
      3,
    );
    expect(c.peek(0x0900)).toBe(3);
  });
});

describe('array errors', () => {
  it('a constant index past the end', () => {
    expectError(
      'data @addr(0x0C00) { t: [u8; 4] = [1,2,3,4]; }\nprogram @ 0x0810 {\n poke(0x0900, t[4]);\n loop {}\n}',
      'type',
      /index 4 is out of range for 't' \(length 4\)/,
      3,
    );
  });

  it('indexing something that is not an array', () => {
    expectError(
      'program @ 0x0810 {\n let x: u8 = 1;\n poke(0x0900, x[0]);\n loop {}\n}',
      'type',
      /'x' is not an array/,
      3,
    );
  });

  it('an array of u16', () => {
    expectError(
      'let @addr(0x0C00) w: [u16; 4];\nprogram @ 0x0810 {\n loop {}\n}',
      'type',
      /arrays of u16 are not supported yet/,
      1,
    );
  });

  it('a data field that clashes with a global', () => {
    expectError(
      'let t: u8;\ndata @addr(0x0C00) { t: [u8; 2] = [1, 2]; }\nprogram @ 0x0810 {\n loop {}\n}',
      'type',
      /'t' already defined/,
      2,
    );
  });
});

describe('stores whose index or address calls a function', () => {
  it('a[f()] = value keeps the value while f runs (and f may use poke itself)', () => {
    const c = boot(
      `let @addr(0x0C00) a: [u8; 4];
fn pick(): u8 {
  poke(0x0900, 1);
  let w: u16 = 0x0901;
  poke(w, 2);
  return 3;
}
program @ 0x0810 {
  a[pick()] = 42;
  loop {}
}`,
      3,
    );
    expect(c.peek(0x0c03)).toBe(42);
    expect(c.peek(0x0900)).toBe(1);
  });
});
