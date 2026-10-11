# C64Script without inline assembly Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 16-bit arithmetic, runtime-address `peek`/`poke`/`screen`/`color`, and array indexing to C64Script, then rewrite the `character-art`, `sprite-dance` and `flappy-bird` showcases without `asm {}`.

**Architecture:** 16-bit expressions are evaluated into a reserved zero-page pair `$F8/$F9` (outside the allocator's `$02–$F7`), through a new `gen16()` that sits next to the unchanged 8-bit `genExpr()`; `isU16()` picks the path. A computed address is used as the pointer for `(zp),Y` accesses. Array elements use `abs,X` (u8 index) or the pointer (u16 index). The checker registers `data` fields as array globals.

**Tech Stack:** TypeScript, vitest, the existing `src/c64script/` pipeline, the emulator core for behavioural tests.

**Spec:** `docs/superpowers/specs/2026-10-11-c64script-without-asm-design.md`

## Global Constraints

- Every existing program must compile to the same bytes (Task 1 locks this with hashes).
- Reserved zero page for the compiler: `$F8/$F9` accumulator, `$FA/$FB` second temporary pair, `$FC` byte temporary. User variables stay in `$02–$F7`.
- The right-hand operand of `+ - & | ^` and comparisons stays "literal, variable, constant or register" (existing hint text unchanged).
- Errors are `CodeGenError`/`TypeError` with the source line, lower-case, no trailing period.
- No run-time bounds checks. Constant indices are range-checked at compile time.
- `[u16; N]` arrays, `*`, `/`, `%`, `<<`, `>>`, `&&`, `||` at run time are out of scope.
- Commit trailer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

- A 16-bit add that carries across the byte boundary (`0x00FF + 1`), and a subtract that borrows (`0x0100 - 1`, `0 - 1` wraps to `0xFFFF`).
- Comparisons that differ only in the high byte (`0x0100 > 0x00FF`) and only in the low byte (`0x0101 > 0x0100`).
- A `u16` loop counter that runs past 255 (1000 iterations) and ends exactly at the limit.
- A runtime `poke(addr, value)` where evaluating `value` itself uses the zero-page accumulator (an indexed read) — `value` must be saved before the address is computed.
- `screen(r, c)` at the four corners (0,0), (0,39), (24,0), (24,39) with variable arguments equals the constant form.
- Indexing across a page boundary: a 300-element array at an address that straddles `$xxFF`.
- A statement `a[i] += 1` evaluates the index twice; it must still be correct for a plain variable index.
- Names: a `data` field called like an existing global is a duplicate-definition error, not a silent shadow.

---

### Task 1: Lock current output with byte hashes

**Files:**
- Create: `test/c64script/fixtures/program-hashes.json`
- Create: `test/c64script/regression-bytes.test.ts`
- Create: `scripts/hash-programs.mjs` (helper that prints the JSON; not shipped)

**Interfaces:**
- Produces: a test that fails when the compiled bytes of any playground example or showcase change.

- [ ] **Step 1: Write the test and the helper**

`test/c64script/regression-bytes.test.ts`:

```ts
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compile } from '../../src/c64script/index';
import { EXAMPLES } from '../../website/js/playground-examples.js';

const hashes = JSON.parse(
  readFileSync('test/c64script/fixtures/program-hashes.json', 'utf8'),
) as Record<string, string>;
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Shipped programs whose source is rewritten on purpose (their entry is removed with the rewrite). */
describe('compiled bytes of shipped programs are stable', () => {
  for (const e of EXAMPLES) {
    const key = `example:${e.id}`;
    if (hashes[key] === undefined) continue;
    it(key, () => expect(sha(compile(e.source))).toBe(hashes[key]));
  }
  for (const f of readdirSync('website/showcases').filter((n) => n.endsWith('.c64s'))) {
    const key = `showcase:${f}`;
    if (hashes[key] === undefined) continue;
    it(key, () =>
      expect(sha(compile(readFileSync(`website/showcases/${f}`, 'utf8')))).toBe(hashes[key]),
    );
  }
  it('has an entry for every example and showcase present today', () => {
    expect(Object.keys(hashes).length).toBeGreaterThanOrEqual(10);
  });
});
```

`scripts/hash-programs.mjs`:

```js
// Prints the hash table used by test/c64script/regression-bytes.test.ts.
// Run through vitest's loader: npx tsx scripts/hash-programs.mjs > test/c64script/fixtures/program-hashes.json
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { compile } from '../src/c64script/index.ts';
import { EXAMPLES } from '../website/js/playground-examples.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const out = {};
for (const e of EXAMPLES) out[`example:${e.id}`] = sha(compile(e.source));
for (const f of readdirSync('website/showcases').filter((n) => n.endsWith('.c64s'))) {
  out[`showcase:${f}`] = sha(compile(readFileSync(`website/showcases/${f}`, 'utf8')));
}
console.log(JSON.stringify(out, null, 2));
```

- [ ] **Step 2: Generate the fixture from the current compiler**

Run: `mkdir -p test/c64script/fixtures && npx tsx scripts/hash-programs.mjs > test/c64script/fixtures/program-hashes.json && cat test/c64script/fixtures/program-hashes.json | head -20`
Expected: JSON with `example:slideshow`, `example:rainbow`, … and `showcase:flappy-bird.c64s`, … keys, each a 64-hex-digit hash.

- [ ] **Step 3: Run the test**

Run: `npx vitest run test/c64script/regression-bytes.test.ts`
Expected: PASS (every entry matches itself).

- [ ] **Step 4: Commit**

```bash
git add test/c64script/fixtures/program-hashes.json test/c64script/regression-bytes.test.ts scripts/hash-programs.mjs
git commit -m "test(c64script): lock the compiled bytes of every shipped program"
```

---

### Task 2: 16-bit `+` and `-` (expressions, assignment, `+=`/`-=`)

**Files:**
- Modify: `src/c64script/codegen.ts` (reserved constants, `gen16`, `operand16`, `genStore16`, `genByteOf`)
- Test: `test/c64script/u16-arith.test.ts`

**Interfaces:**
- Produces (internal to codegen): `gen16(e: Expr): void` leaves the value in `$F8/$F9`; `operand16(rhs: Expr): Operand16`.

- [ ] **Step 1: Write the failing tests**

`test/c64script/u16-arith.test.ts`:

```ts
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
    const c = run(
      'let w: u16 = 0x0200;\n let n: u8 = 200;\n out = w + n;\n out2 = 0xD000 + n;',
    );
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

  it('adds a constant expression and a u16 global at an absolute address', () => {
    const c = run('out2 = out + 0x0101;', 'const BASE: u16 = 0x1000;');
    expect(word(c, 0x0902)).toBe(0x0101);
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/c64script/u16-arith.test.ts`
Expected: FAIL — `16-bit arithmetic is not supported yet`.

- [ ] **Step 3: Implement**

In `src/c64script/codegen.ts`, near the other constants add:

```ts
/** Zero page the compiler keeps for itself ($F8–$FF are outside the allocator's range). */
const ACC = 0xf8; // 16-bit accumulator: low at $F8, high at $F9; also the pointer for (zp),Y
const TMP2 = 0xfa; // second 16-bit temporary ($FA/$FB)
const TMP = 0xfc; // byte temporary
```

Inside `generate`, after `genByteOf`, add `operand16` and `gen16`:

```ts
  /** A right-hand operand of 16-bit math: loads byte 0 (low) or 1 (high) with the given opcodes. */
  interface Operand16 {
    load(byte: 0 | 1, imm: number, zp: number, abs: number): void;
  }

  function operand16(rhs: Expr): Operand16 {
    const c = evalConst(rhs);
    if (c !== null) {
      return { load: (b, imm) => emit(imm, b === 0 ? c & 0xff : (c >> 8) & 0xff) };
    }
    if (rhs.tag === 'ident') {
      const v = lookup(rhs.name);
      if (v && (v.zpAddr !== null || v.absAddr !== null)) {
        const wide = v.type.tag === 'u16';
        return {
          load: (b, imm, zp, abs) => {
            if (b === 1 && !wide) emit(imm, 0);
            else if (v.zpAddr !== null) emit(zp, v.zpAddr + b);
            else emit(abs, ((v.absAddr as number) + b) & 0xff, (((v.absAddr as number) + b) >> 8) & 0xff);
          },
        };
      }
    }
    if (rhs.tag === 'field' && rhs.obj.tag === 'ident') {
      const addr = hwAddr(rhs.obj.name, rhs.field, rhs.line);
      return {
        load: (b, imm, _zp, abs) => {
          if (b === 1) emit(imm, 0);
          else emit(abs, addr & 0xff, (addr >> 8) & 0xff);
        },
      };
    }
    throw new CodeGenError(RHS_HINT, rhs.line, 0);
  }

  /** Evaluates `e` as a 16-bit value into ACC (low) / ACC+1 (high). */
  function gen16(e: Expr): void {
    const c = evalConst(e);
    if (c !== null) {
      emit(0xa9, c & 0xff, 0x85, ACC, 0xa9, (c >> 8) & 0xff, 0x85, ACC + 1);
      return;
    }
    if (e.tag === 'ident') {
      const v = lookup(e.name);
      if (v && v.type.tag === 'u16' && !v.isConst) {
        for (const b of [0, 1] as const) {
          if (v.zpAddr !== null) emit(0xa5, v.zpAddr + b);
          else if (v.absAddr !== null) {
            const a = v.absAddr + b;
            emit(0xad, a & 0xff, (a >> 8) & 0xff);
          } else throw new CodeGenError(`cannot read '${e.name}'`, e.line, 0);
          emit(0x85, ACC + b);
        }
        return;
      }
    }
    if (e.tag === 'cast' && e.toType.tag === 'u16') {
      gen16(e.expr);
      return;
    }
    if (e.tag === 'binary' && (e.op === '+' || e.op === '-') && isU16(e)) {
      gen16(e.lhs);
      const r = operand16(e.rhs);
      emit(0xa5, ACC, e.op === '+' ? 0x18 : 0x38); // LDA lo; CLC | SEC
      r.load(0, e.op === '+' ? 0x69 : 0xe9, e.op === '+' ? 0x65 : 0xe5, e.op === '+' ? 0x6d : 0xed);
      emit(0x85, ACC, 0xa5, ACC + 1); // STA lo; LDA hi
      r.load(1, e.op === '+' ? 0x69 : 0xe9, e.op === '+' ? 0x65 : 0xe5, e.op === '+' ? 0x6d : 0xed);
      emit(0x85, ACC + 1);
      return;
    }
    if (isU16(e)) {
      throw new CodeGenError('this 16-bit expression is not supported yet', e.line, 0);
    }
    genExpr(e); // an 8-bit value: zero-extend
    emit(0x85, ACC, 0xa9, 0x00, 0x85, ACC + 1);
  }
```

Replace the throw in `genStore16` (the `if (isU16(value)) { throw ... }`) with:

```ts
    if (isU16(value)) {
      gen16(value);
      emit(0xa5, ACC);
      store(0);
      emit(0xa5, ACC + 1);
      store(1);
      return;
    }
```

Make `genByteOf` handle any 16-bit expression: before its final `throw`, add:

```ts
    if (isU16(arg)) {
      gen16(arg);
      emit(0xa5, ACC + (high ? 1 : 0));
      return;
    }
```

In `genBinary`, change the 16-bit guard so a u16 expression in an 8-bit context is still an error but with the existing assignment message path: leave `if (isU16(e.lhs) || isU16(e.rhs)) throw ... 'a 16-bit value cannot be stored...'` is produced by `assertFits8` before `genExpr` is reached, so no change is needed there.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/c64script/u16-arith.test.ts test/c64script/regression-bytes.test.ts`
Expected: PASS (11 + hashes unchanged).

- [ ] **Step 5: Full suite and commit**

Run: `npm test 2>&1 | tail -5`
Expected: all passing.

```bash
git add -A src test
git commit -m "feat(c64script): 16-bit + and -, +=, -= on u16"
```

---

### Task 3: 16-bit comparisons and `u16` loop counters

**Files:**
- Modify: `src/c64script/codegen.ts` (`genCondBranch`)
- Test: `test/c64script/u16-compare.test.ts`

**Interfaces:**
- Consumes: `gen16`, `operand16` from Task 2.

- [ ] **Step 1: Write the failing tests**

`test/c64script/u16-compare.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { boot } from './helpers';

const OPS = ['==', '!=', '<', '>', '<=', '>='] as const;
const truth = (a: number, op: (typeof OPS)[number], b: number): boolean =>
  ({ '==': a === b, '!=': a !== b, '<': a < b, '>': a > b, '<=': a <= b, '>=': a >= b })[op];

describe('u16 comparisons', () => {
  const pairs: Array<[number, number]> = [
    [0, 0], [1, 0], [0, 1], [255, 256], [256, 255], [0x0101, 0x0100], [0x0100, 0x0101],
    [0xffff, 0], [0, 0xffff], [0x1234, 0x1234],
  ];
  for (const [a, b] of pairs) {
    it(`${a} against ${b}, every operator`, () => {
      const lines = OPS.map(
        (op, i) =>
          `  if (a ${op} b) { poke(0x0900 + ${i}, 1); } else { poke(0x0900 + ${i}, 2); }`,
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/c64script/u16-compare.test.ts`
Expected: FAIL — `16-bit comparison is not supported yet`.

- [ ] **Step 3: Implement**

In `genCondBranch`, replace the `if (isU16(cond.lhs) || isU16(cond.rhs)) { throw ... }` block (the comparison branch) with a call, and the non-comparison `isU16(cond)` throw with a non-zero test:

```ts
    if (cond.tag === 'binary' && COMPARE_OPS.has(cond.op)) {
      if (isU16(cond.lhs) || isU16(cond.rhs)) {
        genCompare16(cond);
        emitCondJump(jumpOp16(cond.op), stay, !invertForFalse);
      } else {
        genExpr(cond.lhs);
        genCmpRhs(cond.rhs);
        emitCondJump(cond.op, stay, !invertForFalse);
      }
    } else if (isU16(cond)) {
      gen16(cond);
      emit(0xa5, ACC, 0x05, ACC + 1); // LDA lo; ORA hi: zero only when both are zero
      emit(invertForFalse ? 0xd0 : 0xf0);
      addFixup({ kind: 'branch8', label: stay }, 1);
    } else {
      ...existing 8-bit non-comparison code...
    }
```

Add these helpers before `genCondBranch`:

```ts
  /**
   * Compares two 16-bit values and leaves the flags for `jumpOp16(op)`:
   *   == / !=  → Z (equal)        < / >=  → C (a >= b)
   *   > / <=   → the operands are swapped, so C is clear when a > b.
   */
  function genCompare16(cond: Extract<Expr, { tag: 'binary' }>): void {
    const op = cond.op;
    if (op === '>' || op === '<=') {
      // b - a: C is clear when b < a, i.e. a > b.
      gen16(cond.lhs);
      const r = operand16(cond.rhs);
      r.load(0, 0xa9, 0xa5, 0xad); // LDA b.lo
      emit(0xc5, ACC); // CMP a.lo
      r.load(1, 0xa9, 0xa5, 0xad); // LDA b.hi
      emit(0xe5, ACC + 1); // SBC a.hi
      return;
    }
    gen16(cond.lhs);
    const r = operand16(cond.rhs);
    if (op === '==' || op === '!=') {
      const ne = freshLabel('cmp16_ne');
      emit(0xa5, ACC); // LDA a.lo
      r.load(0, 0xc9, 0xc5, 0xcd); // CMP b.lo
      emit(0xd0);
      addFixup({ kind: 'branch8', label: ne }, 1); // BNE → Z is already clear
      emit(0xa5, ACC + 1); // LDA a.hi
      r.load(1, 0xc9, 0xc5, 0xcd); // CMP b.hi: Z set when equal
      emitLabel(ne);
      return;
    }
    emit(0xa5, ACC); // LDA a.lo
    r.load(0, 0xc9, 0xc5, 0xcd); // CMP b.lo
    emit(0xa5, ACC + 1); // LDA a.hi
    r.load(1, 0xe9, 0xe5, 0xed); // SBC b.hi: C set when a >= b
  }

  /** The 8-bit condition whose branch test matches the flags left by `genCompare16`. */
  function jumpOp16(op: string): string {
    if (op === '>') return '<'; // C clear after the swapped subtraction
    if (op === '<=') return '>=';
    return op;
  }
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/c64script/u16-compare.test.ts test/c64script/regression-bytes.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite, docs row, commit**

In `website/c64script.html`, in the "Not in the language yet" table, replace the row `w = w + 1 on a u16 … use u8, or asm` with nothing (delete it), and in the "Variables and constants" section add a short paragraph and a runnable sample:

```
const TOTAL: u16 = 1000;

let @addr(0x0900) sum: u16;

program @ 0x0810 {
  for (let i: u16 = 0; i < TOTAL; i++) {
    sum += 3;                 // 16-bit add: 3000 fits in a u16
  }
  VIC2.borderColor = COLOR_GREEN;
  loop {}
}
```

Add to `test/website/docs-claims.test.ts` a test that boots the sample and expects `peek(0x0900) | peek(0x0901) << 8 === 3000` after enough frames. Update the existing docs-claims assertion that checked the removed "Not in the language yet" row for 16-bit arithmetic.

Run: `npm test 2>&1 | tail -5`
Expected: all passing.

```bash
git add -A src test website
git commit -m "feat(c64script): 16-bit comparisons and u16 loop counters"
```

---

### Task 4: Runtime `poke`, `peek`, `screen`, `color`

**Files:**
- Modify: `src/c64script/checker.ts` (`BUILTIN_FNS`: add `peek`)
- Modify: `src/c64script/codegen.ts` (`genCall`, `gen16`, `genByteOf`, `isU16`)
- Test: `test/c64script/runtime-address.test.ts`

**Interfaces:**
- Consumes: `gen16`, `operand16`.
- Produces: `genScreenAddr(call)` leaving `0x0400|0xD800 + row*40 + col` in ACC.

- [ ] **Step 1: Write the failing tests**

`test/c64script/runtime-address.test.ts`:

```ts
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

  it('a constant poke still compiles to the same bytes', async () => {
    const { compile } = await import('../../src/c64script/index');
    const a = compile('program @ 0x0810 { poke(0x0C00, 1); loop {} }');
    expect(Array.from(a)).toContain(0x8d);
  });
});

describe('runtime screen() and color()', () => {
  const corners: Array<[number, number]> = [
    [0, 0], [0, 39], [24, 0], [24, 39], [12, 20], [1, 0], [7, 33],
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/c64script/runtime-address.test.ts`
Expected: FAIL (`poke() address must be a compile-time constant`, `undefined function 'peek'`, …).

- [ ] **Step 3: Implement**

`checker.ts`: add `['peek', [1, 1]]` to `BUILTIN_FNS`.

`codegen.ts`:

1. Add the screen-address generator (before `gen16`'s use; function declarations hoist):

```ts
  /** `screen(row, col)` / `color(row, col)` with run-time arguments → ACC. */
  function genScreenAddr(e: Extract<Expr, { tag: 'call' }>): void {
    const [rowE, colE] = e.args;
    if (rowE === undefined || colE === undefined) {
      throw new CodeGenError(`${e.name}() takes a row and a column`, e.line, 0);
    }
    if (isU16(rowE) || isU16(colE)) {
      throw new CodeGenError(
        `${e.name}(): the row and the column must be 8-bit values`,
        e.line,
        0,
      );
    }
    const base = e.name === 'screen' ? 0x0400 : 0xd800;
    genExpr(colE);
    emit(0x48); // PHA: the column waits on the stack while the row is scaled
    genExpr(rowE);
    emit(0x85, ACC, 0xa9, 0x00, 0x85, ACC + 1); // ACC = row
    for (let i = 0; i < 3; i++) emit(0x06, ACC, 0x26, ACC + 1); // ASL lo; ROL hi: row * 8
    emit(0xa5, ACC, 0x85, TMP2, 0xa5, ACC + 1, 0x85, TMP2 + 1); // TMP2 = row * 8
    for (let i = 0; i < 2; i++) emit(0x06, ACC, 0x26, ACC + 1); // row * 32
    emit(0x18, 0xa5, ACC, 0x65, TMP2, 0x85, ACC); // CLC; ACC.lo += TMP2.lo
    emit(0xa5, ACC + 1, 0x65, TMP2 + 1, 0x85, ACC + 1); // ACC.hi += TMP2.hi (+ carry)
    emit(0x68, 0x85, TMP); // PLA; STA TMP: the column
    emit(0x18, 0xa5, ACC, 0x65, TMP, 0x85, ACC); // ACC.lo += column
    emit(0xa5, ACC + 1, 0x69, 0x00, 0x85, ACC + 1); // ACC.hi += carry
    emit(0x18, 0xa9, base & 0xff, 0x65, ACC, 0x85, ACC); // ACC.lo += lo(base)
    emit(0xa9, (base >> 8) & 0xff, 0x65, ACC + 1, 0x85, ACC + 1); // ACC.hi += hi(base) + carry
  }
```

2. In `gen16`, before the `isU16(e)` throw, add:

```ts
    if (e.tag === 'call' && (e.name === 'screen' || e.name === 'color')) {
      genScreenAddr(e);
      return;
    }
```

3. In `genCall`, replace the whole `poke` constant-address check with a two-way path: keep the constant path; for a non-constant address:

```ts
      if (addrVal === null) {
        assertFits8(valueExpr, e.line, 'a byte');
        const byteVal = evalConst(valueExpr);
        if (byteVal !== null) emit(0xa9, byteVal & 0xff);
        else genExpr(valueExpr);
        emit(0x85, TMP); // the value waits: computing the address uses A and the accumulator
        gen16(addrExpr);
        emit(0xa5, TMP, 0xa0, 0x00, 0x91, ACC); // LDA TMP; LDY #0; STA (ACC),Y
        return;
      }
```

(remove the old "poke() address must be a compile-time constant" throw and the `genCall(addrExpr)` special case).

4. In `genCall`, the `screen`/`color` branch: when `evalConst(e)` is null, call `genScreenAddr(e)` then `emit(0xa5, ACC)` instead of throwing (the low byte, matching the existing 8-bit view of an address).

5. Add `peek` to `genCall` before the user-function path:

```ts
    if (e.name === 'peek') {
      const a = e.args[0];
      if (a === undefined) throw new CodeGenError('peek() takes an address', e.line, 0);
      const c = evalConst(a);
      if (c !== null) {
        emit(0xad, c & 0xff, (c >> 8) & 0xff); // LDA abs
        return;
      }
      gen16(a);
      emit(0xa0, 0x00, 0xb1, ACC); // LDY #0; LDA (ACC),Y
      return;
    }
```

6. `isU16`: `screen`/`color` stays `true`; `peek` is not (falls to the `fns.get` path, `undefined`, `false`).

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/c64script/runtime-address.test.ts test/c64script/regression-bytes.test.ts`
Expected: PASS. If the 25×40 fill test is short on frames, raise the boot frame count (each iteration is roughly 100 cycles).

- [ ] **Step 5: Docs, full suite, commit**

In `website/c64script.html`: built-ins table — change the `screen(row, col)` row to say row/col may be variables (`u8`), add a `peek(addr)` row, and change the `poke` text to "any address expression". Update the sentence in the text-screen section that says "A computed address is a compile error". Add a runnable sample ("Computed addresses"):

```
program @ 0x0810 {
  for (let r: u8 = 0; r < 25; r++) {
    poke(screen(r, r), 0xA0);        // a diagonal of solid blocks
    poke(color(r, r), COLOR_YELLOW);
  }
  loop {}
}
```

Add `test/website/docs-claims.test.ts` assertions that the diagonal's cells are `0xA0`.

Run: `npm test 2>&1 | tail -5`, then:

```bash
git add -A src test website
git commit -m "feat(c64script): run-time addresses in poke, screen and color; peek"
```

---

### Task 5: Array indexing

**Files:**
- Modify: `src/c64script/checker.ts` (register `data` fields; `index` checks; foldConst of array names)
- Modify: `src/c64script/codegen.ts` (`genExpr` index read, `genStore` index write, `genIncDec`, `isU16`)
- Test: `test/c64script/arrays.test.ts`

**Interfaces:**
- Consumes: `gen16`, `TMP`, `ACC`.
- Produces: array globals from `data` fields (`name` → `ResolvedVar` with `type: array`, `absAddr` = block address + running offset); an array name in a constant expression folds to its address.

- [ ] **Step 1: Write the failing tests**

`test/c64script/arrays.test.ts`:

```ts
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

  it('a data field is registered after the data block address', () => {
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/c64script/arrays.test.ts`
Expected: FAIL (`array indexing is not supported yet`, `undefined variable 't'`).

- [ ] **Step 3: Implement the checker side**

In `checker.ts`, after the loop that fills `dataAddrs` (the data-block address folding), register each field:

```ts
  for (const d of allDecls) {
    if (d.tag !== 'data') continue;
    let offset = 0;
    for (const f of d.fields) {
      if (f.type.tag === 'array' && f.type.elem.tag === 'u16') {
        throw new TypeError('arrays of u16 are not supported yet', d.line, 0);
      }
      if (vars.has(f.name) || fns.has(f.name) || BUILTIN_FNS.has(f.name)) {
        throw new TypeError(`'${f.name}' already defined`, d.line, 0);
      }
      vars.set(f.name, {
        type: f.type,
        zpAddr: null,
        absAddr: (dataAddrs.get(d) as number) + offset,
        isConst: false,
        constValue: null,
        initValue: null,
        isGlobal: true,
      });
      offset += sizeOf(f.type, structs);
    }
  }
```

(Use the exact `ResolvedVar` field names present in the file; the block above lists the ones to set.) Reject `[u16; N]` in `declare()` too for `let` arrays with the same message.

`foldConst` `ident` case: after the existing constant handling,

```ts
      if (v !== undefined && v.type.tag === 'array') {
        return v.absAddr ?? v.zpAddr; // an array name is its address
      }
```

`checkExpr` `index` case: resolve `e.obj` (must be an `ident` whose variable's type is `array`), else `'<name>' is not an array`; if the index folds to a constant `k >= size`, throw `index ${k} is out of range for '${name}' (length ${size})`.

- [ ] **Step 4: Implement the codegen side**

```ts
  /** The array variable an index expression refers to, with its address and kind. */
  function arrayOf(e: Extract<Expr, { tag: 'index' }>): { base: number; zp: boolean } {
    if (e.obj.tag !== 'ident') throw new CodeGenError('only named arrays can be indexed', e.line, 0);
    const v = lookup(e.obj.name);
    if (!v || v.type.tag !== 'array') {
      throw new CodeGenError(`'${e.obj.name}' is not an array`, e.line, 0);
    }
    if (v.zpAddr !== null) return { base: v.zpAddr, zp: true };
    if (v.absAddr !== null) return { base: v.absAddr, zp: false };
    throw new CodeGenError(`cannot index '${e.obj.name}'`, e.line, 0);
  }

  /** Leaves the element address in ACC (16-bit index path and constant indexes). */
  function genElementAddr(e: Extract<Expr, { tag: 'index' }>, base: number): void {
    gen16(e.idx);
    emit(0x18, 0xa5, ACC, 0x69, base & 0xff, 0x85, ACC); // CLC; ACC.lo += lo(base)
    emit(0xa5, ACC + 1, 0x69, (base >> 8) & 0xff, 0x85, ACC + 1);
  }

  function genIndexRead(e: Extract<Expr, { tag: 'index' }>): void {
    const { base, zp } = arrayOf(e);
    const k = evalConst(e.idx);
    if (k !== null) {
      const a = base + k;
      if (zp) emit(0xa5, a & 0xff);
      else emit(0xad, a & 0xff, (a >> 8) & 0xff);
      return;
    }
    if (!isU16(e.idx)) {
      genExpr(e.idx);
      emit(0xaa); // TAX
      if (zp) emit(0xb5, base & 0xff); // LDA zp,X
      else emit(0xbd, base & 0xff, (base >> 8) & 0xff); // LDA abs,X
      return;
    }
    genElementAddr(e, zp ? base : base);
    emit(0xa0, 0x00, 0xb1, ACC); // LDY #0; LDA (ACC),Y
  }

  /** Stores A (the value is already in TMP) to the element. */
  function genIndexWrite(e: Extract<Expr, { tag: 'index' }>): void {
    const { base, zp } = arrayOf(e);
    const k = evalConst(e.idx);
    if (k !== null) {
      const a = base + k;
      emit(0xa5, TMP);
      if (zp) emit(0x85, a & 0xff);
      else emit(0x8d, a & 0xff, (a >> 8) & 0xff);
      return;
    }
    if (!isU16(e.idx)) {
      genExpr(e.idx);
      emit(0xaa, 0xa5, TMP); // TAX; LDA TMP
      if (zp) emit(0x95, base & 0xff); // STA zp,X
      else emit(0x9d, base & 0xff, (base >> 8) & 0xff); // STA abs,X
      return;
    }
    genElementAddr(e, base);
    emit(0xa5, TMP, 0xa0, 0x00, 0x91, ACC); // LDA TMP; LDY #0; STA (ACC),Y
  }
```

Wire them in: `genExpr` `case 'index'` → `genIndexRead(e)`. In `genAssign`, before the 8-bit path, add:

```ts
    if (lhs.tag === 'index') {
      assertFits8(rhs, line, 'an array element');
      genExpr(rhs);
      emit(0x85, TMP); // the value waits while the index is computed
      genIndexWrite(lhs);
      return;
    }
```

`genIncDec` for an `index` lhs: `genAssign(lhs, { tag: 'binary', op: op === '++' ? '+' : '-', lhs, rhs: { tag: 'intLit', value: 1, line: lhs.line }, line: lhs.line }, lhs.line)`. `genStore`'s `index` branch stays unreachable for assignment (kept as the error for other callers). `isU16` for `index` returns `false` (elements are `u8`).

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run test/c64script/arrays.test.ts test/c64script/regression-bytes.test.ts`
Expected: PASS.

- [ ] **Step 6: Docs, full suite, commit**

In `website/c64script.html`: delete the `buf[i], pointers, structs` row of "Not in the language yet" and replace it with a row `pointers, structs, [u16; N]` with the compiler message of the `u16` array error and "use a u8 array and two bytes" as the alternative. Add an "Arrays and tables" section with a sample:

```
data @addr(0x0C00) {
  squares: [u8; 8] = [0, 1, 4, 9, 16, 25, 36, 49];
}

let @addr(0x0C10) copy: [u8; 8];

program @ 0x0810 {
  for (let i: u8 = 0; i < 8; i++) {
    copy[i] = squares[i] + 1;
  }
  VIC2.borderColor = copy[3] & 15;     // 10
  loop {}
}
```

Add a docs-claims test that boots the sample and checks `peek(0x0C13) === 10`.

Run: `npm test 2>&1 | tail -5`

```bash
git add -A src test website
git commit -m "feat(c64script): array indexing for @addr arrays and data tables"
```

---

### Task 6: Rewrite the showcases without assembly

**Files:**
- Modify: `website/showcases/character-art.c64s`, `sprite-dance.c64s`, `flappy-bird.c64s`
- Modify: `test/c64script/fixtures/program-hashes.json` (remove the three `showcase:` entries)
- Modify: `test/website/showcase-sources.test.ts` (new "no inline assembly" test), `AGENTS.md`, the showcase blurbs in `website/js/showcase-list.js` and card text in `website/showcases.html`

- [ ] **Step 1: Write the failing test**

Append to `test/website/showcase-sources.test.ts`:

```ts
describe('showcases are written in plain C64Script', () => {
  for (const id of ['character-art', 'sprite-dance', 'flappy-bird', 'rainbow-border']) {
    it(`${id} has no inline assembly`, () => {
      expect(source(id)).not.toMatch(/\basm\b\s*(clobbers\s*\([^)]*\)\s*)?\{/);
    });
  }
});
```

Run: `npx vitest run test/website/showcase-sources.test.ts -t "plain C64Script"`
Expected: FAIL for the three assembly showcases.

- [ ] **Step 2: Rewrite `character-art.c64s`**

```
// Character Mode Art: a sunset painted with one solid-block character and colour RAM.
// The screen is 40 x 25 cells; every row gets one colour from the table below.
data @addr(0x0C00) {
  rows: [u8; 25] = [
    COLOR_BLUE, COLOR_BLUE, COLOR_BLUE,
    COLOR_PURPLE, COLOR_PURPLE, COLOR_PURPLE,
    COLOR_RED, COLOR_RED, COLOR_RED,
    COLOR_LIGHT_RED, COLOR_LIGHT_RED,
    COLOR_ORANGE, COLOR_ORANGE,
    COLOR_YELLOW, COLOR_YELLOW,
    // the sea mirrors the sky, darker
    COLOR_ORANGE, COLOR_ORANGE,
    COLOR_RED, COLOR_RED,
    COLOR_PURPLE, COLOR_PURPLE,
    COLOR_BLUE, COLOR_BLUE,
    COLOR_DARK_GREY, COLOR_BLACK,
  ];
}

program @ 0x0810 {
  VIC2.borderColor = COLOR_BLACK;
  VIC2.bgColor0 = COLOR_BLACK;

  for (let r: u8 = 0; r < 25; r++) {
    let shade: u8 = rows[r];
    for (let c: u8 = 0; c < 40; c++) {
      poke(screen(r, c), 0xA0);      // a solid block in every cell
      poke(color(r, c), shade);      // coloured by its row
    }
  }

  puts(1, 14, "C64SCRIPT", COLOR_WHITE);
  loop {}
}
```

- [ ] **Step 3: Rewrite the `sprite-dance.c64s` loop**

Keep the header, the `data` blocks and the sprite setup. Replace the three zero-page temporaries and the loop with:

```
let @zp phase: u8 = 0;   // where the leader is on the path
let @zp reg: u8 = 0;     // 2 * n: offset of sprite n's x register ($D000 + 2n; y is +1)
let @zp pos: u8 = 0;     // this sprite's place on the path

program @ 0x0810 {
  ...unchanged setup...

  loop {
    // wait for one video frame
    while (VIC2.rasterLine != 200) {}
    while (VIC2.rasterLine == 200) {}

    phase = (phase + 1) & 127;

    reg = 0;
    pos = phase;
    for (let n: u8 = 0; n < 8; n++) {
      poke(0xD000 + reg, wave[pos]);       // x follows the sine
      let y: u8 = pos + pos;               // twice as fast ...
      y = y + 32;                          // ... and a quarter turn ahead: a figure of eight
      y = y & 127;
      poke(0xD001 + reg, wave[y]);
      reg = reg + 2;
      pos = (pos + 16) & 127;              // the next sprite is 16 steps further along
    }
  }
}
```

Remove the `SINE` constant's use in assembly: keep `const SINE: u16 = 0x0E00;` for `data @addr(SINE)`. Update the header comment ("indexing a table needs assembly" → "wave[i] reads the table").

- [ ] **Step 4: Rewrite `flappy-bird.c64s`**

Remove `let @zp cell: u16;`. Replace `column()` with:

```
// Writes `ch` down screen column `col`, rows 1..21 (row 0 is the score), leaving an 8-row hole
// that starts at `gap`.
fn column(col: u8, gap: u8, ch: u8): void {
  let hole: u8 = gap + 8;
  for (let row: u8 = 1; row < 22; row++) {
    if (row < gap) {
      poke(screen(row, col), ch);
    } else if (row >= hole) {
      poke(screen(row, col), ch);
    }
  }
}
```

Replace the `asm {…}` block in the new-game section with:

```
    for (let r: u8 = 0; r < 25; r++) {       // all colour RAM green: pipes only need the character
      for (let c: u8 = 0; c < 40; c++) { poke(color(r, c), COLOR_GREEN); }
    }
    for (let r: u8 = 22; r < 25; r++) {      // the ground: rows 22..24
      for (let c: u8 = 0; c < 40; c++) {
        poke(screen(r, c), 0xA0);
        poke(color(r, c), COLOR_BROWN);
      }
    }
```

Update the header comment (drop "inline assembly").

- [ ] **Step 5: Hashes, AGENTS.md, docs text**

Remove the three entries `showcase:character-art.c64s`, `showcase:sprite-dance.c64s`, `showcase:flappy-bird.c64s` from `program-hashes.json` (they are rewritten on purpose).

`AGENTS.md`: in "1 — Write the program", replace the sentence "arrays cannot be indexed at runtime and there is no runtime multiply, so tables and loops over memory use `asm {}`" with "Tables are arrays (`data` blocks and `@addr` arrays) indexed with `t[i]`, and `poke`/`peek` take computed addresses. There is no runtime multiply; build products with additions. `asm {}` is available when you need an exact instruction sequence." Update the list of example showcases ("`character-art.c64s` (a table-driven fill)").

`website/js/showcase-list.js` blurbs and the card text in `website/showcases.html`: drop "inline assembly" from Character Mode Art and Sprite Dance ("read from a sine table") and keep Flappy Bird's wording.

- [ ] **Step 6: Run everything**

Run: `npx vitest run test/website/showcase-sources.test.ts`
Expected: PASS — the behavioural tests (title, ground, geometry, scoring autopilot, ceiling safety, retry) are unchanged and pass against the rewritten sources; the "no inline assembly" tests pass.

If the Flappy autopilot or timing tests fail because a pipe step now takes longer than a frame, measure with `run(c, n)` first; the step happens every 5th frame and `frame()` re-syncs, so only the *speed* of the pipes may change. Prefer lowering work per step (draw/erase only the two changed columns, already the case) over loosening tests.

Run: `npm test 2>&1 | tail -5; npm run typecheck; npx eslint src test`

- [ ] **Step 7: Browser check and commit**

Serve the staged site (`npm run build`, copy `website/` and `dist/f6502.min.js`), open each of the three showcases, press SPACE in Flappy Bird, confirm: character-art matches the earlier screenshot, sprite-dance moves the same figure of eight, flappy-bird plays and restarts (including the 0.1 s repaint on retry).

```bash
git add -A src test website AGENTS.md docs
git commit -m "feat(website): showcases in plain C64Script, no inline assembly"
```

---

## Final steps

- [ ] Push `feat/c64script-without-asm`, open one PR "C64Script without inline assembly" that lists the five commits per task and links the spec; one issue for the PR (user rule: every PR needs an issue).
- [ ] Final whole-branch review by a fresh reviewer on the most capable model, focused on the Review Focus list above.
