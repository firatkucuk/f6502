# Naming Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the naming issues identified by the Fable analysis: broken public APIs, global-shadow hazards, duplicated constants, unclear field names, and mechanical consistency sweeps.

**Architecture:** Every change is a rename or deletion — no new logic. The TypeScript compiler and the test suite are the verification oracle for every task. Tasks are ordered by blast radius (smallest first), so each commit leaves the project in a working state.

**Tech Stack:** TypeScript 5, Node.js test runner (`npm test`), ESLint (`npm run lint`), `tsc --noEmit` (`npm run typecheck`).

**Spec:** See Fable analysis report (delivered in conversation on 2026-10-11); priority order is from section "Cross-cutting findings".

## Global Constraints

- Every task must leave `npm test`, `npm run typecheck`, and `npm run lint` green before committing.
- No behavioral changes — pure renames and dead-code removal only.
- Preserve all public exports (anything re-exported from `src/index.ts`) under their existing *public* names unless the task explicitly retires one.
- Run commands from the repo root: `/Users/fkucuk/Projects/f6502`.

## Review Focus

The five failure modes most likely to bite a person after this rename work:

1. **`instanceof TypeError` in catch blocks** — after the class rename any `catch (e) { if (e instanceof TypeError) }` in calling code breaks silently (catches the JS global instead). Check `test/` for such guards.
2. **`Symbol` iterator protocol** — `interface Symbol` rename; if any code spreads or iterates something typed as `Symbol`, renaming to `C64Symbol` causes a type error the compiler surfaces, but double-check test helpers.
3. **Barrel re-exports** — `src/c64script/index.ts` re-exports `TypeError as C64ScriptTypeError`; after the class rename the alias becomes a no-op identity re-export. Confirm the barrel still compiles and that downstream `src/index.ts` exports `C64ScriptTypeError` correctly.
4. **Discriminant exhaustiveness** — Task 9 renames `kind` → `tag` on five union types. Any switch without a `default:` that the TypeScript compiler already considers exhaustive will break if a variant is missed; `tsc` will catch this, but verify every switch statement is covered.
5. **File-rename import paths** — renaming `container.ts` to `sources.ts` and the two `keymap`/`keyqueue` files must update every import string; a missed import silently becomes `any` only if `noImplicitAny` is off. After each rename, run `npm run typecheck` before committing.

---

## Task 1: Test name consistency

**Files:**
- Modify: `test/c64script/screen-helpers.test.ts:42`
- Modify: `test/c64script/text.test.ts:49,58,74`
- Modify: `test/machine/sid.test.ts` (one `describe` name)

**Interfaces:**
- Consumes: nothing
- Produces: nothing (test-only change)

- [ ] **Step 1: Fix the four `'reject …'` → `'rejects …'` it-names**

In `test/c64script/screen-helpers.test.ts:42`:
```ts
// before
it('reject a row or column off the screen, at the call', () => {
// after
it('rejects a row or column off the screen, at the call', () => {
```

In `test/c64script/text.test.ts:49,58,74`:
```ts
// before
it('reject lowercase letters, naming the uppercase one', () => {
it('reject empty, multi-character and unterminated literals', () => {
it('reject characters without a screen code and unknown escapes', () => {
// after
it('rejects lowercase letters, naming the uppercase one', () => {
it('rejects empty, multi-character and unterminated literals', () => {
it('rejects characters without a screen code and unknown escapes', () => {
```

- [ ] **Step 2: Fix the `describe` casing inconsistency for SID registers**

Find `test/machine/sid.test.ts` and locate `describe('Sid registers'` — change to `describe('SID registers'` to match `test/c64script/builtins.test.ts`.

- [ ] **Step 3: Run tests and verify they pass**

```bash
npm test -- --reporter=verbose 2>&1 | grep -E "FAIL|PASS|Error" | tail -10
```
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add test/c64script/screen-helpers.test.ts test/c64script/text.test.ts test/machine/sid.test.ts
git commit -m "test: fix 'reject' → 'rejects' in it-names; 'Sid' → 'SID' in describe"
```

---

## Task 2: `C64.credit` → `pendingCycles`

**Files:**
- Modify: `src/machine/c64.ts:48,134,142,143`

**Interfaces:**
- Consumes: nothing external (private field)
- Produces: nothing external

- [ ] **Step 1: Rename the private field**

In `src/machine/c64.ts`, make these three changes:

Line 48:
```ts
// before
private credit = 0;
// after
private pendingCycles = 0;
```

Line 134:
```ts
// before
this.credit = 0;
// after
this.pendingCycles = 0;
```

Lines 142–143:
```ts
// before
this.credit += n;
while (this.credit > 0) this.credit -= this.stepCpu();
// after
this.pendingCycles += n;
while (this.pendingCycles > 0) this.pendingCycles -= this.stepCpu();
```

- [ ] **Step 2: Typecheck and test**

```bash
npm run typecheck && npm test
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/machine/c64.ts
git commit -m "refactor(machine): rename C64.credit to pendingCycles"
```

---

## Task 3: Deduplicate `CYCLES_PER_FRAME`

**Files:**
- Modify: `src/browser/clock.ts` — remove local constant, import from machine

**Interfaces:**
- Consumes: `CYCLES_PER_FRAME` exported from `src/machine/c64.ts:32`
- Produces: nothing new

- [ ] **Step 1: Update `clock.ts` to import the constant**

Replace the local constant definition in `src/browser/clock.ts`:

```ts
// before (top of file)
const CYCLES_PER_SECOND = 985_248;
const CYCLES_PER_FRAME = 19_656;

// after
import { CYCLES_PER_FRAME } from '../machine/c64';
const CYCLES_PER_SECOND = 985_248;
```

- [ ] **Step 2: Typecheck and test**

```bash
npm run typecheck && npm test
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/browser/clock.ts
git commit -m "refactor(browser): deduplicate CYCLES_PER_FRAME — import from machine"
```

---

## Task 4: Deduplicate `escapeHtml` in website

**Files:**
- Modify: `website/js/home-slideshow.js` — remove local copy, import from `editor-render.js`
- Modify: `website/js/showcase.js` — remove local copy, import from `editor-render.js`

**Interfaces:**
- Consumes: `escapeHtml` exported from `website/js/editor-render.js:4`
- Produces: nothing new

- [ ] **Step 1: Remove local copy from `home-slideshow.js` and import**

In `website/js/home-slideshow.js`, remove the local `escapeHtml` function (lines 15–20) and add an import at the top:

```js
import { escapeHtml } from './editor-render.js';
```

Verify the existing call on line 23 still compiles/runs correctly.

- [ ] **Step 2: Remove local copy from `showcase.js` and import**

In `website/js/showcase.js`, remove the local `escapeHtml` function (lines 25–30) and add an import:

```js
import { escapeHtml } from './editor-render.js';
```

Verify the call on line 49 is unchanged.

- [ ] **Step 3: Run tests**

```bash
npm test
```

Then open the dev server and verify showcases still render:
```bash
node scripts/serve.mjs &
# open http://localhost:3000/showcases.html in browser — check one card loads
```

- [ ] **Step 4: Commit**

```bash
git add website/js/home-slideshow.js website/js/showcase.js
git commit -m "refactor(website): deduplicate escapeHtml — import from editor-render.js"
```

---

## Task 5: Rename `TypeError` → `C64ScriptTypeError` at its source

This removes the shadowing of the JavaScript global `TypeError`.

**Files:**
- Modify: `src/c64script/errors.ts:18-19` — rename the class
- Modify: `src/c64script/checker.ts:1` — update import
- Modify: `src/c64script/symbols.ts:1` — update import
- Modify: `src/c64script/index.ts:22` — simplify re-export (alias becomes identity)
- Modify: `src/index.ts:10` — update re-export name

**Interfaces:**
- Consumes: nothing new
- Produces: public export `C64ScriptTypeError` from `src/index.ts` stays identical

- [ ] **Step 1: Rename the class in `errors.ts`**

```ts
// before
export class TypeError extends C64ScriptError {
  constructor(msg: string, line: number, col: number) { super(msg, line, col); this.name = 'TypeError'; }
}
// after
export class C64ScriptTypeError extends C64ScriptError {
  constructor(msg: string, line: number, col: number) { super(msg, line, col); this.name = 'C64ScriptTypeError'; }
}
```

- [ ] **Step 2: Update `checker.ts`**

Line 1:
```ts
// before
import { TypeError } from './errors';
// after
import { C64ScriptTypeError as TypeError } from './errors';
```

(Keep the local alias `TypeError` inside `checker.ts` to avoid a 35-line diff — the public name is fixed, the internal alias is an implementation detail.)

- [ ] **Step 3: Update `symbols.ts`**

Line 1:
```ts
// before
import { TypeError } from './errors';
// after
import { C64ScriptTypeError as TypeError } from './errors';
```

- [ ] **Step 4: Update the barrel `src/c64script/index.ts`**

Line 22:
```ts
// before
export { C64ScriptError, LexError, ParseError, TypeError, CodeGenError } from './errors';
// after
export { C64ScriptError, LexError, ParseError, C64ScriptTypeError, CodeGenError } from './errors';
```

- [ ] **Step 5: Update `src/index.ts`**

Line 10:
```ts
// before
  TypeError as C64ScriptTypeError,
// after
  C64ScriptTypeError,
```

- [ ] **Step 6: Check for `instanceof TypeError` in tests**

```bash
grep -rn "instanceof TypeError" test/ src/
```
Expected: no hits (the old class name should be gone). If any test catches `TypeError` and checks its instance, update them to `C64ScriptTypeError`.

- [ ] **Step 7: Typecheck and test**

```bash
npm run typecheck && npm test
```

- [ ] **Step 8: Commit**

```bash
git add src/c64script/errors.ts src/c64script/checker.ts src/c64script/symbols.ts src/c64script/index.ts src/index.ts
git commit -m "refactor(c64script): rename TypeError → C64ScriptTypeError to avoid JS global shadow"
```

---

## Task 6: Rename `Symbol` → `C64Symbol` to avoid JS global shadow

**Files:**
- Modify: `src/c64script/symbols.ts:10,17,22,24,28,29` — rename the interface
- Modify: any file that imports `Symbol` from `./symbols`

**Interfaces:**
- Consumes: nothing new
- Produces: `C64Symbol` interface, `SymbolTable` uses it internally

- [ ] **Step 1: Find all import sites**

```bash
grep -rn "import.*Symbol\b.*from.*symbols\|import.*{ Symbol" src/ --include="*.ts"
```

- [ ] **Step 2: Rename the interface in `symbols.ts`**

```ts
// before
export interface Symbol {
  name: string;
  sym: SymbolKind;
  line: number;
}

export class SymbolTable {
  private readonly scopes: Map<string, Symbol>[] = [new Map()];
  ...
  define(sym: Symbol): void {
  ...
  resolve(name: string): Symbol | undefined {
// after
export interface C64Symbol {
  name: string;
  sym: SymbolKind;
  line: number;
}

export class SymbolTable {
  private readonly scopes: Map<string, C64Symbol>[] = [new Map()];
  ...
  define(sym: C64Symbol): void {
  ...
  resolve(name: string): C64Symbol | undefined {
```

- [ ] **Step 3: Update all import sites**

For each file importing `Symbol` from `./symbols` (found in Step 1), update to `C64Symbol`. Typical pattern:
```ts
// before
import type { Symbol } from './symbols';
// after
import type { C64Symbol } from './symbols';
```
And update all local usages of `Symbol` as a type name in that file.

- [ ] **Step 4: Typecheck and test**

```bash
npm run typecheck && npm test
```

- [ ] **Step 5: Commit**

```bash
git add src/c64script/symbols.ts
# plus any other modified files from step 3
git commit -m "refactor(c64script): rename Symbol → C64Symbol to avoid JS global shadow"
```

---

## Task 7: Remove dead `CompileOpts` API

`compile(source, _opts?)` is the only public function in `src/c64script/index.ts`. The `CompileOpts.loadAddr` option is documented but the parameter is named `_opts` and never read. Remove the option type and simplify the signature.

**Files:**
- Modify: `src/c64script/index.ts` — remove `CompileOpts`, simplify `compile` signature
- Modify: `src/index.ts` — remove `CompileOpts` from re-exports

**Interfaces:**
- Consumes: nothing
- Produces: `compile(source: string): Uint8Array` — narrowed signature

- [ ] **Step 1: Check that `CompileOpts` is not used in tests or app code**

```bash
grep -rn "CompileOpts\|loadAddr" test/ website/ --include="*.ts" --include="*.js"
```
Expected: no hits. If any test passes `loadAddr`, note it — it currently has no effect, but update the test comment.

- [ ] **Step 2: Remove `CompileOpts` and simplify `compile`**

In `src/c64script/index.ts`:
```ts
// before
export interface CompileOpts {
  /** Override load address (default taken from program block). */
  loadAddr?: number;
}

export function compile(source: string, _opts?: CompileOpts): Uint8Array {
// after
export function compile(source: string): Uint8Array {
```

Remove the `type { CompileOpts }` re-export from line 11 of `src/c64script/index.ts`.

- [ ] **Step 3: Remove from `src/index.ts`**

Remove `type CompileOpts,` from the `src/index.ts` re-export block.

- [ ] **Step 4: Typecheck and test**

```bash
npm run typecheck && npm test
```

- [ ] **Step 5: Commit**

```bash
git add src/c64script/index.ts src/index.ts
git commit -m "refactor(c64script): remove dead CompileOpts — loadAddr was never implemented"
```

---

## Task 8: Sub-component class prefixes

`Voice`, `Envelope`, and `Sprites` are ambiguous when imported. Rename to `SidVoice`, `SidEnvelope`, `VicSprites`.

**Files:**
- Modify: `src/machine/sid-voice.ts:11` — rename class
- Modify: `src/machine/sid-envelope.ts:11` — rename class
- Modify: `src/machine/vic-sprites.ts:13` — rename class
- Modify: `src/machine/sid.ts:2,5` — update imports
- Modify: `src/machine/vic.ts:5` — update import

**Interfaces:**
- Consumes: `Voice` from `sid-voice.ts`, `Envelope` from `sid-envelope.ts`, `Sprites` from `vic-sprites.ts`
- Produces: `SidVoice`, `SidEnvelope`, `VicSprites` — not exported from the public barrel

- [ ] **Step 1: Confirm none of these are re-exported publicly**

```bash
grep -n "Voice\|Envelope\|Sprites" src/machine/index.ts src/index.ts
```
Expected: no hits (all three are internal). If any are exported, add an alias to the public barrel before renaming.

- [ ] **Step 2: Rename `Voice` → `SidVoice` in `sid-voice.ts`**

```ts
// before
export class Voice {
  ...
  source: Voice = this;
// after
export class SidVoice {
  ...
  source: SidVoice = this;
```

- [ ] **Step 3: Rename `Envelope` → `SidEnvelope` in `sid-envelope.ts`**

```ts
// before
export class Envelope {
// after
export class SidEnvelope {
```

- [ ] **Step 4: Rename `Sprites` → `VicSprites` in `vic-sprites.ts`**

```ts
// before
export class Sprites {
// after
export class VicSprites {
```

- [ ] **Step 5: Update `sid.ts` imports and usages**

```ts
// before
import { Envelope } from './sid-envelope';
import { Voice } from './sid-voice';
// after
import { SidEnvelope as Envelope } from './sid-envelope';
import { SidVoice as Voice } from './sid-voice';
```

(Using local aliases keeps the 200+ internal usages inside `sid.ts` unchanged — this is a scoped rename, not a codebase-wide search-and-replace.)

- [ ] **Step 6: Update `vic.ts` import**

```ts
// before
import { Sprites } from './vic-sprites';
// after
import { VicSprites as Sprites } from './vic-sprites';
```

- [ ] **Step 7: Typecheck and test**

```bash
npm run typecheck && npm test
```

- [ ] **Step 8: Commit**

```bash
git add src/machine/sid-voice.ts src/machine/sid-envelope.ts src/machine/vic-sprites.ts src/machine/sid.ts src/machine/vic.ts
git commit -m "refactor(machine): prefix sub-component classes — Voice→SidVoice, Envelope→SidEnvelope, Sprites→VicSprites"
```

---

## Task 9: File renames — `keymap`, `keyqueue`, `container`

**Files:**
- Rename: `src/browser/keymap.ts` → `src/browser/key-map.ts`
- Rename: `src/browser/keyqueue.ts` → `src/browser/key-queue.ts`
- Rename: `src/machine/container.ts` → `src/machine/sources.ts`
- Modify: `src/browser/keyqueue.ts` (now `key-queue.ts`) — update import of `keymap`
- Modify: `src/browser/player.ts` — update imports of both files
- Modify: `src/machine/drive.ts` — update import of `container`
- Modify: `src/machine/index.ts` — update re-export of `container`
- Modify: `src/browser/player.ts` — update import of `container`

**Interfaces:**
- Consumes: all the same exports, just different file paths
- Produces: same

- [ ] **Step 1: Rename the files**

```bash
cd /Users/fkucuk/Projects/f6502
git mv src/browser/keymap.ts   src/browser/key-map.ts
git mv src/browser/keyqueue.ts src/browser/key-queue.ts
git mv src/machine/container.ts src/machine/sources.ts
```

- [ ] **Step 2: Update `src/browser/key-queue.ts`**

```ts
// before
import type { KeySink } from './keymap';
// after
import type { KeySink } from './key-map';
```

- [ ] **Step 3: Update `src/browser/player.ts`**

```ts
// before
import { KeyMapper, type KeyEventLike } from './keymap';
import { KeyQueue } from './keyqueue';
// after
import { KeyMapper, type KeyEventLike } from './key-map';
import { KeyQueue } from './key-queue';
```

- [ ] **Step 4: Update `src/machine/drive.ts`**

```ts
// before
import { D64Source, directoryProgram, matchName, type FileSource } from './container';
// after
import { D64Source, directoryProgram, matchName, type FileSource } from './sources';
```

- [ ] **Step 5: Update `src/machine/index.ts`**

```ts
// before
export { openSource, type FileSource } from './container';
// after
export { openSource, type FileSource } from './sources';
```

- [ ] **Step 6: Update `src/browser/player.ts` (container import)**

```ts
// before
import { openSource } from '../machine/container';
// after
import { openSource } from '../machine/sources';
```

- [ ] **Step 7: Typecheck and test**

```bash
npm run typecheck && npm test
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: rename keymap→key-map, keyqueue→key-queue, container→sources (kebab-case consistency)"
```

---

## Task 10: Compiler discriminant unification — `kind` → `tag`

Five union types in the compiler use `kind` as their discriminant while the rest of the AST uses `tag`. Unify on `tag`. This is the highest-risk task; do it last.

Affected types:
- `VarAnnotation` in `src/c64script/ast.ts:40-43` (3 `.kind` reads in `checker.ts`)
- `AsmOperand` in `src/c64script/ast.ts:89-96` (many reads in `codegen.ts`)
- `AsmItem` in `src/c64script/ast.ts:98-106` (reads in `codegen.ts`, `checker.ts`)
- `FixupKind` in `src/c64script/codegen.ts:10-15` (reads in `linker.ts`; fixes `fixup.kind.kind`)
- `SymbolKind` in `src/c64script/symbols.ts:3-8` (reads in `checker.ts`, `codegen.ts`)

**Files:**
- Modify: `src/c64script/ast.ts` — rename discriminant field in `VarAnnotation`, `AsmOperand`, `AsmItem`
- Modify: `src/c64script/codegen.ts` — rename discriminant field in `FixupKind`; update all `.kind` reads
- Modify: `src/c64script/symbols.ts` — rename discriminant field in `SymbolKind`
- Modify: `src/c64script/checker.ts` — update all `.kind` reads for `VarAnnotation`, `AsmItem`, `SymbolKind`
- Modify: `src/c64script/linker.ts` — update `.kind` reads for `FixupKind`

**Interfaces:**
- Consumes: all five union types — read only through type narrowing
- Produces: same five types with `tag` discriminant

- [ ] **Step 1: Update `VarAnnotation` in `ast.ts`**

```ts
// before
export type VarAnnotation =
  | { readonly kind: 'none' }
  | { readonly kind: 'zp' }
  | { readonly kind: 'addr'; readonly address: Expr };
// after
export type VarAnnotation =
  | { readonly tag: 'none' }
  | { readonly tag: 'zp' }
  | { readonly tag: 'addr'; readonly address: Expr };
```

- [ ] **Step 2: Update `AsmOperand` in `ast.ts`**

```ts
// before
export type AsmOperand =
  | { readonly kind: 'none' }
  | { readonly kind: 'acc' }
  | { readonly kind: 'imm'; readonly value: AsmExpr }
  | { readonly kind: 'addr'; readonly value: AsmExpr; readonly index: 'x' | 'y' | null }
  | { readonly kind: 'izx'; readonly value: AsmExpr }
  | { readonly kind: 'izy'; readonly value: AsmExpr }
  | { readonly kind: 'ind'; readonly value: AsmExpr };
// after
export type AsmOperand =
  | { readonly tag: 'none' }
  | { readonly tag: 'acc' }
  | { readonly tag: 'imm'; readonly value: AsmExpr }
  | { readonly tag: 'addr'; readonly value: AsmExpr; readonly index: 'x' | 'y' | null }
  | { readonly tag: 'izx'; readonly value: AsmExpr }
  | { readonly tag: 'izy'; readonly value: AsmExpr }
  | { readonly tag: 'ind'; readonly value: AsmExpr };
```

- [ ] **Step 3: Update `AsmItem` in `ast.ts`**

```ts
// before
export type AsmItem =
  | { readonly kind: 'label'; readonly name: string; readonly line: number }
  | {
      readonly kind: 'instr';
      ...
    };
// after
export type AsmItem =
  | { readonly tag: 'label'; readonly name: string; readonly line: number }
  | {
      readonly tag: 'instr';
      ...
    };
```

- [ ] **Step 4: Update `FixupKind` in `codegen.ts`**

```ts
// before
export type FixupKind =
  | { kind: 'branch8'; label: string }
  | { kind: 'abs16'; label: string }
  | { kind: 'zpByte'; varName: string }
  | { kind: 'absHiByte'; label: string }
  | { kind: 'absLoByte'; label: string };
// after
export type FixupKind =
  | { tag: 'branch8'; label: string }
  | { tag: 'abs16'; label: string }
  | { tag: 'zpByte'; varName: string }
  | { tag: 'absHiByte'; label: string }
  | { tag: 'absLoByte'; label: string };
```

- [ ] **Step 5: Update `SymbolKind` in `symbols.ts`**

```ts
// before
export type SymbolKind =
  | { kind: 'var';      zpAddr: number | null; absAddr: number | null; isConst: boolean }
  | { kind: 'fn';       isInline: boolean }
  | { kind: 'hardware'; base: number }
  | { kind: 'struct' }
  | { kind: 'color';    value: number };
// after
export type SymbolKind =
  | { tag: 'var';      zpAddr: number | null; absAddr: number | null; isConst: boolean }
  | { tag: 'fn';       isInline: boolean }
  | { tag: 'hardware'; base: number }
  | { tag: 'struct' }
  | { tag: 'color';    value: number };
```

- [ ] **Step 6: Run typecheck — let the compiler find all broken read sites**

```bash
npm run typecheck 2>&1 | grep "\.kind" | head -40
```

The TypeScript compiler will report every line that still reads `.kind` on one of these five types. Work through each error:
- In `checker.ts`: change `ann.kind`, `d.annotation.kind`, `item.kind`, `sym.sym.kind` → `.tag`
- In `codegen.ts`: change `op.kind`, `item.kind`, `fix.kind` (the `FixupKind` discriminant, now `.tag`), `sym.sym.kind` → `.tag`
- In `linker.ts`: change `fix.kind.kind` → `fix.kind.tag`
- Anywhere else reported

Literal objects that set the discriminant also need updating, e.g.:
```ts
// before
const ann: VarAnnotation = { kind: 'none' };
// after
const ann: VarAnnotation = { tag: 'none' };
```

- [ ] **Step 7: Typecheck clean**

```bash
npm run typecheck
```
Expected: 0 errors.

- [ ] **Step 8: Run the full test suite**

```bash
npm test
```
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add src/c64script/ast.ts src/c64script/codegen.ts src/c64script/symbols.ts src/c64script/checker.ts src/c64script/linker.ts
git commit -m "refactor(c64script): unify discriminant field kind → tag across VarAnnotation, AsmOperand, AsmItem, FixupKind, SymbolKind"
```
