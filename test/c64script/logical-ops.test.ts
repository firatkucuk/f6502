import { describe, expect, it } from 'vitest';
import { compile } from '../../src/c64script/index';
import { background, boot, border, expectError } from './helpers';

// `&&`, `||` and `!` in conditions: each operand is a condition of its own (a comparison,
// a value tested for zero, or another logical expression) and the right operand only runs
// when the left one has not decided the result.

const P = (body: string, pre = ''): string => `${pre}\nprogram @ 0x0810 {\n${body}\n  loop {}\n}`;

/** Runs `if (cond) { border = 5 } else { border = 6 }` with u8 globals a, b, c. */
function test(cond: string, a: number, b: number, c = 0): number {
  const m = boot(
    P(
      `if (${cond}) { VIC2.borderColor = 5; } else { VIC2.borderColor = 6; }`,
      `let a: u8 = ${a};\nlet b: u8 = ${b};\nlet c: u8 = ${c};`,
    ),
  );
  return border(m);
}

describe('&& and || in conditions', () => {
  it('&& of two comparisons', () => {
    expect(test('a == 1 && b == 2', 1, 2)).toBe(5);
    expect(test('a == 1 && b == 2', 1, 3)).toBe(6);
    expect(test('a == 1 && b == 2', 0, 2)).toBe(6);
    expect(test('a == 1 && b == 2', 0, 0)).toBe(6);
  });

  it('|| of two comparisons', () => {
    expect(test('a == 1 || b == 2', 1, 2)).toBe(5);
    expect(test('a == 1 || b == 2', 1, 3)).toBe(5);
    expect(test('a == 1 || b == 2', 0, 2)).toBe(5);
    expect(test('a == 1 || b == 2', 0, 0)).toBe(6);
  });

  it('every comparison operator on both sides of &&', () => {
    const ops = ['==', '!=', '<', '>', '<=', '>='] as const;
    const truth = (x: number, op: (typeof ops)[number], y: number): boolean =>
      ({ '==': x === y, '!=': x !== y, '<': x < y, '>': x > y, '<=': x <= y, '>=': x >= y })[op];
    for (const l of ops) {
      for (const r of ops) {
        for (const [a, b] of [
          [4, 6],
          [5, 5],
          [6, 4],
        ] as const) {
          const want = truth(a, l, 5) && truth(b, r, 5) ? 5 : 6;
          expect(test(`a ${l} 5 && b ${r} 5`, a, b), `a=${a} ${l} 5 && b=${b} ${r} 5`).toBe(want);
        }
      }
    }
  });

  it('three operands, and && binds tighter than ||', () => {
    expect(test('a == 1 && b == 2 && c == 3', 1, 2, 3)).toBe(5);
    expect(test('a == 1 && b == 2 && c == 3', 1, 2, 4)).toBe(6);
    expect(test('a == 1 && b == 2 && c == 3', 1, 0, 3)).toBe(6);
    // a || (b && c)
    expect(test('a == 1 || b == 2 && c == 3', 0, 2, 3)).toBe(5);
    expect(test('a == 1 || b == 2 && c == 3', 0, 2, 0)).toBe(6);
    expect(test('a == 1 || b == 2 && c == 3', 1, 0, 0)).toBe(5);
    // (a || b) && c
    expect(test('(a == 1 || b == 2) && c == 3', 1, 0, 0)).toBe(6);
    expect(test('(a == 1 || b == 2) && c == 3', 0, 2, 3)).toBe(5);
  });

  it('values are tested for non-zero, as in a plain condition', () => {
    expect(test('a && b', 1, 2)).toBe(5);
    expect(test('a && b', 7, 0)).toBe(6);
    expect(test('a || b', 0, 0)).toBe(6);
    expect(test('a || b', 0, 9)).toBe(5);
    expect(test('(a & 1) && b == 2', 3, 2)).toBe(5);
    expect(test('(a & 1) && b == 2', 2, 2)).toBe(6);
  });

  it('! negates a comparison or a logical expression', () => {
    expect(test('!(a == 1)', 1, 0)).toBe(6);
    expect(test('!(a == 1)', 2, 0)).toBe(5);
    expect(test('!(a == 1 && b == 2)', 1, 2)).toBe(6);
    expect(test('!(a == 1 && b == 2)', 1, 3)).toBe(5);
    expect(test('!a || b == 2', 0, 0)).toBe(5);
    expect(test('!a || b == 2', 1, 0)).toBe(6);
    expect(test('!!a', 3, 0)).toBe(5);
    expect(test('!!a', 0, 0)).toBe(6);
  });

  it('16-bit comparisons and 16-bit values as operands', () => {
    const run = (w: number, n: number) =>
      boot(
        P(
          `if (w > 999 && n < 10) { VIC2.borderColor = 5; }
           if (w == 0 || n == 3) { VIC2.bgColor0 = 7; }`,
          `let w: u16 = ${w};\nlet n: u8 = ${n};`,
        ),
      );
    expect(border(run(1000, 3))).toBe(5);
    expect(border(run(999, 3))).toBe(0);
    expect(border(run(1000, 10))).toBe(0);
    expect(background(run(1000, 3))).toBe(7);
    expect(background(run(0, 9))).toBe(7);
    expect(background(run(5, 9))).toBe(0);
    const v = boot(
      P('if (w && n == 1) { VIC2.borderColor = 5; }', 'let w: u16 = 256;\nlet n: u8 = 1;'),
    );
    expect(border(v)).toBe(5);
  });

  it('short-circuits: the right operand is not evaluated when the left one decides', () => {
    const src = (a: number, op: string) =>
      P(
        `if (a == 1 ${op} touched() == 1) { VIC2.borderColor = 5; }`,
        `let a: u8 = ${a};\nfn touched(): u8 { poke(0x0900, 1); return 1; }`,
      );
    const andSkipped = boot(src(0, '&&'));
    expect(andSkipped.peek(0x0900)).toBe(0); // touched() never ran
    expect(border(andSkipped)).toBe(0);
    const andRan = boot(src(1, '&&'));
    expect(andRan.peek(0x0900)).toBe(1);
    expect(border(andRan)).toBe(5);
    const orSkipped = boot(src(1, '||'));
    expect(orSkipped.peek(0x0900)).toBe(0);
    expect(border(orSkipped)).toBe(5);
    const orRan = boot(src(0, '||'));
    expect(orRan.peek(0x0900)).toBe(1);
    expect(border(orRan)).toBe(5);
  });

  it('works in while and for conditions', () => {
    const c = boot(
      P(
        `while (n < 10 && stop == 0) { n++; if (n == 4) { stop = 1; } }
         VIC2.borderColor = n;
         let k: u8 = 0;
         for (let i: u8 = 0; i < 20 || k == 0; i++) { k++; }
         VIC2.bgColor0 = k;`,
        'let n: u8 = 0;\nlet stop: u8 = 0;',
      ),
    );
    expect(border(c)).toBe(4);
    expect(background(c)).toBe(20 & 15);
  });

  it('works in else-if conditions and with bodies larger than a branch can reach', () => {
    const big = Array.from({ length: 60 }, (_, i) => `poke(${0x0500 + i}, 1);`).join(' ');
    const run = (s: number) =>
      boot(
        P(
          `if (s == 0 && t == 1) { ${big} VIC2.borderColor = 1; }
           else if (s == 1 || t == 9) { ${big} VIC2.borderColor = 2; }
           else { VIC2.borderColor = 3; }`,
          `let s: u8 = ${s};\nlet t: u8 = 1;`,
        ),
      );
    expect(border(run(0))).toBe(1);
    expect(border(run(1))).toBe(2);
    expect(border(run(2))).toBe(3);
    expect(run(0).peek(0x0500 + 59)).toBe(1);
  });

  it('a flattened condition is not larger than the nested ifs it replaces', () => {
    const pre = 'let a: u8 = 1;\nlet b: u8 = 2;\nlet c: u8 = 3;';
    const nested = compile(
      P('if (a == 1) { if (b == 2) { if (c == 3) { VIC2.borderColor = 5; } } }', pre),
    );
    const flat = compile(P('if (a == 1 && b == 2 && c == 3) { VIC2.borderColor = 5; }', pre));
    expect(flat.length).toBeLessThan(nested.length);
  });
});

describe('&& and || are conditions, not values', () => {
  it('rejects && as a value with a message that points at conditions', () => {
    expectError(
      P('let hit: u8 = a && b;', 'let a: u8 = 1;\nlet b: u8 = 2;'),
      'codegen',
      /'&&' can only be used as a condition \(if \/ while \/ for\)/,
      4,
    );
  });

  it('rejects || in a return value', () => {
    expectError(
      P('VIC2.borderColor = f();', 'let a: u8 = 1;\nfn f(): u8 { return a == 1 || a == 2; }'),
      'codegen',
      /'\|\|' can only be used as a condition/,
    );
  });
});
