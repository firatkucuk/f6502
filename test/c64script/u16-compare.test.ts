import { describe, expect, it } from 'vitest';
import { boot } from './helpers';

const OPS = ['==', '!=', '<', '>', '<=', '>='] as const;
const truth = (a: number, op: (typeof OPS)[number], b: number): boolean =>
  ({ '==': a === b, '!=': a !== b, '<': a < b, '>': a > b, '<=': a <= b, '>=': a >= b })[op];

describe('u16 comparisons', () => {
  const pairs: Array<[number, number]> = [
    [0, 0],
    [1, 0],
    [0, 1],
    [255, 256],
    [256, 255],
    [0x0101, 0x0100],
    [0x0100, 0x0101],
    [0xffff, 0],
    [0, 0xffff],
    [0x1234, 0x1234],
  ];
  for (const [a, b] of pairs) {
    it(`${a} against ${b}, every operator`, () => {
      const lines = OPS.map(
        (op, i) => `  if (a ${op} b) { poke(0x0900 + ${i}, 1); } else { poke(0x0900 + ${i}, 2); }`,
      ).join('\n');
      const c = boot(
        `let a: u16 = ${a};\nlet b: u16 = ${b};\nprogram @ 0x0810 {\n${lines}\n  loop {}\n}`,
        3,
      );
      OPS.forEach((op, i) => {
        expect(c.peek(0x0900 + i), `${a} ${op} ${b}`).toBe(truth(a, op, b) ? 1 : 2);
      });
    });
  }

  it('compares a u16 with a constant and a u8 with a u16 constant', () => {
    const c = boot(
      `let w: u16 = 1000;\nlet n: u8 = 200;\nprogram @ 0x0810 {
  if (w > 999) { poke(0x0900, 1); }
  if (n < 1000) { poke(0x0901, 1); }
  if (w == 1000) { poke(0x0902, 1); }
  loop {}
}`,
      3,
    );
    expect([c.peek(0x0900), c.peek(0x0901), c.peek(0x0902)]).toEqual([1, 1, 1]);
  });

  it('a 16-bit value used as a condition is true when either byte is non-zero', () => {
    const c = boot(
      `let hi: u16 = 0x0100;\nlet zero: u16 = 0;\nprogram @ 0x0810 {
  if (hi) { poke(0x0900, 1); }
  if (zero) { poke(0x0901, 1); }
  loop {}
}`,
      3,
    );
    expect([c.peek(0x0900), c.peek(0x0901)]).toEqual([1, 0]);
  });
});

describe('u16 loops', () => {
  it('a for loop over a u16 runs past 255 and stops at the limit', () => {
    const c = boot(
      `let @addr(0x0900) count: u16;
program @ 0x0810 {
  for (let i: u16 = 0; i < 1000; i++) { count += 1; }
  loop {}
}`,
      40,
    );
    expect(c.peek(0x0900) | (c.peek(0x0901) << 8)).toBe(1000);
  });

  it('a while loop counting down over a u16', () => {
    const c = boot(
      `let @addr(0x0900) steps: u16;
program @ 0x0810 {
  let n: u16 = 300;
  while (n > 0) { n -= 1; steps += 1; }
  loop {}
}`,
      20,
    );
    expect(c.peek(0x0900) | (c.peek(0x0901) << 8)).toBe(300);
  });
});
