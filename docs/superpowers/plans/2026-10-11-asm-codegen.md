# `asm {}` Code Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `asm { … }` blocks in C64Script assemble to real 6502 code: official opcodes, labels, `${expr}` interpolation, `lo()`/`hi()`, `±` offsets, all with located errors.

**Architecture:** The lexer gains `$HEX` and `#`. The parser turns an asm block into structured items (labels and instructions with typed operands) using token line numbers. A new `asm.ts` derives the (mnemonic, mode) → opcode table from the CPU core's `OPS` table and picks addressing modes. The checker validates `clobbers()` and resolves `${…}` names; the code generator resolves operands and emits bytes and fixups; the linker reports branch-range errors by label and line.

**Tech Stack:** TypeScript (compiler, vitest). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-11-asm-codegen-design.md`

## Execution order

Tasks 1 → **3** → 2 → 4 → 5 → 6 → 7. Task 2's parser imports `isMnemonic` / `takesOperand` from
Task 3's `asm.ts`, so Task 3 comes first (numbering is by component, not by order).

## Global Constraints

- v1 scope only: official opcodes, labels, `${expr}`, `lo()`/`hi()`, `+`/`-` number offsets. **No** directives (`.byte`), macros, bare program names without `${}`, undocumented opcodes, struct fields.
- Encodings come from `OPS` in `src/core/opcodes.ts` (`official === true`); do not hand-write an opcode table.
- Program symbols need `${…}`; bare identifiers are labels. `a` (any case) is the accumulator. Mnemonics are case-insensitive, labels case-sensitive.
- Every error is a `C64ScriptError` subclass with a line number: `TypeError` from the checker, `CodeGenError` from codegen, `ParseError`/`LexError` from the front end.
- Prettier: single quotes, `printWidth` 100, `trailingComma: all`; run `prettier --write` on new/changed files only. Existing lint baseline: `website/js/app.js`, `website/js/demo.js` and `examples/` have pre-existing ESLint errors — add none.
- Test style: programs run on the emulator core through `boot()` / `expectError()` from `test/c64script/helpers.ts`.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; PR descriptions end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Every PR needs a GitHub issue first (project rule); confirm before pushing / opening the PR.
- Work on branch `feat/c64script-asm` (already created from `main`), never on `main`.

## Review Focus

Failure modes the spec implies that no single task's happy path covers:

1. Several instructions on one line (`asm { lda #5 sta $D020 }`) and an implied instruction followed by another on the same line (`dex bpl loop`) must parse as separate instructions, not as an operand. (Task 2)
2. An `@inline` function containing asm, called twice, must not report duplicate labels. (Task 5, Task 6)
3. Zero-page boundary values: `$FF` is zero page, `$100` is absolute; `lda $10,y` (no zero-page,Y form for LDA) assembles as absolute,Y — not an error. (Task 3, Task 6)
4. A branch farther than ±127 bytes must be a located error naming the label, never a silently wrapped offset. (Task 5, Task 6)
5. `sta ${CONST}` and `#${variable}` are errors, but `lda ${CONST}` (read from that address) and `lda #lo(${variable})` are fine. (Task 5, Task 6)
6. A function reachable only through `jsr ${f}` must still be emitted and must take part in recursion detection. (Task 4, Task 6)

## File Structure

| File | Responsibility |
|---|---|
| `src/c64script/lexer.ts` | `$HEX` literals, `#` token (Task 1) |
| `src/c64script/ast.ts` | `AsmExpr`, `AsmOperand`, `AsmItem`; asm statement carries `items` (Task 2) |
| `src/c64script/parser.ts` | `parseAsm` → structured items (Task 2) |
| `src/c64script/asm.ts` (new) | opcode table from the core, `chooseMode`, `isMnemonic`, `takesOperand` (Task 3) |
| `src/c64script/checker.ts` | validate `clobbers()`, resolve `${…}`, record `jsr ${f}` calls (Task 4) |
| `src/c64script/codegen.ts`, `linker.ts` | emit instructions/labels/fixups; located branch-range error (Task 5) |
| `website/*` | reference section, playground example, highlighter (Task 7) |

---

### Task 1: Lexer — `$HEX` literals and `#`

**Files:**
- Modify: `src/c64script/lexer.ts`
- Test: `test/c64script/lexer.test.ts` (append)

**Interfaces:**
- Produces: `$D020` lexes to `int_lit` with text `0xD020`; `#` lexes to token kind `hash`. `${` still lexes to `dollar_lbrace`.

- [ ] **Step 1: Write the failing tests**

Append inside the existing top-level `describe` of `test/c64script/lexer.test.ts` (or as a new `describe` at the end of the file; `tokenize` and `LexError` are already imported there — add the imports if not):

```ts
describe('lexer: assembler tokens', () => {
  it('lexes $HEX as an integer literal', () => {
    const toks = tokenize('$D020 $1b $0');
    expect(toks.map((t) => `${t.kind}:${t.text}`)).toEqual([
      'int_lit:0xD020',
      'int_lit:0x1b',
      'int_lit:0x0',
      'eof:',
    ]);
  });

  it('lexes # as a token', () => {
    expect(tokenize('#5').map((t) => t.kind)).toEqual(['hash', 'int_lit', 'eof']);
  });

  it('keeps ${ as the interpolation opener', () => {
    expect(tokenize('${x}').map((t) => t.kind)).toEqual([
      'dollar_lbrace',
      'ident',
      'rbrace',
      'eof',
    ]);
  });

  it('rejects a lone $', () => {
    expect(() => tokenize('lda $ 5')).toThrow(/unexpected character '\$'/);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run test/c64script/lexer.test.ts`
Expected: FAIL — the `$HEX` and `#` tests throw `unexpected character`.

- [ ] **Step 3: Implement**

In `src/c64script/lexer.ts`, immediately **after** the existing `dollar_lbrace` block (the `if (ch === '$' && peek(1) === '{') { … }`), add:

```ts
    // $HEX literal (assembler style): $D020 → 0xD020
    if (ch === '$' && /[0-9a-fA-F]/.test(peek(1))) {
      advance();
      let s = '0x';
      while (/[0-9a-fA-F_]/.test(peek())) s += advance();
      tok('int_lit', s, l, c);
      continue;
    }
```

and in the `singles` record add the entry `'#': 'hash',` (the `'hash'` kind already exists in `token.ts`).

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/c64script`
Expected: PASS (all existing + 4 new).

- [ ] **Step 5: Commit**

```bash
npx prettier --write test/c64script/lexer.test.ts src/c64script/lexer.ts
git add src/c64script/lexer.ts test/c64script/lexer.test.ts
git commit -m "feat(c64script): lex \$HEX literals and #" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: AST and parser — structured asm blocks

**Files:**
- Modify: `src/c64script/ast.ts`, `src/c64script/parser.ts`
- Modify: `src/c64script/codegen.ts` (only the `case 'asm'` still throws — keep the throw, it reads `s.line` only)
- Create: `test/c64script/asm-parser.test.ts`

**Interfaces:**
- Consumes: Task 1 tokens; `isMnemonic`, `takesOperand` from Task 3 (**Task 3 must be done before the parser can import it — implement Task 3's `asm.ts` first if executing strictly in order; the two tasks are independent otherwise.** To keep the order simple the parser imports only `isMnemonic` and `takesOperand`.)
- Produces (exported from `ast.ts`):

```ts
export type AsmExpr =
  | { readonly tag: 'num'; readonly value: number; readonly line: number }
  | { readonly tag: 'sym'; readonly expr: Expr; readonly line: number }        // ${…}
  | { readonly tag: 'label'; readonly name: string; readonly line: number }
  | { readonly tag: 'lo' | 'hi'; readonly arg: AsmExpr; readonly line: number }
  | { readonly tag: 'add'; readonly lhs: AsmExpr; readonly offset: number; readonly line: number };

export type AsmOperand =
  | { readonly kind: 'none' }
  | { readonly kind: 'acc' }
  | { readonly kind: 'imm'; readonly value: AsmExpr }
  | { readonly kind: 'addr'; readonly value: AsmExpr; readonly index: 'x' | 'y' | null }
  | { readonly kind: 'izx'; readonly value: AsmExpr }
  | { readonly kind: 'izy'; readonly value: AsmExpr }
  | { readonly kind: 'ind'; readonly value: AsmExpr };

export type AsmItem =
  | { readonly kind: 'label'; readonly name: string; readonly line: number }
  | { readonly kind: 'instr'; readonly mnemonic: string; readonly operand: AsmOperand; readonly line: number };
```

  and the statement `{ tag: 'asm'; clobbers: readonly string[]; items: readonly AsmItem[]; line: number }` (replaces `instrs`; `AsmInstr` and `AsmInterp` are removed). `mnemonic` is stored upper-case.

- [ ] **Step 1: Write the failing tests**

Create `test/c64script/asm-parser.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { tokenize } from '../../src/c64script/lexer';
import { parse } from '../../src/c64script/parser';
import type { AsmItem, Stmt } from '../../src/c64script/ast';
import { ParseError } from '../../src/c64script/errors';

function items(block: string): AsmItem[] {
  const prog = parse(tokenize(`program @ 0x0810 {\n${block}\n}`));
  const decl = prog.decls.find((d) => d.tag === 'program');
  const stmt = (decl as { body: Stmt[] }).body[0]!;
  if (stmt.tag !== 'asm') throw new Error('not an asm block');
  return [...stmt.items];
}

const instr = (it: AsmItem) => (it.kind === 'instr' ? it : (undefined as never));

describe('asm parser', () => {
  it('parses one instruction per line, upper-casing the mnemonic', () => {
    const r = items('asm {\n  sei\n  lda #5\n  sta $D011\n}');
    expect(r.map((i) => (i.kind === 'instr' ? i.mnemonic : i.name))).toEqual(['SEI', 'LDA', 'STA']);
    expect(instr(r[1]!).operand).toMatchObject({ kind: 'imm', value: { tag: 'num', value: 5 } });
    expect(instr(r[2]!).operand).toMatchObject({
      kind: 'addr',
      index: null,
      value: { tag: 'num', value: 0xd011 },
    });
    expect(r.map((i) => i.line)).toEqual([2, 3, 4]);
  });

  it('accepts C64Script keywords as labels (loop:, for:)', () => {
    const r = items('asm {\nloop:\n  dex\n  bne loop\n}');
    expect(r[0]).toMatchObject({ kind: 'label', name: 'loop' });
    expect(instr(r[2]!).operand).toMatchObject({ value: { tag: 'label', name: 'loop' } });
  });

  it('parses labels, including one on the same line as an instruction', () => {
    const r = items('asm {\nloop:\n  dex\nagain: bne loop\n}');
    expect(r.map((i) => i.kind)).toEqual(['label', 'instr', 'label', 'instr']);
    expect(r[0]).toMatchObject({ kind: 'label', name: 'loop' });
    expect(instr(r[3]!).operand).toMatchObject({ kind: 'addr', value: { tag: 'label', name: 'loop' } });
  });

  it('parses every operand form', () => {
    const r = items(
      'asm {\n  lda #1\n  lda $10\n  lda $10,x\n  lda $10,y\n  lda ($10,x)\n  lda ($10),y\n  jmp ($1234)\n  asl a\n  asl\n  nop\n}',
    );
    expect(r.map((i) => instr(i).operand.kind)).toEqual([
      'imm', 'addr', 'addr', 'addr', 'izx', 'izy', 'ind', 'acc', 'none', 'none',
    ]);
    expect(instr(r[2]!).operand).toMatchObject({ index: 'x' });
    expect(instr(r[3]!).operand).toMatchObject({ index: 'y' });
  });

  it('parses ${expr}, lo()/hi() and offsets', () => {
    const r = items('asm {\n  lda ${count}\n  lda #lo(${T})\n  sta ${buf} + 1\n  lda #hi(${T} - 2)\n}');
    expect(instr(r[0]!).operand).toMatchObject({ value: { tag: 'sym', expr: { tag: 'ident', name: 'count' } } });
    expect(instr(r[1]!).operand).toMatchObject({ kind: 'imm', value: { tag: 'lo', arg: { tag: 'sym' } } });
    expect(instr(r[2]!).operand).toMatchObject({ value: { tag: 'add', offset: 1, lhs: { tag: 'sym' } } });
    expect(instr(r[3]!).operand).toMatchObject({
      value: { tag: 'hi', arg: { tag: 'add', offset: -2 } },
    });
  });

  it('parses ${screen(1, 2)} as an expression', () => {
    const r = items("asm {\n  sta ${screen(1, 2)},x\n}");
    expect(instr(r[0]!).operand).toMatchObject({
      kind: 'addr',
      index: 'x',
      value: { tag: 'sym', expr: { tag: 'call', name: 'screen' } },
    });
  });

  it('parses character literals', () => {
    const r = items("asm {\n  lda #'H'\n}");
    expect(instr(r[0]!).operand).toMatchObject({ kind: 'imm', value: { tag: 'num', value: 8 } });
  });

  it('separates instructions written on one line', () => {
    const r = items('asm { lda #5 sta $D020 }');
    expect(r.map((i) => instr(i).mnemonic)).toEqual(['LDA', 'STA']);
  });

  it('an implied instruction does not swallow the next instruction as its operand', () => {
    const r = items('asm {\nloop: dex bpl loop\n}');
    expect(r.map((i) => (i.kind === 'instr' ? i.mnemonic : 'label'))).toEqual(['label', 'DEX', 'BPL']);
    expect(instr(r[1]!).operand.kind).toBe('none');
  });

  it('keeps the clobbers list', () => {
    const prog = parse(tokenize('program @ 0x0810 { asm clobbers(A, X, flags) { nop } }'));
    const decl = prog.decls.find((d) => d.tag === 'program') as { body: Stmt[] };
    expect(decl.body[0]).toMatchObject({ tag: 'asm', clobbers: ['A', 'X', 'flags'] });
  });

  it('rejects a label named like an instruction, at its line', () => {
    try {
      items('asm {\n  lda:\n}');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ParseError);
      expect((err as ParseError).message).toMatch(/'lda' is an instruction/);
      expect((err as ParseError).line).toBe(2);
    }
  });

  it('rejects a malformed operand', () => {
    expect(() => items('asm {\n  lda ($10,y)\n}')).toThrow(/expected 'x'/);
    expect(() => items('asm {\n  lda $10,z\n}')).toThrow(/expected x or y/);
    expect(() => items('asm {\n  lda #\n}')).toThrow(ParseError);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run test/c64script/asm-parser.test.ts`
Expected: FAIL — `stmt.items` is undefined (the parser still builds `instrs`).

- [ ] **Step 3: Implement the AST**

In `src/c64script/ast.ts`, **delete** the `AsmInterp` and `AsmInstr` declarations and put the three types from the Interfaces block above in their place. Change the asm member of the `Stmt` union to:

```ts
  | { readonly tag: 'asm';      readonly clobbers: readonly string[]; readonly items: readonly AsmItem[]; readonly line: number };
```

- [ ] **Step 4: Implement the parser**

In `src/c64script/parser.ts`: change the import from `./ast` to include `AsmExpr, AsmItem, AsmOperand` (and drop `AsmInstr, AsmInterp`), add `import { isMnemonic, takesOperand } from './asm';`, and **replace the whole `parseAsm` function** with:

```ts
  function parseAsm(line: number): Stmt {
    eat('asm');
    const clobbers: string[] = [];
    if (maybe('clobbers')) {
      eat('lparen');
      while (!at('rparen') && !at('eof')) {
        clobbers.push(eat('ident').text);
        maybe('comma');
      }
      eat('rparen');
    }
    eat('lbrace');
    const items: AsmItem[] = [];
    while (!at('rbrace') && !at('eof')) items.push(parseAsmItem());
    eat('rbrace');
    return { tag: 'asm', clobbers, items, line };
  }

  /** Any identifier-shaped token, including C64Script keywords: `loop:` is a very common label. */
  const isWord = (t: Token): boolean =>
    t.kind !== 'int_lit' && t.kind !== 'eof' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(t.text);

  function parseAsmItem(): AsmItem {
    const t = peek();
    if (!isWord(t)) {
      throw new ParseError(`expected an instruction or a label, got ${t.kind}`, t.line, t.col);
    }
    pos++;
    if (at('colon')) {
      pos++;
      if (isMnemonic(t.text)) {
        throw new ParseError(`'${t.text}' is an instruction and cannot be used as a label`, t.line, t.col);
      }
      return { kind: 'label', name: t.text, line: t.line };
    }
    const mnemonic = t.text.toUpperCase();
    return { kind: 'instr', mnemonic, operand: parseAsmOperand(mnemonic, t.line), line: t.line };
  }

  /** The operand must start on the instruction's own line, so `dex` ⏎ `bne x` stays two items. */
  function parseAsmOperand(mnemonic: string, line: number): AsmOperand {
    const next = peek();
    if (next.line !== line || next.kind === 'rbrace' || next.kind === 'eof') return { kind: 'none' };
    if (isMnemonic(mnemonic) && !takesOperand(mnemonic)) return { kind: 'none' };
    if (isWord(next) && next.text.toLowerCase() !== 'a' && isMnemonic(next.text)) {
      return { kind: 'none' }; // `asl bne …` on one line: the next word starts a new instruction
    }

    if (at('hash')) {
      pos++;
      return { kind: 'imm', value: parseAsmExpr() };
    }
    if (at('lparen')) {
      pos++;
      const value = parseAsmExpr();
      if (maybe('comma')) {
        const reg = eat('ident');
        if (reg.text.toLowerCase() !== 'x') {
          throw new ParseError(`expected 'x' in (address,x), got '${reg.text}'`, reg.line, reg.col);
        }
        eat('rparen');
        return { kind: 'izx', value };
      }
      eat('rparen');
      if (maybe('comma')) {
        const reg = eat('ident');
        if (reg.text.toLowerCase() !== 'y') {
          throw new ParseError(`expected 'y' in (address),y, got '${reg.text}'`, reg.line, reg.col);
        }
        return { kind: 'izy', value };
      }
      return { kind: 'ind', value };
    }
    if (at('ident') && peek().text.toLowerCase() === 'a') {
      pos++;
      return { kind: 'acc' };
    }
    const value = parseAsmExpr();
    if (maybe('comma')) {
      const reg = eat('ident');
      const r = reg.text.toLowerCase();
      if (r !== 'x' && r !== 'y') {
        throw new ParseError(`expected x or y after ',', got '${reg.text}'`, reg.line, reg.col);
      }
      return { kind: 'addr', value, index: r };
    }
    return { kind: 'addr', value, index: null };
  }

  function parseAsmExpr(): AsmExpr {
    let e = parseAsmTerm();
    while (at('plus') || at('minus')) {
      const sign = tokens[pos++]!.kind === 'plus' ? 1 : -1;
      const n = eat('int_lit');
      e = { tag: 'add', lhs: e, offset: sign * parseIntLit(n.text), line: n.line };
    }
    return e;
  }

  function parseAsmTerm(): AsmExpr {
    const t = peek();
    pos++;
    if (t.kind === 'int_lit') return { tag: 'num', value: parseIntLit(t.text), line: t.line };
    if (t.kind === 'dollar_lbrace') {
      const expr = parseExpr();
      eat('rbrace');
      return { tag: 'sym', expr, line: t.line };
    }
    if (isWord(t)) {
      if ((t.text === 'lo' || t.text === 'hi') && at('lparen')) {
        pos++;
        const arg = parseAsmExpr();
        eat('rparen');
        return { tag: t.text, arg, line: t.line };
      }
      return { tag: 'label', name: t.text, line: t.line };
    }
    throw new ParseError(`unexpected ${t.kind} in an instruction operand`, t.line, t.col);
  }
```

(`lda #` followed by `}`: `parseAsmTerm` receives `rbrace` and raises "unexpected rbrace in an instruction operand". The register after a comma is read with `eat('ident')`; `Token` is already imported in the parser.)

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run test/c64script/asm-parser.test.ts && npm run typecheck`
Expected: PASS and typecheck exits 0. If `codegen.ts` still references `s.instrs`, change it — the current `case 'asm'` only throws and reads `s.line`, so no change should be needed.

- [ ] **Step 6: Commit**

```bash
npx prettier --write src/c64script/ast.ts src/c64script/parser.ts test/c64script/asm-parser.test.ts
npx eslint src/c64script test/c64script/asm-parser.test.ts
git add src/c64script/ast.ts src/c64script/parser.ts test/c64script/asm-parser.test.ts
git commit -m "feat(c64script): parse asm blocks into structured instructions" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `asm.ts` — opcode table and mode selection

**Files:**
- Create: `src/c64script/asm.ts`
- Test: `test/c64script/asm-table.test.ts`

> Do this task **before** Task 2's parser step (the parser imports `isMnemonic` / `takesOperand`). Tasks 1 and 3 have no dependencies; Task 2 needs both.

**Interfaces:**
- Consumes: `OPS`, `Mode`, `OpInfo` from `src/core` (`OpInfo = { mnemonic; mode; kind; official }`, `Mode = 'imp'|'acc'|'imm'|'zp'|'zpx'|'zpy'|'abs'|'abx'|'aby'|'izx'|'izy'|'rel'|'ind'`).
- Produces:

```ts
export type AsmShape = 'none' | 'acc' | 'imm' | 'addr' | 'addrx' | 'addry' | 'izx' | 'izy' | 'ind';
export function isMnemonic(m: string): boolean;          // official mnemonic, any case
export function takesOperand(m: string): boolean;        // has a mode other than 'imp'
export function opcodeFor(m: string, mode: Mode): number | undefined;
export type ModeChoice = { readonly mode: Mode } | { readonly error: string };
export function chooseMode(m: string, shape: AsmShape, value: number | null): ModeChoice;
```

`value` is the operand's compile-time value, or `null` when it is a label / function address (unknown until link time; such operands are always 16-bit).

- [ ] **Step 1: Write the failing tests**

Create `test/c64script/asm-table.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { OPS } from '../../src/core';
import type { Mode } from '../../src/core';
import { chooseMode, isMnemonic, opcodeFor, takesOperand } from '../../src/c64script/asm';
import type { AsmShape } from '../../src/c64script/asm';

const OFFICIAL = OPS.map((info, opcode) => ({ info, opcode })).filter((o) => o.info.official);

describe('asm opcode table', () => {
  it('covers the 151 official opcodes', () => {
    expect(OFFICIAL.length).toBe(151);
  });

  it('every official (mnemonic, mode) pair encodes to an opcode the core decodes back', () => {
    for (const { info } of OFFICIAL) {
      const opcode = opcodeFor(info.mnemonic, info.mode);
      expect(opcode, `${info.mnemonic} ${info.mode}`).toBeDefined();
      const back = OPS[opcode!]!;
      expect(back.mnemonic).toBe(info.mnemonic);
      expect(back.mode).toBe(info.mode);
      expect(back.official).toBe(true);
    }
  });

  it('knows official mnemonics in any case and rejects undocumented ones', () => {
    expect(isMnemonic('lda')).toBe(true);
    expect(isMnemonic('LDA')).toBe(true);
    expect(isMnemonic('lax')).toBe(false);
    expect(isMnemonic('jam')).toBe(false);
    expect(isMnemonic('frob')).toBe(false);
  });

  it('knows which instructions take an operand', () => {
    expect(takesOperand('LDA')).toBe(true);
    expect(takesOperand('BNE')).toBe(true);
    expect(takesOperand('ASL')).toBe(true); // accumulator or memory
    expect(takesOperand('DEX')).toBe(false);
    expect(takesOperand('NOP')).toBe(false);
  });
});

describe('chooseMode', () => {
  const pick = (m: string, shape: AsmShape, value: number | null): Mode | string => {
    const r = chooseMode(m, shape, value);
    return 'mode' in r ? r.mode : r.error;
  };

  it('uses zero page up to $FF and absolute from $100', () => {
    expect(pick('LDA', 'addr', 0xff)).toBe('zp');
    expect(pick('LDA', 'addr', 0x100)).toBe('abs');
    expect(pick('LDA', 'addrx', 0xff)).toBe('zpx');
    expect(pick('LDA', 'addrx', 0x100)).toBe('abx');
  });

  it('falls back to absolute,Y when there is no zero-page,Y form', () => {
    expect(pick('LDA', 'addry', 0x10)).toBe('aby');
    expect(pick('LDX', 'addry', 0x10)).toBe('zpy');
    expect(pick('STA', 'addry', 0x10)).toBe('aby');
  });

  it('labels and function addresses are absolute', () => {
    expect(pick('JMP', 'addr', null)).toBe('abs');
    expect(pick('JSR', 'addr', null)).toBe('abs');
    expect(pick('LDA', 'addrx', null)).toBe('abx');
  });

  it('branches take an address as a relative target', () => {
    expect(pick('BNE', 'addr', null)).toBe('rel');
    expect(pick('BPL', 'addr', null)).toBe('rel');
  });

  it('immediate must fit a byte', () => {
    expect(pick('LDA', 'imm', 255)).toBe('imm');
    expect(pick('LDA', 'imm', 256)).toMatch(/0\.\.255/);
    expect(pick('STA', 'imm', 1)).toMatch(/does not support/);
  });

  it('indirect forms need a zero-page address', () => {
    expect(pick('LDA', 'izx', 0x10)).toBe('izx');
    expect(pick('LDA', 'izy', 0x10)).toBe('izy');
    expect(pick('LDA', 'izy', 0x100)).toMatch(/zero page/);
    expect(pick('JMP', 'ind', 0x1234)).toBe('ind');
    expect(pick('LDA', 'ind', 0x1234)).toMatch(/does not support/);
  });

  it('accumulator and implied forms', () => {
    expect(pick('ASL', 'acc', null)).toBe('acc');
    expect(pick('ASL', 'none', null)).toBe('acc');
    expect(pick('DEX', 'none', null)).toBe('imp');
    expect(pick('LDA', 'none', null)).toMatch(/needs an operand/);
    expect(pick('LDA', 'acc', null)).toMatch(/does not support/);
  });

  it('a zero-page-only form with a value that does not fit is an error', () => {
    expect(pick('STX', 'addry', 0x1234)).toMatch(/zero page/);
  });

  it('values above $FFFF are rejected', () => {
    expect(pick('LDA', 'addr', 0x10000)).toMatch(/0\.\.65535/);
  });

  it('unknown and undocumented instructions are named', () => {
    expect(pick('FROB', 'none', null)).toMatch(/unknown instruction 'FROB'/);
    expect(pick('LAX', 'addr', 0x10)).toMatch(/undocumented/);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run test/c64script/asm-table.test.ts`
Expected: FAIL — cannot resolve `../../src/c64script/asm`.

- [ ] **Step 3: Implement `src/c64script/asm.ts`**

```ts
import { OPS } from '../core';
import type { Mode } from '../core';

// The assembler's encodings are derived from the CPU core's decode table, so the compiler and
// the emulator can never disagree about what an instruction is. Only official opcodes count.

const opcodes = new Map<string, number>(); // "LDA:imm" → opcode
const modesByMnemonic = new Map<string, Set<Mode>>(); // "LDA" → { imm, zp, … }
const undocumentedOnly = new Set<string>();

{
  const seenUndocumented = new Set<string>();
  OPS.forEach((info, opcode) => {
    if (!info.official) {
      seenUndocumented.add(info.mnemonic);
      return;
    }
    const key = `${info.mnemonic}:${info.mode}`;
    if (!opcodes.has(key)) opcodes.set(key, opcode);
    let modes = modesByMnemonic.get(info.mnemonic);
    if (!modes) modesByMnemonic.set(info.mnemonic, (modes = new Set()));
    modes.add(info.mode);
  });
  for (const m of seenUndocumented) if (!modesByMnemonic.has(m)) undocumentedOnly.add(m);
}

/** The shape of an operand as written, before its value decides zero page vs absolute. */
export type AsmShape = 'none' | 'acc' | 'imm' | 'addr' | 'addrx' | 'addry' | 'izx' | 'izy' | 'ind';

export type ModeChoice = { readonly mode: Mode } | { readonly error: string };

export function isMnemonic(m: string): boolean {
  return modesByMnemonic.has(m.toUpperCase());
}

export function takesOperand(m: string): boolean {
  const modes = modesByMnemonic.get(m.toUpperCase());
  if (!modes) return false;
  for (const mode of modes) if (mode !== 'imp') return true;
  return false;
}

export function opcodeFor(m: string, mode: Mode): number | undefined {
  return opcodes.get(`${m.toUpperCase()}:${mode}`);
}

function has(m: string, mode: Mode): boolean {
  return modesByMnemonic.get(m)?.has(mode) ?? false;
}

/**
 * Picks the addressing mode for `m` given how the operand was written and its value.
 * `value` is null for a label or function address (unknown until link time, always 16-bit).
 */
export function chooseMode(mnemonic: string, shape: AsmShape, value: number | null): ModeChoice {
  const m = mnemonic.toUpperCase();
  if (!modesByMnemonic.has(m)) {
    return {
      error: undocumentedOnly.has(m)
        ? `'${m}' is an undocumented instruction and is not supported`
        : `unknown instruction '${mnemonic}'`,
    };
  }
  const unsupported = { error: `'${m}' does not support this addressing mode` };
  if (value !== null && (value < 0 || value > 0xffff)) {
    return { error: `address ${value} is out of range 0..65535` };
  }

  switch (shape) {
    case 'none':
      if (has(m, 'imp')) return { mode: 'imp' };
      if (has(m, 'acc')) return { mode: 'acc' };
      return { error: `'${m}' needs an operand` };
    case 'acc':
      return has(m, 'acc') ? { mode: 'acc' } : unsupported;
    case 'imm':
      if (!has(m, 'imm')) return unsupported;
      if (value !== null && value > 0xff) {
        return { error: `immediate value ${value} is out of range 0..255` };
      }
      return { mode: 'imm' };
    case 'addr':
      if (has(m, 'rel')) return { mode: 'rel' };
      return pickAddress(m, 'zp', 'abs', value, unsupported);
    case 'addrx':
      return pickAddress(m, 'zpx', 'abx', value, unsupported);
    case 'addry':
      return pickAddress(m, 'zpy', 'aby', value, unsupported);
    case 'izx':
    case 'izy': {
      if (!has(m, shape)) return unsupported;
      if (value !== null && value > 0xff) {
        return { error: `'${m}' needs a zero-page address, but ${value} does not fit in zero page` };
      }
      return { mode: shape };
    }
    case 'ind':
      return has(m, 'ind') ? { mode: 'ind' } : unsupported;
  }
}

function pickAddress(
  m: string,
  zp: Mode,
  abs: Mode,
  value: number | null,
  unsupported: { readonly error: string },
): ModeChoice {
  const zeroPage = value !== null && value <= 0xff;
  if (zeroPage && has(m, zp)) return { mode: zp };
  if (has(m, abs)) return { mode: abs };
  if (has(m, zp)) {
    return { error: `'${m}' only has a zero-page form, but the address does not fit in zero page` };
  }
  return unsupported;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/c64script/asm-table.test.ts && npm run typecheck`
Expected: PASS and typecheck exits 0. If the "151 official opcodes" assertion fails, print `OFFICIAL.length` and check the `official` flag computation in `src/core/opcodes.ts` before changing the test — the count is a property of the core table.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/c64script/asm.ts test/c64script/asm-table.test.ts
npx eslint src/c64script/asm.ts test/c64script/asm-table.test.ts
git add src/c64script/asm.ts test/c64script/asm-table.test.ts
git commit -m "feat(c64script): assembler opcode table and addressing-mode selection" -m "Derived from the CPU core's OPS table (official opcodes only); every pair round-trips against it." -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Checker — `clobbers()` and `${…}` resolution

**Files:**
- Modify: `src/c64script/checker.ts`
- Test: `test/c64script/asm-checker.test.ts`

**Interfaces:**
- Consumes: `AsmExpr`, `AsmItem` (Task 2).
- Produces: `TypeError`s: unknown clobber register; undefined name inside `${…}`; calls made by `jsr ${fn}` are recorded for recursion detection.

- [ ] **Step 1: Write the failing tests**

Create `test/c64script/asm-checker.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { expectError } from './helpers';
import { compile } from '../../src/c64script/index';

describe('asm checks', () => {
  it('rejects an unknown register in clobbers()', () => {
    expectError(
      'program @ 0x0810 {\n  asm clobbers(A, Z) { nop }\n  loop {}\n}',
      'type',
      /unknown register 'Z'/,
      2,
    );
  });

  it('accepts A, X, Y and flags in any case', () => {
    expect(() => compile('program @ 0x0810 { asm clobbers(a, X, y, FLAGS) { nop } loop {} }')).not.toThrow();
  });

  it('rejects an undefined name inside ${…}', () => {
    expectError(
      'program @ 0x0810 {\n  asm {\n    lda ${nothing}\n  }\n  loop {}\n}',
      'type',
      /undefined variable 'nothing'/,
      3,
    );
  });

  it('a function named in ${…} counts as a call, so recursion is still caught', () => {
    expectError(
      'fn f(): void {\n  asm {\n    jsr ${f}\n  }\n}\nprogram @ 0x0810 { f(); loop {} }',
      'type',
      /recurs/,
      3,
    );
  });

  it('resolves names against the enclosing function scope', () => {
    expect(() =>
      compile('fn f(): void { let t: u8 = 1; asm { lda ${t} } }\nprogram @ 0x0810 { f(); loop {} }'),
    ).toThrow(/not supported|undefined|Error/);
  });
});
```

> The last test is a placeholder for Task 5 (codegen not done yet, so it throws something). **Replace it with this in Step 3 of Task 5** once codegen exists:
> ```ts
> it('resolves names against the enclosing function scope', () => {
>   expect(() =>
>     compile('fn f(): void { let t: u8 = 1; asm { lda ${t} } }\nprogram @ 0x0810 { f(); loop {} }'),
>   ).not.toThrow();
> });
> ```
> To keep this task self-contained, **delete the last `it(...)` now** and add the replacement in Task 5.

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run test/c64script/asm-checker.test.ts`
Expected: FAIL — the first, third and fourth tests: no `TypeError` is thrown (the checker ignores asm statements).

- [ ] **Step 3: Implement**

In `src/c64script/checker.ts`: add `AsmExpr` to the `import type … from './ast'` list. In `checkStmt`, replace the `default:` arm (currently `break; // asm: reported by the code generator`) with an explicit asm arm and keep a default:

```ts
      case 'asm':
        checkAsm(s, scope);
        break;
      default:
        break;
```

and add this function next to `checkPuts`:

```ts
  const CLOBBERABLE = new Set(['a', 'x', 'y', 'flags']);

  /** clobbers() names are validated; `${…}` operands are resolved like any expression. */
  function checkAsm(s: Extract<Stmt, { tag: 'asm' }>, scope: string): void {
    for (const name of s.clobbers) {
      if (!CLOBBERABLE.has(name.toLowerCase())) {
        throw new TypeError(
          `unknown register '${name}' in clobbers() (use A, X, Y or flags)`,
          s.line,
          0,
        );
      }
    }
    const visit = (e: AsmExpr): void => {
      switch (e.tag) {
        case 'sym': {
          const ex = e.expr;
          if (ex.tag === 'ident' && fns.has(ex.name)) {
            calls.get(scope)?.push({ to: ex.name, line: e.line });
            return;
          }
          checkExpr(ex, 'read', scope, null);
          return;
        }
        case 'lo':
        case 'hi':
          visit(e.arg);
          return;
        case 'add':
          visit(e.lhs);
          return;
        default:
          return;
      }
    };
    for (const item of s.items) {
      if (item.kind === 'instr' && 'value' in item.operand) visit(item.operand.value);
    }
  }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/c64script && npm run typecheck`
Expected: PASS. (The existing "asm {}" error test in `no-silent-miscompiles.test.ts` still passes: codegen still throws.)

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/c64script/checker.ts test/c64script/asm-checker.test.ts
npx eslint src/c64script test/c64script/asm-checker.test.ts
git add src/c64script/checker.ts test/c64script/asm-checker.test.ts
git commit -m "feat(c64script): check asm clobbers() and \${…} names" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Code generation — emit instructions, labels and fixups

**Files:**
- Modify: `src/c64script/codegen.ts`, `src/c64script/linker.ts`
- Modify: `test/c64script/no-silent-miscompiles.test.ts` (the old "asm {}" error test)
- Test: `test/c64script/asm.test.ts`

**Interfaces:**
- Consumes: `chooseMode`, `opcodeFor` (Task 3); `AsmExpr`/`AsmItem` (Task 2); `OPS` from `../core` (for `kind`).
- Produces: `Fixup` gains an optional `line`; linker error `branch out of range to '<label>' (<n> bytes) …` carries the asm line.

- [ ] **Step 1: Write the failing tests**

Create `test/c64script/asm.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { compile } from '../../src/c64script/index';
import { background, border, boot, expectError } from './helpers';

describe('asm blocks run', () => {
  it('fills screen RAM with an indexed store loop', () => {
    const c = boot(`
      program @ 0x0810 {
        asm {
          lda #$A0
          ldx #0
        fill:
          sta \${screen(0, 0)},x
          sta \${screen(0, 0) + 256},x
          sta \${screen(0, 0) + 512},x
          sta \${screen(0, 0) + 744},x
          inx
          bne fill
        }
        loop {}
      }`);
    for (const addr of [0x0400, 0x04ff, 0x0500, 0x05ff, 0x0600, 0x06ff, 0x07e7]) {
      expect(c.peek(addr), `$${addr.toString(16)}`).toBe(0xa0);
    }
    expect(c.peek(0x07e8)).not.toBe(0xa0);
  });

  it('reads and writes a zero-page variable', () => {
    const c = boot(`
      let @zp n: u8 = 5;
      program @ 0x0810 {
        asm {
          inc \${n}
          lda \${n}
          sta $D020
        }
        loop {}
      }`);
    expect(border(c)).toBe(6);
  });

  it('uses a constant as an immediate and as an address to read', () => {
    const c = boot(`
      const MAX: u8 = 7;
      program @ 0x0810 {
        asm {
          lda #\${MAX}
          sta $D021
        }
        loop {}
      }`);
    expect(background(c)).toBe(7);
  });

  it('lo() and hi() of a constant, with an offset on a variable', () => {
    const c = boot(`
      const TABLE: u16 = 0x1234;
      let @zp w: u16 = 0;
      program @ 0x0810 {
        asm {
          lda #lo(\${TABLE})
          sta \${w}
          lda #hi(\${TABLE})
          sta \${w} + 1
        }
        VIC2.borderColor = lo(w);
        VIC2.bgColor0 = hi(w);
        loop {}
      }`);
    expect(border(c)).toBe(4);
    expect(background(c)).toBe(2);
  });

  it('calls a C64Script function with jsr ${f}', () => {
    const c = boot(`
      fn paint(): void { VIC2.borderColor = 9; }
      program @ 0x0810 {
        asm { jsr \${paint} }
        loop {}
      }`);
    expect(border(c)).toBe(9);
  });

  it('a function called only from asm is still emitted', () => {
    const c = boot(`
      fn paint(): void { VIC2.bgColor0 = 3; }
      program @ 0x0810 { asm { jsr \${paint} } loop {} }`);
    expect(background(c)).toBe(3);
  });

  it('asm inside an @inline function, expanded twice, gets unique labels', () => {
    const c = boot(`
      @inline fn spin(): void {
        asm {
          ldx #3
        again:
          dex
          bne again
        }
      }
      program @ 0x0810 {
        spin();
        spin();
        VIC2.borderColor = 4;
        loop {}
      }`);
    expect(border(c)).toBe(4);
  });

  it('forward and backward branches', () => {
    const c = boot(`
      program @ 0x0810 {
        asm {
          lda #0
          beq skip
          lda #9
        skip:
          sta $D020
          ldx #2
        loop:
          inc $D021
          dex
          bne loop
        }
        loop {}
      }`);
    expect(border(c)).toBe(0);
    expect(background(c)).toBe(2);
  });

  it('(zp),y indirect store', () => {
    const c = boot(`
      let @zp p: u16 = 0x0500;
      program @ 0x0810 {
        asm {
          ldy #2
          lda #9
          sta (\${p}),y
        }
        loop {}
      }`);
    expect(c.peek(0x0502)).toBe(9);
  });

  it('accumulator shifts, in any letter case', () => {
    const c = boot(`
      program @ 0x0810 {
        asm {
          LDA #3
          ASL A
          asl
          STA $D020
        }
        loop {}
      }`);
    expect(border(c)).toBe(12);
  });

  it('several instructions on one line, and a character literal', () => {
    const c = boot("program @ 0x0810 { asm { lda #'H' sta $0400 } loop {} }");
    expect(c.peek(0x0400)).toBe(8);
  });

  it('assembles lda $10,y as absolute,Y (no zero-page,Y form)', () => {
    const prg = compile('program @ 0x0810 { asm { lda $10,y } loop {} }');
    const bytes = Array.from(prg);
    const at = bytes.findIndex((b, i) => b === 0xb9 && bytes[i + 1] === 0x10 && bytes[i + 2] === 0x00);
    expect(at).toBeGreaterThan(1);
  });

  it('assembles lda $FF as zero page and lda $100 as absolute', () => {
    const bytes = Array.from(compile('program @ 0x0810 { asm { lda $FF lda $100 } loop {} }'));
    const zp = bytes.findIndex((b, i) => b === 0xa5 && bytes[i + 1] === 0xff);
    const abs = bytes.findIndex((b, i) => b === 0xad && bytes[i + 1] === 0x00 && bytes[i + 2] === 0x01);
    expect(zp).toBeGreaterThan(1);
    expect(abs).toBeGreaterThan(zp);
  });
});

describe('asm errors', () => {
  const wrap = (body: string) => `program @ 0x0810 {\n  asm {\n${body}\n  }\n  loop {}\n}`;

  it('unknown and undocumented instructions', () => {
    expectError(wrap('    frob'), 'codegen', /unknown instruction 'frob'/, 3);
    expectError(wrap('    lax $10'), 'codegen', /undocumented/, 3);
  });

  it('unsupported addressing mode and out-of-range values', () => {
    expectError(wrap('    sta #5'), 'codegen', /does not support/, 3);
    expectError(wrap('    lda #300'), 'codegen', /0\.\.255/, 3);
    expectError(wrap('    stx $1234,y'), 'codegen', /zero page/, 3);
    expectError(wrap('    lda'), 'codegen', /needs an operand/, 3);
  });

  it('undefined and duplicate labels', () => {
    expectError(wrap('    bne nowhere'), 'codegen', /undefined label 'nowhere'/, 3);
    expectError(wrap('  here:\n    nop\n  here:\n    nop'), 'codegen', /label 'here' is defined twice/, 5);
  });

  it('a branch farther than 127 bytes names the label and the line', () => {
    const nops = Array.from({ length: 140 }, () => '    nop').join('\n');
    expectError(wrap(`    bne far\n${nops}\n  far:\n    nop`), 'codegen', /branch out of range to 'far'/, 3);
  });

  it('# on a variable, and writing to a constant', () => {
    expectError(
      'let @zp v: u8 = 1;\nprogram @ 0x0810 {\n  asm {\n    lda #${v}\n  }\n  loop {}\n}',
      'codegen',
      /lo\(/,
      4,
    );
    expectError(
      'const K: u8 = 1;\nprogram @ 0x0810 {\n  asm {\n    sta ${K}\n  }\n  loop {}\n}',
      'codegen',
      /cannot write to constant/,
      4,
    );
  });

  it('an offset on a label', () => {
    expectError(wrap('  l:\n    jmp l + 1'), 'codegen', /offset.*label/, 4);
  });

  it('${…} that is neither a name nor a constant', () => {
    expectError(
      'let @zp a: u8 = 1;\nlet @zp b: u8 = 2;\nprogram @ 0x0810 {\n  asm {\n    lda ${a + b}\n  }\n  loop {}\n}',
      'codegen',
      /compile-time constant/,
      5,
    );
  });

  it('reading a constant address is allowed (lda ${CONST})', () => {
    expect(() => compile('const K: u8 = 5;\nprogram @ 0x0810 { asm { lda ${K} } loop {} }')).not.toThrow();
  });
});
```

Also, in `test/c64script/asm-checker.test.ts` add the test described in Task 4's note (resolves names against the enclosing function scope, `.not.toThrow()`).

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run test/c64script/asm.test.ts`
Expected: FAIL — every test throws "asm {} blocks are not supported yet".

- [ ] **Step 3: Implement the linker change**

In `src/c64script/linker.ts`: change the loop header to `for (const { offset, kind, line } of buf.fixups) {`, add a helper above `link`:

```ts
/** `__asm3_loop` → `loop`: asm labels are made unique per emission. */
const display = (label: string): string => label.replace(/^__asm\d+_/, '');
```

and change the two `CodeGenError` constructions for `branch8` and unresolved labels to use it and the fixup line:

```ts
        if (labelOffset === undefined) {
          throw new CodeGenError(`unresolved label '${display(kind.label)}'`, line ?? 0, 0);
        }
```
(for both `abs16` and `branch8`), and

```ts
        if (rel < -128 || rel > 127) {
          throw new CodeGenError(
            `branch out of range to '${display(kind.label)}' (${rel} bytes; a branch reaches -128..+127)`,
            line ?? 0,
            0,
          );
        }
```

- [ ] **Step 4: Implement `Fixup.line` and `addFixup`**

In `codegen.ts`: `export interface Fixup { offset: number; kind: FixupKind; line?: number; }` and

```ts
  function addFixup(kind: FixupKind, n: number, line?: number): void {
    fixups.push(line === undefined ? { offset: bytes.length, kind } : { offset: bytes.length, kind, line });
    for (let i = 0; i < n; i++) emit(0x00);
  }
```

- [ ] **Step 5: Implement `genAsm`**

In `codegen.ts`: add imports `import { OPS } from '../core';`, `import { chooseMode, opcodeFor } from './asm';`, `import type { AsmExpr, AsmItem, Expr, Stmt } from './ast';` (merge with the existing ast import), and `import type { AsmShape } from './asm';`. Inside `generate`, next to `genStore`, add:

```ts
  let asmCounter = 0;

  type AsmValue =
    | { kind: 'value'; value: number; fromConst: boolean; fromVar: boolean }
    | { kind: 'label'; label: string }
    | { kind: 'byte'; label: string; high: boolean };

  function resolveAsm(e: AsmExpr, defined: ReadonlySet<string>, mangle: (n: string) => string): AsmValue {
    switch (e.tag) {
      case 'num':
        return { kind: 'value', value: e.value, fromConst: false, fromVar: false };
      case 'label':
        if (!defined.has(e.name)) {
          throw new CodeGenError(`undefined label '${e.name}'`, e.line, 0);
        }
        return { kind: 'label', label: mangle(e.name) };
      case 'sym': {
        const ex = e.expr;
        if (ex.tag === 'ident') {
          const v = lookup(ex.name);
          if (v) {
            if (v.isConst && v.constValue !== null) {
              return { kind: 'value', value: v.constValue, fromConst: true, fromVar: false };
            }
            const addr = v.zpAddr ?? v.absAddr;
            if (addr !== null) return { kind: 'value', value: addr, fromConst: false, fromVar: true };
          }
          const fn = cp.fns.get(ex.name);
          if (fn) {
            if (fn.isInline) {
              throw new CodeGenError(`'${ex.name}' is @inline and has no address`, e.line, 0);
            }
            return { kind: 'label', label: `fn_${ex.name}` };
          }
        }
        const c = evalConst(ex);
        if (c === null) {
          throw new CodeGenError(
            '${…} must be a variable, a function or a compile-time constant',
            e.line,
            0,
          );
        }
        return { kind: 'value', value: c, fromConst: true, fromVar: false };
      }
      case 'lo':
      case 'hi': {
        const inner = resolveAsm(e.arg, defined, mangle);
        if (inner.kind === 'value') {
          const v = e.tag === 'hi' ? inner.value >> 8 : inner.value;
          return { kind: 'value', value: v & 0xff, fromConst: inner.fromConst, fromVar: false };
        }
        if (inner.kind === 'label') return { kind: 'byte', label: inner.label, high: e.tag === 'hi' };
        throw new CodeGenError(`${e.tag}() cannot be nested`, e.line, 0);
      }
      case 'add': {
        const inner = resolveAsm(e.lhs, defined, mangle);
        if (inner.kind !== 'value') {
          throw new CodeGenError('an offset cannot be added to a label or function address', e.line, 0);
        }
        return { ...inner, value: inner.value + e.offset };
      }
    }
  }

  function genAsm(s: Extract<Stmt, { tag: 'asm' }>): void {
    const id = asmCounter++; // per emission: an @inline function may be expanded many times
    const mangle = (name: string): string => `__asm${id}_${name}`;
    const defined = new Set<string>();
    for (const item of s.items) {
      if (item.kind !== 'label') continue;
      if (defined.has(item.name)) {
        throw new CodeGenError(`label '${item.name}' is defined twice in this asm block`, item.line, 0);
      }
      defined.add(item.name);
    }
    for (const item of s.items) {
      if (item.kind === 'label') emitLabel(mangle(item.name));
      else genAsmInstr(item, defined, mangle);
    }
  }

  function genAsmInstr(
    item: Extract<AsmItem, { kind: 'instr' }>,
    defined: ReadonlySet<string>,
    mangle: (n: string) => string,
  ): void {
    const op = item.operand;
    const line = item.line;
    let shape: AsmShape;
    switch (op.kind) {
      case 'none':
      case 'acc':
      case 'imm':
      case 'izx':
      case 'izy':
      case 'ind':
        shape = op.kind;
        break;
      case 'addr':
        shape = op.index === 'x' ? 'addrx' : op.index === 'y' ? 'addry' : 'addr';
        break;
    }
    const resolved = 'value' in op ? resolveAsm(op.value, defined, mangle) : null;
    const known = resolved !== null && resolved.kind === 'value' ? resolved.value : null;

    const choice = chooseMode(item.mnemonic, shape, known);
    if ('error' in choice) throw new CodeGenError(choice.error, line, 0);
    const mode = choice.mode;
    const opcode = opcodeFor(item.mnemonic, mode)!;

    if (resolved && resolved.kind === 'value') {
      if (mode === 'imm' && resolved.fromVar) {
        throw new CodeGenError(
          `'#' needs a constant, but the operand is the address of a variable; use lo(\${…}) or hi(\${…})`,
          line,
          0,
        );
      }
      const kind = OPS[opcode]!.kind;
      if (resolved.fromConst && mode !== 'imm' && (kind === 'write' || kind === 'rmw')) {
        throw new CodeGenError(`cannot write to constant: '${item.mnemonic}' stores to it`, line, 0);
      }
    }

    switch (mode) {
      case 'imp':
      case 'acc':
        emit(opcode);
        return;
      case 'imm':
        if (resolved?.kind === 'byte') {
          emit(opcode);
          addFixup({ kind: resolved.high ? 'absHiByte' : 'absLoByte', label: resolved.label }, 1, line);
          return;
        }
        if (resolved?.kind === 'label') {
          throw new CodeGenError("'#' needs lo(...) or hi(...) of an address, not the address itself", line, 0);
        }
        emit(opcode, known! & 0xff);
        return;
      case 'zp':
      case 'zpx':
      case 'zpy':
      case 'izx':
      case 'izy':
        if (known === null) {
          throw new CodeGenError(
            `'${item.mnemonic}' needs a zero-page address, not a label or function`,
            line,
            0,
          );
        }
        emit(opcode, known & 0xff);
        return;
      case 'rel':
        if (resolved?.kind !== 'label') {
          throw new CodeGenError(`'${item.mnemonic}' needs a label to branch to`, line, 0);
        }
        emit(opcode);
        addFixup({ kind: 'branch8', label: resolved.label }, 1, line);
        return;
      case 'abs':
      case 'abx':
      case 'aby':
      case 'ind':
        if (resolved?.kind === 'label') {
          emit(opcode);
          addFixup({ kind: 'abs16', label: resolved.label }, 2, line);
        } else if (resolved?.kind === 'value') {
          emit(opcode, resolved.value & 0xff, (resolved.value >> 8) & 0xff);
        } else {
          throw new CodeGenError(`'${item.mnemonic}' needs an address`, line, 0);
        }
        return;
    }
  }
```

In `genStmt`, replace the asm arm:

```ts
      case 'asm':
        genAsm(s);
        break;
```

- [ ] **Step 6: Update the old error test**

In `test/c64script/no-silent-miscompiles.test.ts` replace the `asm {}` test:

```ts
  it('asm {}', () => {
    expectError('program @ 0x0810 {\n  asm { nop }\n  loop {}\n}', 'codegen', /asm/, 2);
  });
```
with
```ts
  it('an unknown instruction inside asm {}', () => {
    expectError(
      'program @ 0x0810 {\n  asm { frob }\n  loop {}\n}',
      'codegen',
      /unknown instruction 'frob'/,
      2,
    );
  });
```

- [ ] **Step 7: Run tests**

Run: `npx vitest run test/c64script && npm run typecheck`
Expected: PASS. If a branch-range test fails because the label offset arithmetic differs (140 `nop`s should give a distance of 141+), check `far` placement; the expected message is `branch out of range to 'far' (…)` at line 3.

- [ ] **Step 8: Commit**

```bash
npx prettier --write src/c64script/codegen.ts src/c64script/linker.ts test/c64script/asm.test.ts test/c64script/asm-checker.test.ts test/c64script/no-silent-miscompiles.test.ts
npx eslint src/c64script test/c64script
git add src/c64script test/c64script
git commit -m "feat(c64script): generate code for asm {} blocks" -m "Official opcodes, labels scoped per emission, \${expr} interpolation, lo()/hi(), offsets, jsr \${fn}. Branch-range errors name the label and line." -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Documentation, playground example and highlighter

**Files:**
- Modify: `website/js/playground-examples.js`, `website/js/c64script-grammar.js`, `website/c64script.html`
- Test: `test/website/examples.test.ts` (append)

**Interfaces:**
- Consumes: working `asm {}` (Task 5).
- Produces: playground example id `asm`; docs section "Inline assembly" with a Try-now sample.

- [ ] **Step 1: Write the failing test**

Append to `test/website/examples.test.ts` (it already imports `EXAMPLES`, `C64`, `compile`, defines `boot(source, frames)`):

```ts
describe('asm example', () => {
  const src = () => EXAMPLES.find((e) => e.id === 'asm')!.source;

  it('fills the screen with solid blocks and cycles four colour bands', () => {
    const early = boot(src(), 20);
    for (const addr of [0x0400, 0x05ff, 0x07e7]) expect(early.peek(addr)).toBe(0xa0);
    const bands = (c: C64) => [0xd800, 0xd900, 0xda00, 0xdb00].map((a) => c.peek(a) & 0x0f);
    const a = bands(early);
    const b = bands(boot(src(), 60));
    expect(b).not.toEqual(a);
    // four neighbouring colours: each band is the previous one + 1 (mod 16)
    expect(a[1]).toBe((a[0]! + 1) & 15);
    expect(a[2]).toBe((a[0]! + 2) & 15);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run test/website/examples.test.ts`
Expected: FAIL — `EXAMPLES.find(...)` is undefined.

- [ ] **Step 3: Add the example**

In `website/js/playground-examples.js`, add this entry to `EXAMPLES` (after the `slideshow` entry):

```js
  {
    id: 'asm',
    title: 'Inline assembly',
    source: `// asm {} drops to raw 6502. \${name} brings in program variables and constants.
let @zp shade: u8 = 0;

program @ 0x0810 {
  // Fill the screen with solid blocks once.
  asm {
    lda #$A0
    ldx #0
  fill:
    sta \${screen(0, 0)},x
    sta \${screen(0, 0) + 256},x
    sta \${screen(0, 0) + 512},x
    sta \${screen(0, 0) + 744},x
    inx
    bne fill
  }

  loop {
    while (VIC2.rasterLine != 200) {}
    while (VIC2.rasterLine == 200) {}

    shade++;

    // Four colour bands, each one step further along the palette.
    asm {
      ldx #0
    paint:
      lda \${shade}
      sta \${color(0, 0)},x
      clc
      adc #1
      sta \${color(0, 0) + 256},x
      adc #1
      sta \${color(0, 0) + 512},x
      adc #1
      sta \${color(0, 0) + 744},x
      inx
      bne paint
    }
  }
}
`,
  },
```

(The `\${` escapes are required because the program text lives in a JavaScript template literal.)

- [ ] **Step 4: Highlighter**

In `website/js/c64script-grammar.js`: add `clobbers` to the keyword alternation, `$`-hex to numbers, and an `instruction` token placed before `number`:

```js
  instruction: {
    pattern:
      /\b(?:adc|and|asl|bcc|bcs|beq|bit|bmi|bne|bpl|brk|bvc|bvs|clc|cld|cli|clv|cmp|cpx|cpy|dec|dex|dey|eor|inc|inx|iny|jmp|jsr|lda|ldx|ldy|lsr|nop|ora|pha|php|pla|plp|rol|ror|rti|rts|sbc|sec|sed|sei|sta|stx|sty|tax|tay|tsx|txa|txs|tya)\b(?=\s+[#$(\w{]|\s*$)/i,
    alias: 'function',
  },
```
and change `number` to `/\$[0-9a-fA-F]+\b|\b0x[0-9a-fA-F]+\b|\b\d+\b/`.

(The lookahead keeps words like `and` in comments out and only matches instruction-like positions.)

- [ ] **Step 5: Language reference**

In `website/c64script.html`:
1. Add a new section **before** the "Type system" section: heading `Inline assembly`, a short paragraph (what `asm {}` is; one instruction per line; labels end with `:`; `${name}` / `${expr}` for program symbols; `$HEX`, `0x`, decimals and `'H'` literals; `lo()`/`hi()` and `+ n` offsets; official 6502 opcodes only; `clobbers(A, X, Y, flags)` accepted), then one `terminal` block with `<pre data-try>` containing the example from the spec:

```
// Fill screen RAM with a solid block
program @ 0x0810 {
  asm {
    lda #$A0
    ldx #0
  fill:
    sta ${screen(0, 0)},x
    sta ${screen(0, 0) + 256},x
    sta ${screen(0, 0) + 512},x
    sta ${screen(0, 0) + 744},x
    inx
    bne fill
  }
  loop {}
}
```
   (HTML-escape `$`-free text normally; `{`/`}` need no escaping; keep the `cm`/`kw`/`nu`/`fn` span classes used by neighbouring samples.)
2. Update the "No arrays" roadmap chip text: replace "Array indexing and `asm {}` parse but are a compile error for now, rather than silently producing nothing." with "Array indexing parses but is a compile error for now. Use `asm {}` with `,x` / `,y` indexed addressing in the meantime."
3. In the built-in functions area nothing changes.

- [ ] **Step 6: Run tests**

Run: `npm test`
Expected: PASS — `docs-samples.test.ts` compiles the new `data-try` block; `examples.test.ts` runs the new example.

- [ ] **Step 7: Commit**

```bash
npx prettier --write test/website/examples.test.ts website/js/c64script-grammar.js
npx eslint website/js/c64script-grammar.js test/website/examples.test.ts
git add website test/website
git commit -m "docs(website): inline assembly reference, playground example, highlighter" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Verification and hand-off

**Files:** none (verification; fixes go back to the owning task's files).

- [ ] **Step 1: Everything**

```bash
npm test 2>&1 | tail -8
npm run typecheck
npx eslint src test website/js/c64script-grammar.js website/js/playground-examples.js
```
Expected: all pass; ESLint clean for these paths.

- [ ] **Step 2: Browser**

```bash
npm run build && mkdir -p website/dist && cp dist/f6502.min.js website/dist/
PORT=8080 node scripts/serve.mjs &
```
In a browser at `http://localhost:8080/website/playground.html`:
1. Choose **Inline assembly**: status `Compiled · … bytes`; the screen is solid blocks in four colour bands that cycle.
2. Replace the source with `program @ 0x0810 {\n  asm {\n    frob\n  }\n  loop {}\n}` and Run: red status `[3:0] unknown instruction 'frob'`, line 3 marked, the previous program keeps running.
3. `http://localhost:8080/website/c64script.html`: the "Inline assembly" section renders and its Try-now opens the playground with that program running.
Stop the server (`kill %1`).

- [ ] **Step 3: Report, then ask before publishing**

Summarise what was built and verified. Create the GitHub issue, push `feat/c64script-asm` and open the PR only after the user confirms (project rule: every PR has an issue).

Follow-ups to mention: `.byte`/`.word` directives; porting the Nyan Cat showcase (now unblocked); runtime `screen(row, col)` via asm tables.
