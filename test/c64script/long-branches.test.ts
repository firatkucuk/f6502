import { describe, expect, it } from 'vitest';
import { background, border, boot } from './helpers';

// 6502 conditional branches only reach ±127 bytes. A block bigger than that (a slide with a
// few puts() calls is ~200 bytes) must still compile: the code generator jumps over a JMP.
const big = (base: number, n = 60): string =>
  Array.from({ length: n }, (_, i) => `poke(${base + i}, 1);`).join(' '); // 5 bytes each

describe('blocks larger than a branch can reach', () => {
  it('an if body taken', () => {
    const c = boot(`
      let @zp x: u8 = 1;
      program @ 0x0810 {
        if (x == 1) { ${big(0x0500)} VIC2.borderColor = COLOR_GREEN; }
        VIC2.bgColor0 = COLOR_RED;
        loop {}
      }`);
    expect(border(c)).toBe(5);
    expect(background(c)).toBe(2);
    expect(c.peek(0x0500)).toBe(1);
    expect(c.peek(0x0500 + 59)).toBe(1);
  });

  it('an if body skipped', () => {
    const c = boot(`
      let @zp x: u8 = 2;
      program @ 0x0810 {
        if (x == 1) { ${big(0x0500)} VIC2.borderColor = COLOR_GREEN; }
        VIC2.bgColor0 = COLOR_RED;
        loop {}
      }`);
    expect(border(c)).toBe(0);
    expect(background(c)).toBe(2);
    expect(c.peek(0x0500)).not.toBe(1);
  });

  it('every operator, taken and skipped', () => {
    for (const [op, taken, skipped] of [
      ['==', 5, 6],
      ['!=', 6, 5],
      ['<', 4, 5],
      ['>', 6, 5],
      ['<=', 5, 6],
      ['>=', 5, 4],
    ] as const) {
      for (const [x, expectBody] of [
        [taken, true],
        [skipped, false],
      ] as const) {
        const c = boot(`
          let @zp x: u8 = ${x};
          program @ 0x0810 {
            if (x ${op} 5) { ${big(0x0600)} VIC2.borderColor = COLOR_GREEN; }
            loop {}
          }`);
        expect(border(c), `x=${x} ${op} 5`).toBe(expectBody ? 5 : 0);
      }
    }
  });

  it('a long else-if chain picks the right branch', () => {
    const arm = (n: number) => `VIC2.borderColor = ${n}; ${big(0x0500 + n * 64, 40)}`;
    for (const s of [0, 1, 2, 3]) {
      const c = boot(`
        let @zp s: u8 = ${s};
        program @ 0x0810 {
          if (s == 0) { ${arm(1)} }
          else if (s == 1) { ${arm(2)} }
          else if (s == 2) { ${arm(3)} }
          else { ${arm(4)} }
          loop {}
        }`);
      expect(border(c)).toBe(s + 1);
    }
  });

  it('a while loop with a big body, and a for loop', () => {
    const c = boot(`
      let @zp n: u8 = 0;
      program @ 0x0810 {
        while (n < 3) { ${big(0x0700, 40)} n++; }
        VIC2.borderColor = n;
        for (let i: u8 = 0; i < 4; i++) { ${big(0x0700, 40)} VIC2.bgColor0 = i; }
        loop {}
      }`);
    expect(border(c)).toBe(3);
    expect(background(c)).toBe(3);
  });

  it('a non-comparison condition (value tested for zero)', () => {
    const run = (x: number) =>
      boot(`
        let @zp x: u8 = ${x};
        program @ 0x0810 {
          if (x & 1) { ${big(0x0500)} VIC2.borderColor = COLOR_GREEN; }
          loop {}
        }`);
    expect(border(run(3))).toBe(5);
    expect(border(run(2))).toBe(0);
  });
});
