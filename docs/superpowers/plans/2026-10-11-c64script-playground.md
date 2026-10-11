# C64Script Playground Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A website playground page where visitors write C64Script, press Run, and see it run in the emulator, plus "Try now" buttons on the site's C64Script samples that open the playground with that sample loaded.

**Architecture:** Export the existing C64Script compiler from the main bundle (`F6502.compile`). The playground is a static page (textarea over a Prism-highlighted `<pre>`) that compiles in the browser and loads the PRG into one reused `Player`. Samples travel to the playground in the URL hash (`#code=<base64url>`). Website docs are rewritten to the dialect the compiler really implements, and a test compiles every `data-try` block so docs cannot drift.

**Tech Stack:** TypeScript (compiler, vitest), plain ES-module JS for the site (no build step), Prism 1.29 from cdnjs (already used on `demos/nyancat.html`).

**Spec:** `docs/superpowers/specs/2026-10-11-c64script-playground-design.md`

## Global Constraints

- The compiler is the source of truth for C64Script syntax: `program @ 0x0810 { … }`, `let @zp x: u8 = 0;`, `VIC2.borderColor`, `u8`/`u16`. Never write `program(0x0810)`, `var`, `byte`, `word`, `c64.border` in a sample or in docs.
- Prettier config: single quotes, `printWidth` 100, `trailingComma: all`. Run `npx prettier --write` on **new or changed source/test files only**; never `prettier --write .` (29 website files already fail prettier and must not be reformatted in this change).
- Baselines before this work: `npm run typecheck` passes; `npx vitest run test/c64script` = 63 passing; `npx eslint .` has 32 pre-existing errors in `website/js/app.js`, `website/js/demo.js`, `examples/` (do not fix them; new files must add none).
- Site JS is plain ES modules, no bundler, no new dependencies.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; pull request descriptions end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Every PR needs a GitHub issue first (project rule). Creating the issue / pushing / opening the PR is outward-facing: confirm with the user before doing it (Task 7).
- Work on branch `feat/c64script-playground`, never on `main`.
- Out of scope: the nyancat showcase stays on its prebuilt PRG (`website/demos/nyancat.prg`, `scripts/build-nyancat-prg.mjs`, CI step). Do not touch them or `website/demos/nyancat.html`'s source panel beyond the nav link in Task 5.

## Review Focus

Failure modes the spec implies that no single task's happy path covers (each is pinned in the task named):

1. A sample containing non-ASCII characters (e.g. `—`, `→`, emoji in a comment) must survive Try-now → hash → playground unchanged. (Task 3 test)
2. A garbage, truncated, invalid-base64 or invalid-UTF-8 `#code=` hash must load the default example, never throw or show a blank editor. (Task 3 test)
3. `poke()` with a non-constant address used to compile to nothing silently; it must now be a located compile error, and `poke(const, expr)` must store the evaluated value. (Task 2 tests)
4. `clrscr()` used to run off the end of the program (branch offset off by one); it must clear the screen **and** continue to the next statement. (Task 2 test)
5. Pasted source with Windows line endings (`\r\n`) must compile and report the right line numbers. (Task 5 normalises in the playground; Task 1 test covers the compiler)
6. A program that never returns (`loop {}`) followed by Run again, and a syntax error after a good run (emulator keeps the previous program, error clears on the next good Run). (Task 7 browser checks)

## File Structure

| File | Responsibility |
|---|---|
| `src/index.ts` | Public export of the compiler (Task 1) |
| `src/c64script/index.ts` | Also export `C64ScriptError` (Task 1) |
| `src/c64script/codegen.ts` | `clrscr` branch offsets, `poke` semantics (Task 2) |
| `package.json` | `test` script also runs `test/c64script` and `test/website` (Task 1) |
| `eslint.config.js` | Browser globals for the new site modules (Task 3) |
| `website/js/code-hash.js` | Encode/decode source ⇄ `#code=` hash (Task 3) |
| `website/js/playground-examples.js` | Example programs for the dropdown (Task 4) |
| `website/playground.html`, `website/js/playground.js` | The playground page (Task 5) |
| `website/js/try-now.js`, `website/css/style.css` | "Try now" buttons (Task 6) |
| `website/{index,usage,showcases,c64script}.html` | Docs rewritten + `data-try` marks (Task 6) |
| `test/c64script/public-api.test.ts`, `test/c64script/builtins.test.ts` | Compiler tests (Tasks 1–2) |
| `test/website/code-hash.test.ts`, `examples.test.ts`, `docs-samples.test.ts` | Site tests (Tasks 3, 4, 6) |

---

### Task 0: Branch

- [ ] **Step 1: Create the branch**

```bash
cd /home/firat/Projects/firat/f6502
git switch -c feat/c64script-playground
git status --short
```
Expected: `?? docs/superpowers/specs/2026-10-11-c64script-playground-design.md` and `?? docs/superpowers/plans/2026-10-11-c64script-playground.md` only.

- [ ] **Step 2: Commit the spec and plan**

```bash
git add docs/superpowers/specs/2026-10-11-c64script-playground-design.md docs/superpowers/plans/2026-10-11-c64script-playground.md
git commit -m "docs: C64Script playground design and plan" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 1: Export the compiler from the public bundle

**Files:**
- Modify: `src/c64script/index.ts`
- Modify: `src/index.ts`
- Modify: `package.json` (the `test` script)
- Create: `test/c64script/public-api.test.ts`

**Interfaces:**
- Produces: `compile(source: string): Uint8Array`, `C64ScriptError` (fields `line`, `col`), `LexError`, `ParseError`, `CodeGenError`, `C64ScriptTypeError` all exported from `src/index.ts` (so `F6502.compile`, `F6502.C64ScriptError` in the IIFE bundle). Later tasks rely on exactly these names.

- [ ] **Step 1: Write the failing test**

Create `test/c64script/public-api.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import * as api from '../../src/index';

describe('public API: C64Script compiler', () => {
  it('exports compile and the error classes', () => {
    expect(typeof api.compile).toBe('function');
    expect(typeof api.C64ScriptError).toBe('function');
    for (const E of [api.LexError, api.ParseError, api.CodeGenError, api.C64ScriptTypeError]) {
      expect(E.prototype).toBeInstanceOf(api.C64ScriptError);
    }
  });

  it('does not export a class named TypeError (it would shadow the global)', () => {
    expect('TypeError' in api).toBe(false);
  });

  it('compiles to a PRG whose first two bytes are the load address', () => {
    const prg = api.compile('program @ 0x0810 { loop {} }');
    expect(prg[0]).toBe(0x10);
    expect(prg[1]).toBe(0x08);
    expect(prg.length).toBeGreaterThan(2);
  });

  it('reports line and column on a syntax error', () => {
    try {
      api.compile('// first line\nprogram(0x0810) { loop {} }');
      expect.unreachable('compile should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(api.C64ScriptError);
      expect((err as InstanceType<typeof api.C64ScriptError>).line).toBe(2);
    }
  });

  it('accepts Windows line endings and keeps line numbers right', () => {
    const ok = api.compile('// c\r\nprogram @ 0x0810 {\r\n  loop {}\r\n}\r\n');
    expect(ok[0]).toBe(0x10);
    try {
      api.compile('// c\r\n// d\r\nprogram(0x0810) { loop {} }\r\n');
      expect.unreachable('compile should have thrown');
    } catch (err) {
      expect((err as InstanceType<typeof api.C64ScriptError>).line).toBe(3);
    }
  });

  it('throws a C64ScriptError (not a crash) for empty source', () => {
    expect(() => api.compile('')).toThrow();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run test/c64script/public-api.test.ts`
Expected: FAIL — `api.compile` is undefined / `typeof api.compile` is `'undefined'`.

- [ ] **Step 3: Export from the C64Script index**

In `src/c64script/index.ts`, replace the last three lines:

```ts
export { LexError, ParseError, TypeError, CodeGenError } from './errors';
export type { CheckedProgram } from './checker';
export type { Program } from './ast';
```
with
```ts
export { C64ScriptError, LexError, ParseError, TypeError, CodeGenError } from './errors';
export type { CheckedProgram } from './checker';
export type { Program } from './ast';
```

- [ ] **Step 4: Export from the package entry**

Append to `src/index.ts`:

```ts
export {
  compile,
  C64ScriptError,
  LexError,
  ParseError,
  CodeGenError,
  TypeError as C64ScriptTypeError,
  type CompileOpts,
} from './c64script';
```

- [ ] **Step 5: Run the test and the typecheck**

Run: `npx vitest run test/c64script/public-api.test.ts && npm run typecheck`
Expected: PASS (6 tests) and typecheck exits 0. If typecheck reports a duplicate export name (e.g. `CompileOpts` already exported by `./machine`), rename only the c64script one with `as C64ScriptCompileOptions` and update nothing else.

If the "Windows line endings" test fails because the lexer rejects `\r`, fix `tokenize` in `src/c64script/lexer.ts` to treat `\r` as whitespace (keep `\n` as the only line break), then re-run.

- [ ] **Step 6: Run c64script tests from `npm test`**

Edit `package.json`: change the `test` script to
```json
"test": "vitest run test/core test/machine test/browser test/c64script test/website",
```
(`test/website` does not exist yet; vitest ignores missing directory filters when other filters match. If `npm test` errors on the missing path, create an empty `test/website/.gitkeep`.)

Run: `npm test 2>&1 | tail -8`
Expected: all test files pass.

- [ ] **Step 7: Format and commit**

```bash
npx prettier --write src/index.ts test/c64script/public-api.test.ts
npx eslint src/index.ts test/c64script/public-api.test.ts
git add src/index.ts src/c64script/index.ts package.json test/c64script/public-api.test.ts
git add src/c64script/lexer.ts 2>/dev/null || true   # only changed if the CRLF fix in Step 5 was needed
git commit -m "feat(c64script): export the compiler from the public bundle" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Fix `clrscr()` and `poke()` in the compiler

**Files:**
- Modify: `src/c64script/codegen.ts` (`genClrscr` at ~line 115–145, `poke` branch of `genCall` at ~line 148)
- Create: `test/c64script/builtins.test.ts`

**Interfaces:**
- Consumes: `compile` from `src/c64script/index`, `CodeGenError` from `src/c64script/errors`.
- Produces: `poke(<constant address>, <any u8 expression>)` stores the value; `poke(<non-constant>, …)` throws `CodeGenError` with the call's line. `clrscr()` clears screen and colour RAM and falls through.

- [ ] **Step 1: Write the failing tests**

Create `test/c64script/builtins.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { C64 } from '../../src/machine/c64';
import { compile } from '../../src/c64script/index';
import { CodeGenError } from '../../src/c64script/errors';

function boot(src: string, frames = 3): C64 {
  const prg = compile(src);
  const load = prg[0]! | (prg[1]! << 8);
  const c64 = new C64({
    kernal: new Uint8Array(8192).fill(0xea),
    basic: new Uint8Array(8192),
    chargen: new Uint8Array(4096),
  });
  for (let i = 2; i < prg.length; i++) c64.pokeRam(load + i - 2, prg[i]!);
  c64.cpu.regs.pc = load;
  for (let f = 0; f < frames; f++) c64.runFrame();
  return c64;
}

describe('clrscr()', () => {
  it('clears all of screen RAM and then continues with the next statement', () => {
    const c64 = boot('program @ 0x0810 { clrscr(); VIC2.borderColor = 5; loop {} }');
    for (const addr of [0x0400, 0x0500, 0x05ef, 0x0600, 0x0700, 0x07e7]) {
      expect(c64.peek(addr), `screen RAM at $${addr.toString(16)}`).toBe(0x20);
    }
    expect(c64.peek(0xd020) & 0x0f).toBe(5); // proves execution did not run off the end
  });

  it('clears all of colour RAM', () => {
    const c64 = boot('program @ 0x0810 { clrscr(); loop {} }');
    for (const addr of [0xd800, 0xd900, 0xda00, 0xdb00, 0xdbe7]) {
      expect(c64.peek(addr) & 0x0f, `colour RAM at $${addr.toString(16)}`).toBe(0);
    }
  });
});

describe('poke()', () => {
  it('stores a constant value at a constant address', () => {
    const c64 = boot('program @ 0x0810 { poke(0x05ef, 8); loop {} }');
    expect(c64.peek(0x05ef)).toBe(8);
  });

  it('stores a variable value and an expression value', () => {
    const c64 = boot(`
      let @zp v: u8 = 7;
      program @ 0x0810 {
        poke(0x05ef, v);
        poke(0xd9ef, v + 1);
        loop {}
      }`);
    expect(c64.peek(0x05ef)).toBe(7);
    expect(c64.peek(0xd9ef) & 0x0f).toBe(8);
  });

  it('folds a constant address expression', () => {
    const c64 = boot('program @ 0x0810 { poke(0x0400 + 495, 9); loop {} }');
    expect(c64.peek(0x05ef)).toBe(9);
  });

  it('rejects a non-constant address with a located CodeGenError', () => {
    const src = 'let @zp a: u8 = 0;\nprogram @ 0x0810 {\n  poke(a, 1);\n  loop {}\n}';
    try {
      compile(src);
      expect.unreachable('compile should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CodeGenError);
      expect((err as CodeGenError).line).toBe(3);
      expect((err as CodeGenError).message).toMatch(/poke/);
    }
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run test/c64script/builtins.test.ts`
Expected: FAIL. `clrscr` tests fail (screen byte `0x05ef` is `255`, border is `0`); `poke` variable-value test fails (`0x05ef` is `255`); the non-constant-address test fails with "compile should have thrown".

- [ ] **Step 3: Fix the `clrscr` branch offsets**

In `src/c64script/codegen.ts`, in `genClrscr`, the four relative branches compute the offset from the branch opcode's own position. A 6502 relative branch is relative to the byte *after* the 2-byte instruction, so the subtraction must be `- 2`. Change all four lines:

```ts
emit(0xD0, (scrLoop - bytes.length - 1) & 0xFF); // BNE scrLoop
emit(0x10, (scrLoop2 - bytes.length - 1) & 0xFF); // BPL scrLoop2
emit(0xD0, (colLoop - bytes.length - 1) & 0xFF); // BNE colLoop
emit(0x10, (colLoop2 - bytes.length - 1) & 0xFF); // BPL colLoop2
```
to
```ts
emit(0xD0, (scrLoop - bytes.length - 2) & 0xFF); // BNE scrLoop
emit(0x10, (scrLoop2 - bytes.length - 2) & 0xFF); // BPL scrLoop2
emit(0xD0, (colLoop - bytes.length - 2) & 0xFF); // BNE colLoop
emit(0x10, (colLoop2 - bytes.length - 2) & 0xFF); // BPL colLoop2
```

- [ ] **Step 4: Fix `poke`**

In `genCall`, replace the whole `if (e.name === 'poke') { … }` block with:

```ts
    if (e.name === 'poke') {
      const addrExpr = e.args[0];
      const valueExpr = e.args[1];
      if (addrExpr === undefined || valueExpr === undefined || e.args.length !== 2) {
        throw new CodeGenError('poke() takes an address and a value', e.line, 0);
      }
      const addrVal = evalConst(addrExpr);
      if (addrVal === null) {
        throw new CodeGenError('poke() address must be a compile-time constant', e.line, 0);
      }
      const byteVal = evalConst(valueExpr);
      if (byteVal !== null) emit(0xA9, byteVal & 0xFF);
      else genExpr(valueExpr);
      emit(0x8D, addrVal & 0xFF, (addrVal >> 8) & 0xFF);
      return;
    }
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/c64script`
Expected: PASS — the 6 new tests plus the existing c64script tests (63 original + 6 from Task 1 + 6 = 75 in this directory).

- [ ] **Step 6: Commit**

```bash
npx prettier --check test/c64script/builtins.test.ts || npx prettier --write test/c64script/builtins.test.ts
npx eslint test/c64script/builtins.test.ts
npm run typecheck
git add src/c64script/codegen.ts test/c64script/builtins.test.ts
git commit -m "fix(c64script): clrscr() branch offsets and poke() with non-constant arguments" -m "clrscr() ran off the end of the program (relative branches were one byte off). poke() silently emitted nothing unless both arguments were constants; it now stores computed values and rejects non-constant addresses with a located CodeGenError." -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: URL-hash codec for sharing source

**Files:**
- Create: `website/js/code-hash.js`
- Create: `test/website/code-hash.test.ts`
- Modify: `eslint.config.js` (browser globals for the new site modules)

**Interfaces:**
- Produces (ES module `website/js/code-hash.js`):
  - `encodeCode(source: string): string` — base64url of the UTF-8 bytes, no padding.
  - `decodeCode(encoded: string): string` — throws on invalid base64 or invalid UTF-8.
  - `tryNowUrl(source: string, playgroundUrl: string): string` → `` `${playgroundUrl}#code=${encodeCode(source)}` ``.
  - `codeFromHash(hash: string): string | null` — `hash` is `location.hash` (with leading `#`); returns `null` for anything malformed, never throws.

- [ ] **Step 1: Write the failing tests**

Create `test/website/code-hash.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  codeFromHash,
  decodeCode,
  encodeCode,
  tryNowUrl,
} from '../../website/js/code-hash.js';

describe('code-hash', () => {
  it('round-trips ASCII source', () => {
    const src = 'program @ 0x0810 {\n  VIC2.borderColor = RED;\n  loop {}\n}\n';
    expect(decodeCode(encodeCode(src))).toBe(src);
  });

  it('round-trips non-ASCII characters and emoji', () => {
    const src = '// Cycle the colours — border → background 🌈\nprogram @ 0x0810 { loop {} }';
    expect(decodeCode(encodeCode(src))).toBe(src);
  });

  it('produces URL-safe output with no padding', () => {
    const encoded = encodeCode('???>>>~~~ÿÿÿ'.repeat(10));
    expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/);
  });

  it('builds a try-now URL that codeFromHash reads back', () => {
    const src = 'program @ 0x0810 { loop {} }';
    const url = tryNowUrl(src, 'https://example.test/playground.html');
    const hash = url.slice(url.indexOf('#'));
    expect(url.startsWith('https://example.test/playground.html#code=')).toBe(true);
    expect(codeFromHash(hash)).toBe(src);
  });

  it('returns null for a missing, empty or unrelated hash', () => {
    expect(codeFromHash('')).toBeNull();
    expect(codeFromHash('#')).toBeNull();
    expect(codeFromHash('#about')).toBeNull();
    expect(codeFromHash('#code=')).toBeNull();
  });

  it('returns null (never throws) for malformed payloads', () => {
    expect(codeFromHash('#code=!!!not base64!!!')).toBeNull();
    expect(codeFromHash('#code=A')).toBeNull(); // impossible base64 length
    // 0xFF 0xFE is not valid UTF-8
    expect(codeFromHash('#code=__4')).toBeNull();
    expect(codeFromHash('#code=' + 'A'.repeat(100_001))).toBeNull(); // absurdly large
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run test/website/code-hash.test.ts`
Expected: FAIL — cannot resolve `../../website/js/code-hash.js`.

- [ ] **Step 3: Implement the module**

Create `website/js/code-hash.js`:

```js
// Encodes C64Script source into a URL hash ("#code=<base64url of UTF-8>") so a sample on any
// page can open the playground with that code loaded. No storage, no server.

const MAX_ENCODED_LENGTH = 100_000;

export function encodeCode(source) {
  const bytes = new TextEncoder().encode(source);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Throws on invalid base64 or invalid UTF-8. */
export function decodeCode(encoded) {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function tryNowUrl(source, playgroundUrl) {
  return `${playgroundUrl}#code=${encodeCode(source)}`;
}

/** `hash` is `location.hash`. Returns the decoded source, or null if absent or malformed. */
export function codeFromHash(hash) {
  const match = /^#code=([A-Za-z0-9_-]+)$/.exec(hash);
  if (!match || match[1].length > MAX_ENCODED_LENGTH) return null;
  try {
    return decodeCode(match[1]);
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/website/code-hash.test.ts`
Expected: PASS (6 tests). If `'#code=__4'` unexpectedly decodes, replace that probe with another payload that is valid base64 but invalid UTF-8, e.g. `encodeCode`-style of bytes `[0xff, 0xfe]` = `//4` → use `'#code=__4'` only if `decodeCode` throws on it; confirm by running `node -e "console.log(Buffer.from('__4','base64'))"` (expect bytes `ff fe`).

- [ ] **Step 5: Lint config for the new browser modules**

Append this block to the array passed to `tseslint.config(...)` in `eslint.config.js` (before the closing `);`):

```js
  {
    files: ['website/js/{code-hash,playground,playground-examples,try-now}.js'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        window: 'readonly',
        document: 'readonly',
        location: 'readonly',
        history: 'readonly',
        navigator: 'readonly',
        console: 'readonly',
        File: 'readonly',
        URL: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        btoa: 'readonly',
        atob: 'readonly',
      },
    },
  },
```

Run: `npx eslint website/js/code-hash.js test/website/code-hash.test.ts eslint.config.js`
Expected: exit 0, no output.

- [ ] **Step 6: Format and commit**

```bash
npx prettier --write website/js/code-hash.js test/website/code-hash.test.ts eslint.config.js
git add website/js/code-hash.js test/website/code-hash.test.ts eslint.config.js
git commit -m "feat(website): URL-hash codec for sharing C64Script source" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Playground examples

**Files:**
- Create: `website/js/playground-examples.js`
- Create: `test/website/examples.test.ts`

**Interfaces:**
- Produces: `export const EXAMPLES: Array<{ id: string; title: string; source: string }>`; `EXAMPLES[0]` is the default example (rainbow border). Task 5 consumes this.

- [ ] **Step 1: Write the failing test**

Create `test/website/examples.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { C64 } from '../../src/machine/c64';
import { compile } from '../../src/c64script/index';
import { EXAMPLES } from '../../website/js/playground-examples.js';

function boot(source: string, frames: number): C64 {
  const prg = compile(source);
  const load = prg[0]! | (prg[1]! << 8);
  const c64 = new C64({
    kernal: new Uint8Array(8192).fill(0xea),
    basic: new Uint8Array(8192),
    chargen: new Uint8Array(4096),
  });
  for (let i = 2; i < prg.length; i++) c64.pokeRam(load + i - 2, prg[i]!);
  c64.cpu.regs.pc = load;
  for (let f = 0; f < frames; f++) c64.runFrame();
  return c64;
}

describe('playground examples', () => {
  it('has unique ids and non-empty titles', () => {
    expect(EXAMPLES.length).toBeGreaterThanOrEqual(5);
    expect(new Set(EXAMPLES.map((e) => e.id)).size).toBe(EXAMPLES.length);
    for (const e of EXAMPLES) expect(e.title.length).toBeGreaterThan(0);
  });

  it.each(EXAMPLES.map((e) => [e.id, e.source] as const))('%s compiles', (_id, source) => {
    const prg = compile(source);
    expect(prg.length).toBeGreaterThan(2);
  });

  it('rainbow cycles the border colour over time', () => {
    const rainbow = EXAMPLES.find((e) => e.id === 'rainbow')!;
    const seen = new Set<number>();
    for (const frames of [10, 20, 40, 60, 80, 120]) {
      seen.add(boot(rainbow.source, frames).peek(0xd020) & 0x0f);
    }
    expect(seen.size).toBeGreaterThanOrEqual(4);
  });

  it('colors sets border and background', () => {
    const c64 = boot(EXAMPLES.find((e) => e.id === 'colors')!.source, 2);
    expect(c64.peek(0xd020) & 0x0f).toBe(6);
    expect(c64.peek(0xd021) & 0x0f).toBe(14);
  });

  it('hello writes H at row 12, column 15 and continues', () => {
    const c64 = boot(EXAMPLES.find((e) => e.id === 'hello')!.source, 3);
    expect(c64.peek(0x0400 + 495)).toBe(8);
    expect(c64.peek(0x0400 + 503)).toBe(0x34);
  });

  it('sprite moves right across the screen', () => {
    const src = EXAMPLES.find((e) => e.id === 'sprite')!.source;
    const early = boot(src, 10).peek(0xd000);
    const later = boot(src, 30).peek(0xd000);
    expect(later).toBeGreaterThan(early);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run test/website/examples.test.ts`
Expected: FAIL — cannot resolve `../../website/js/playground-examples.js`.

- [ ] **Step 3: Create the examples module**

Create `website/js/playground-examples.js` (every program below was compiled and run against the real compiler while writing this plan):

```js
// Programs offered in the playground's example dropdown. The first one is the default.
// Every entry is compiled (and the behavioural ones executed) by test/website/examples.test.ts.

export const EXAMPLES = [
  {
    id: 'rainbow',
    title: 'Rainbow border',
    source: `// Cycle the border through all 16 C64 colours
let @zp color: u8 = 0;
let @zp ticks: u8 = 0;

program @ 0x0810 {
  loop {
    // wait for one video frame
    while (VIC2.rasterLine != 200) {}
    while (VIC2.rasterLine == 200) {}

    ticks = ticks + 1;
    if (ticks == 5) {
      ticks = 0;
      color = color + 1;
      if (color == 16) { color = 0; }
      VIC2.borderColor = color;
    }
  }
}
`,
  },
  {
    id: 'colors',
    title: 'Colour constants',
    source: `// Colour constants compile to immediates
program @ 0x0810 {
  VIC2.borderColor = BLUE;       // LDA #6 ; STA $D020
  VIC2.bgColor0    = LIGHT_BLUE; // LDA #14; STA $D021
  loop {}
}
`,
  },
  {
    id: 'function',
    title: 'Function call',
    source: `// A function without parameters, called from the main loop
let @zp shade: u8 = 0;

fn nextShade(): void {
  shade = shade + 1;
  if (shade == 16) { shade = 0; }
}

program @ 0x0810 {
  loop {
    while (VIC2.rasterLine != 200) {}
    while (VIC2.rasterLine == 200) {}
    nextShade();
    VIC2.bgColor0 = shade;
  }
}
`,
  },
  {
    id: 'hello',
    title: 'Text on screen',
    source: `// Write HELLO C64 into screen RAM (screen codes) and colour it white
program @ 0x0810 {
  clrscr();
  VIC2.borderColor = BLACK;
  VIC2.bgColor0 = BLACK;

  poke(0x0400 + 495, 8);    // H   row 12, column 15
  poke(0x0400 + 496, 5);    // E
  poke(0x0400 + 497, 12);   // L
  poke(0x0400 + 498, 12);   // L
  poke(0x0400 + 499, 15);   // O
  poke(0x0400 + 501, 3);    // C
  poke(0x0400 + 502, 0x36); // 6
  poke(0x0400 + 503, 0x34); // 4

  poke(0xD800 + 495, WHITE);
  poke(0xD800 + 496, WHITE);
  poke(0xD800 + 497, WHITE);
  poke(0xD800 + 498, WHITE);
  poke(0xD800 + 499, WHITE);
  poke(0xD800 + 501, WHITE);
  poke(0xD800 + 502, WHITE);
  poke(0xD800 + 503, WHITE);
  loop {}
}
`,
  },
  {
    id: 'sprite',
    title: 'Moving sprite',
    source: `// A hollow-box sprite crossing the screen
data @addr(0x0D40) {
  box: [u8; 63] = [
    0xFF, 0xFF, 0xFF,
    0x80, 0x00, 0x01,
    0x80, 0x00, 0x01,
    0x80, 0x00, 0x01,
    0x80, 0x00, 0x01,
    0x80, 0x00, 0x01,
    0x80, 0x00, 0x01,
    0x80, 0x00, 0x01,
    0x80, 0x00, 0x01,
    0x80, 0x00, 0x01,
    0x80, 0x00, 0x01,
    0x80, 0x00, 0x01,
    0x80, 0x00, 0x01,
    0x80, 0x00, 0x01,
    0x80, 0x00, 0x01,
    0x80, 0x00, 0x01,
    0x80, 0x00, 0x01,
    0x80, 0x00, 0x01,
    0x80, 0x00, 0x01,
    0x80, 0x00, 0x01,
    0xFF, 0xFF, 0xFF,
  ];
}

let @zp x: u8 = 24;

program @ 0x0810 {
  poke(0x07F8, 53);          // sprite 0 data at $0D40 (53 * 64)
  VIC2.spriteEnable = 1;
  VIC2.sprite0color = YELLOW;
  VIC2.sprite0y = 120;

  loop {
    while (VIC2.rasterLine != 200) {}
    while (VIC2.rasterLine == 200) {}
    VIC2.sprite0x = x;
    x = x + 1;
  }
}
`,
  },
];
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/website/examples.test.ts`
Expected: PASS (all examples compile; behavioural tests pass). The `hello` test depends on the Task 2 `clrscr` fix.

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write test/website/examples.test.ts
npx eslint website/js/playground-examples.js test/website/examples.test.ts
git add website/js/playground-examples.js test/website/examples.test.ts
git commit -m "feat(website): playground example programs, compiled and executed in tests" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
(Do not run `prettier --write` on `playground-examples.js`: the template literals are program text and must stay as written.)

---

### Task 5: The playground page

**Files:**
- Create: `website/playground.html` (generated from `website/c64script.html` so the nav, footer and shared styles stay identical)
- Create: `website/js/playground.js`
- Modify: nav in `website/index.html`, `website/architecture.html`, `website/usage.html`, `website/c64script.html`, `website/showcases.html`, `website/demos/nyancat.html` (add a "Playground" link)

**Interfaces:**
- Consumes: `window.F6502.{start, compile, C64ScriptError}` (from `dist/f6502.min.js`, Task 1), `window.Prism`, `codeFromHash` (Task 3), `EXAMPLES` (Task 4), ROM files `website/demos/{kernal,basic,chargen}.bin`.
- Produces: page `website/playground.html`; accepts `#code=<base64url>`.

- [ ] **Step 1: Generate `playground.html` from the C64Script page**

Write this script to the scratchpad directory (`/tmp/claude-1000/-home-firat-Projects-firat-f6502/67ff5892-7a96-46af-9172-164723c0df9d/scratchpad/make-playground.mjs`) and run it with `node` from the repo root:

```js
import { readFileSync, writeFileSync } from 'node:fs';

const src = readFileSync('website/c64script.html', 'utf8');

const styles = `<style>
    .pg-head { max-width: var(--max-w); margin: 0 auto; padding: 2.5rem 1.5rem 1rem; }
    .pg-head h1 { font-family: var(--font-pixel); font-size: 1.1rem; margin: 0.75rem 0 0.5rem; }
    .pg-head p { color: var(--text-muted); margin: 0; }
    .pg { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 1.25rem;
          max-width: var(--max-w); margin: 0 auto; padding: 0 1.5rem 3rem; }
    @media (max-width: 900px) { .pg { grid-template-columns: minmax(0, 1fr); } }
    .pg-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.6rem; margin-bottom: 0.6rem; }
    .pg-select-label { display: inline-flex; align-items: center; gap: 0.5rem; margin-left: auto;
                       font-size: 0.8rem; color: var(--text-muted); }
    .pg-select-label select { background: var(--surface-2); color: var(--text); border: 1px solid var(--border-2);
                              border-radius: 6px; padding: 0.35rem 0.5rem; font: inherit; }
    .pg-hint { font-size: 0.75rem; color: var(--text-dim); }
    .pg-editor { position: relative; height: 480px; background: #0b0c1e; border: 1px solid var(--border-2);
                 border-radius: 8px; overflow: hidden; counter-reset: line; }
    .pg-editor pre, .pg-editor textarea {
      position: absolute; inset: 0; margin: 0; box-sizing: border-box;
      padding: 12px 12px 12px 3.6em; border: 0; outline: 0;
      font-family: 'Fira Code', 'Cascadia Code', 'Consolas', monospace;
      font-size: 0.83rem; line-height: 1.65; tab-size: 2; white-space: pre;
      word-wrap: normal; overflow-wrap: normal;
    }
    .pg-editor pre { overflow: hidden; color: #c0c4e0; pointer-events: none; }
    .pg-editor textarea { background: transparent; color: transparent; caret-color: #c0c4e0;
                          resize: none; overflow: auto; }
    .pg-editor textarea::selection { background: rgba(136, 126, 203, 0.35); }
    .pg-editor .ln { display: block; position: relative; min-height: 1.65em; counter-increment: line; }
    .pg-editor .ln::before { content: counter(line); position: absolute; left: -3.1em; width: 2.4em;
                             text-align: right; color: #454770; }
    .pg-editor .ln.err { background: rgba(255, 90, 90, 0.18); box-shadow: inset 3px 0 0 #ff5a5a; }
    .pg-editor .token.comment { color: #454770; font-style: italic; }
    .pg-editor .token.keyword { color: #887ecb; }
    .pg-editor .token.attr-name { color: #c9934a; }
    .pg-editor .token.class-name { color: #6abfc6; }
    .pg-editor .token.property { color: #50b8c8; }
    .pg-editor .token.function { color: #a090e8; }
    .pg-editor .token.boolean, .pg-editor .token.number { color: #c9d487; }
    .pg-editor .token.operator { color: #6070a0; }
    .pg-editor .token.punctuation { color: #4a4d70; }
    .pg-status { margin-top: 0.6rem; min-height: 1.4em; font-family: var(--font-mono); font-size: 0.8rem;
                 color: var(--text-muted); }
    .pg-status.err { color: #ff8a8a; }
    .pg-status.ok { color: var(--accent); }
    .pg-crt { background: #000; border: 1px solid var(--border-2); border-radius: 10px; padding: 12px; }
    .pg-crt canvas { display: block; width: 100%; aspect-ratio: 384 / 272; image-rendering: pixelated;
                     background: #000; }
    .pg-note { font-size: 0.78rem; color: var(--text-dim); margin: 0.6rem 0 0; }
  </style>`;

const body = `<div class="page">
  <header class="pg-head">
    <span class="hero-badge">PLAYGROUND</span>
    <h1>C64Script Playground</h1>
    <p>Write C64Script, press Run: it compiles in your browser and runs on the emulator.</p>
  </header>

  <main class="pg">
    <section aria-label="Editor">
      <div class="pg-toolbar">
        <button id="run-btn" class="btn btn-primary" type="button">&#9654; Run</button>
        <button id="reboot-btn" class="btn btn-outline" type="button">&#8634; Reboot</button>
        <span class="pg-hint">Ctrl/&#8984; + Enter</span>
        <label class="pg-select-label">Example
          <select id="example-select"></select>
        </label>
      </div>
      <div class="pg-editor">
        <pre id="highlight" aria-hidden="true"></pre>
        <textarea id="editor" spellcheck="false" wrap="off" autocomplete="off"
                  autocapitalize="off" aria-label="C64Script source"></textarea>
      </div>
      <div id="status" class="pg-status" role="status" aria-live="polite">Loading emulator…</div>
    </section>

    <section aria-label="Emulator">
      <div class="pg-crt"><canvas id="emu-canvas" width="384" height="272"></canvas></div>
      <p class="pg-note">Click the screen to give it keyboard focus.</p>
    </section>
  </main>

  `;

let html = src;
html = html.replace(/<title>[\s\S]*?<\/title>/, '<title>Playground — f6502</title>');
html = html.replace(
  /<meta name="description"[^>]*>/,
  '<meta name="description" content="Write C64Script in your browser and run it on a cycle-accurate Commodore 64 emulator.">',
);
html = html.replace(/<style>[\s\S]*?<\/style>/, styles);
html = html.replace(' aria-current="page"', '');
html = html.replace(
  '<li><a href="c64script.html">C64Script</a></li>',
  '<li><a href="c64script.html">C64Script</a></li>\n    <li><a href="playground.html" aria-current="page">Playground</a></li>',
);
const pageStart = html.indexOf('<div class="page">');
const footerStart = html.indexOf('<footer>');
if (pageStart < 0 || footerStart < 0) throw new Error('c64script.html layout changed');
html = html.slice(0, pageStart) + body + html.slice(footerStart);
html = html.replace(/<script src="js\/app\.js"><\/script>[\s\S]*<\/body>/, `<script src="js/app.js"></script>
<script src="dist/f6502.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/prism.min.js"
        integrity="sha512-7Z9J3l1+EYfeaPKcGXu3MS/7T+w19WtKQY/n+xzmw4hZhJ9tyYmcUS+4QqAlzhicE5LAfMQSF3iFTK9bQdTxXg=="
        crossorigin="anonymous" referrerpolicy="no-referrer"></script>
<script type="module" src="js/playground.js"></script>
</body>`);

writeFileSync('website/playground.html', html);
console.log('wrote website/playground.html', html.length);
```

Check: `grep -c "Playground" website/playground.html` ≥ 3, and `grep -n "aria-current" website/playground.html` shows exactly one match (the Playground link). The footer links list should also gain a Playground link: add `      <a href="playground.html">Playground</a>` after the `showcases.html` footer link line in `playground.html`.

- [ ] **Step 2: Write `website/js/playground.js`**

```js
import { codeFromHash } from './code-hash.js';
import { EXAMPLES } from './playground-examples.js';

const GRAMMAR = {
  comment: { pattern: /\/\/.*/, greedy: true },
  annotation: { pattern: /@(?:zp|inline|addr|0x[0-9a-fA-F]+)/, alias: 'attr-name' },
  keyword: /\b(?:program|fn|let|const|loop|while|for|if|else|break|continue|return|data|struct|hardware|asm)\b/,
  type: { pattern: /\b(?:u8|u16|bool|void)\b/, alias: 'class-name' },
  hardware: { pattern: /\b(?:VIC2|SID|CIA1|CIA2)\b/, alias: 'property' },
  constant: {
    pattern:
      /\b(?:BLACK|WHITE|RED|CYAN|PURPLE|GREEN|BLUE|YELLOW|ORANGE|BROWN|LIGHT_RED|DARK_GREY|MEDIUM_GREY|LIGHT_GREEN|LIGHT_BLUE|LIGHT_GREY)\b/,
    alias: 'boolean',
  },
  builtin: { pattern: /\b(?:poke|clrscr|lo|hi)\b/, alias: 'function' },
  number: /\b0x[0-9a-fA-F]+\b|\b\d+\b/,
  operator: /[-+*/=<>!&|^%]+/,
  punctuation: /[{}[\];(),.:]/,
};

const $ = (id) => document.getElementById(id);
const editor = $('editor');
const highlight = $('highlight');
const select = $('example-select');
const statusEl = $('status');
const canvas = $('emu-canvas');

let player = null;

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = `pg-status ${kind}`.trim();
}

function render(errorLine = 0) {
  const lines = editor.value.split('\n');
  highlight.innerHTML =
    lines
      .map((text, i) => {
        const html = window.Prism.highlight(text, GRAMMAR, 'c64script') || ' ';
        return `<span class="ln${i + 1 === errorLine ? ' err' : ''}">${html}</span>`;
      })
      .join('') + '<span class="ln"> </span><span class="ln"> </span>';
  highlight.scrollTop = editor.scrollTop;
  highlight.scrollLeft = editor.scrollLeft;
}

function hex4(n) {
  return n.toString(16).toUpperCase().padStart(4, '0');
}

async function run() {
  if (!player) return;
  const source = editor.value.replace(/\r\n?/g, '\n');
  let prg;
  try {
    prg = window.F6502.compile(source);
  } catch (err) {
    const line = typeof err.line === 'number' ? err.line : 0;
    render(line);
    setStatus(err instanceof Error ? err.message : String(err), 'err');
    return; // keep the previous program running
  }
  render(0);
  try {
    player.reset();
    await player.load(new File([prg], 'play.prg'));
    const load = prg[0] | (prg[1] << 8);
    setStatus(`Compiled · ${prg.length - 2} bytes · loads at $${hex4(load)}`, 'ok');
    canvas.focus();
  } catch (err) {
    setStatus(`Could not start program: ${err instanceof Error ? err.message : err}`, 'err');
  }
}

function useSource(source) {
  editor.value = source;
  render(0);
}

function setup() {
  for (const ex of EXAMPLES) {
    const opt = document.createElement('option');
    opt.value = ex.id;
    opt.textContent = ex.title;
    select.append(opt);
  }
  const shared = codeFromHash(location.hash);
  if (shared !== null) {
    const custom = document.createElement('option');
    custom.value = '';
    custom.textContent = 'Shared sample';
    select.prepend(custom);
    select.value = '';
    useSource(shared);
  } else {
    select.value = EXAMPLES[0].id;
    useSource(EXAMPLES[0].source);
  }

  select.addEventListener('change', () => {
    const ex = EXAMPLES.find((e) => e.id === select.value);
    if (!ex) return;
    useSource(ex.source);
    run();
  });

  editor.addEventListener('input', () => render(0));
  editor.addEventListener('scroll', () => {
    highlight.scrollTop = editor.scrollTop;
    highlight.scrollLeft = editor.scrollLeft;
  });
  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      editor.setRangeText('  ', editor.selectionStart, editor.selectionEnd, 'end');
      render(0);
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      run();
    }
  });
  $('run-btn').addEventListener('click', run);
  $('reboot-btn').addEventListener('click', () => {
    if (player) player.reset();
  });
}

async function main() {
  setup();
  if (!window.F6502 || typeof window.F6502.compile !== 'function') {
    setStatus('Emulator bundle missing or outdated. Run `npm run build`, then reload.', 'err');
    return;
  }
  try {
    player = await window.F6502.start({
      canvas,
      roms: {
        kernal: 'demos/kernal.bin',
        basic: 'demos/basic.bin',
        chargen: 'demos/chargen.bin',
      },
      scale: 'fit',
      audio: false,
    });
  } catch (err) {
    setStatus(`Could not start the emulator: ${err instanceof Error ? err.message : err}`, 'err');
    return;
  }
  setStatus('Ready.');
  await run();
}

main();
```

- [ ] **Step 3: Add the nav link to the other pages**

```bash
node -e "
const fs = require('node:fs');
const jobs = [
  ['website/index.html', '<li><a href=\"c64script.html\">C64Script</a></li>', 'playground.html'],
  ['website/architecture.html', '<li><a href=\"c64script.html\">C64Script</a></li>', 'playground.html'],
  ['website/usage.html', '<li><a href=\"c64script.html\">C64Script</a></li>', 'playground.html'],
  ['website/c64script.html', '<li><a href=\"c64script.html\" aria-current=\"page\">C64Script</a></li>', 'playground.html'],
  ['website/showcases.html', '<li><a href=\"c64script.html\">C64Script</a></li>', 'playground.html'],
  ['website/demos/nyancat.html', '<li><a href=\"../c64script.html\">C64Script</a></li>', '../playground.html'],
];
for (const [file, anchor, href] of jobs) {
  const s = fs.readFileSync(file, 'utf8');
  if (!s.includes(anchor)) throw new Error('anchor not found in ' + file);
  if (s.includes('href=\"' + href + '\">Playground')) continue;
  fs.writeFileSync(file, s.replace(anchor, anchor + '\n    <li><a href=\"' + href + '\">Playground</a></li>'));
  console.log('nav link added:', file);
}
"
```
Expected: six `nav link added:` lines. If an anchor is not found, open that file's nav and add the `<li>` by hand after its C64Script entry.

- [ ] **Step 4: Build, stage the bundle, serve, and look at it**

```bash
npm run build
node scripts/make-stub-roms.mjs
mkdir -p website/dist && cp dist/f6502.min.js website/dist/
PORT=8080 node scripts/serve.mjs &
```
(`website/dist` is gitignored via the `dist` rule.) Open `http://localhost:8080/website/playground.html` in a browser (Playwright or Chrome tools). Expected:
- Editor shows the Rainbow border program, highlighted, with line numbers.
- Status reads `Compiled · NN bytes · loads at $0810` and the emulator border cycles colours.
- Changing the dropdown to "Text on screen" shows `HELLO C64` in the middle of the screen.
- Typing `program(0x0810) {}` as the whole source and pressing Ctrl+Enter shows a red `[1:8] …` message, highlights line 1, and the previous program keeps running.
- Resize to ~600px wide: panes stack.

Stop the server (`kill %1`).

- [ ] **Step 5: Lint and commit**

```bash
npx prettier --write website/js/playground.js
npx eslint website/js/playground.js
git add website/playground.html website/js/playground.js website/index.html website/architecture.html website/usage.html website/c64script.html website/showcases.html website/demos/nyancat.html
git commit -m "feat(website): C64Script playground page" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
(`prettier --write` on `playground.js` is fine; do not run it on the HTML files.)

---

### Task 6: "Try now" buttons and docs rewritten to the real syntax

**Files:**
- Create: `website/js/try-now.js`
- Modify: `website/css/style.css` (append)
- Modify: `website/c64script.html`, `website/usage.html`, `website/showcases.html`, `website/index.html`
- Create: `test/website/docs-samples.test.ts`

**Interfaces:**
- Consumes: `tryNowUrl` (Task 3), `playground.html` (Task 5).
- Produces: every `<pre data-try>` on any page gets a "▶ Try now" link that opens `playground.html#code=…`.

- [ ] **Step 1: Write the failing docs test**

Create `test/website/docs-samples.test.ts`:

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../../src/c64script/index';

const ROOT = 'website';

function htmlFiles(): string[] {
  const out: string[] = [];
  for (const dir of [ROOT, join(ROOT, 'demos')]) {
    for (const f of readdirSync(dir)) if (f.endsWith('.html')) out.push(join(dir, f));
  }
  return out;
}

function decode(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

const blocks: Array<{ name: string; source: string }> = [];
for (const file of htmlFiles()) {
  const html = readFileSync(file, 'utf8');
  const re = /<pre\b[^>]*\bdata-try\b[^>]*>([\s\S]*?)<\/pre>/g;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(html))) blocks.push({ name: `${file}#${n++}`, source: decode(m[1]!) });
}

describe('website C64Script samples', () => {
  it('has Try-now blocks on the site', () => {
    expect(blocks.length).toBeGreaterThanOrEqual(5);
  });

  it.each(blocks.map((b) => [b.name, b.source] as const))('%s compiles', (_name, source) => {
    expect(() => compile(source)).not.toThrow();
  });

  it('no page documents the old dialect', () => {
    for (const file of htmlFiles()) {
      const text = decode(readFileSync(file, 'utf8'));
      expect(text, file).not.toMatch(/program\(0x[0-9a-fA-F]+\)/);
      expect(text, file).not.toMatch(/\bc64\.(border|background)\b/);
      expect(text, file).not.toMatch(/f6502\/c64script/);
    }
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run test/website/docs-samples.test.ts`
Expected: FAIL — `blocks.length` is 0 and the old-dialect test fails on `website/c64script.html`.

- [ ] **Step 3: Rewrite the three samples on `c64script.html` and mark them `data-try`**

In `website/c64script.html`, in the "Examples" section (around lines 155–235) there are three `<pre>…</pre>` blocks inside `.terminal-body` (file names `rainbow-border.c64s`, `clamp-demo.c64s`, `colors.c64s`). Replace each block's whole `<pre>…</pre>` with the following (highlight classes `kw` keyword, `ty` type, `an` annotation, `nu` number, `cm` comment are the page's existing ones). Also rename the title spans `clamp-demo.c64s` → `function.c64s`.

Block 1 (rainbow-border.c64s):
```html
<pre data-try><span class="cm">// Cycle the border through all 16 C64 colours</span>
<span class="kw">let</span> <span class="an">@zp</span> color: <span class="ty">u8</span> = <span class="nu">0</span>;
<span class="kw">let</span> <span class="an">@zp</span> ticks: <span class="ty">u8</span> = <span class="nu">0</span>;

<span class="kw">program</span> <span class="an">@</span> <span class="nu">0x0810</span> {
  <span class="kw">loop</span> {
    <span class="cm">// wait for one video frame</span>
    <span class="kw">while</span> (VIC2.rasterLine != <span class="nu">200</span>) {}
    <span class="kw">while</span> (VIC2.rasterLine == <span class="nu">200</span>) {}

    ticks = ticks + <span class="nu">1</span>;
    <span class="kw">if</span> (ticks == <span class="nu">5</span>) {
      ticks = <span class="nu">0</span>;
      color = color + <span class="nu">1</span>;
      <span class="kw">if</span> (color == <span class="nu">16</span>) { color = <span class="nu">0</span>; }
      VIC2.borderColor = color;
    }
  }
}</pre>
```

Block 2 (function.c64s):
```html
<pre data-try><span class="cm">// A function without parameters, called from the main loop</span>
<span class="kw">let</span> <span class="an">@zp</span> shade: <span class="ty">u8</span> = <span class="nu">0</span>;

<span class="kw">fn</span> nextShade(): <span class="ty">void</span> {
  shade = shade + <span class="nu">1</span>;
  <span class="kw">if</span> (shade == <span class="nu">16</span>) { shade = <span class="nu">0</span>; }
}

<span class="kw">program</span> <span class="an">@</span> <span class="nu">0x0810</span> {
  <span class="kw">loop</span> {
    <span class="kw">while</span> (VIC2.rasterLine != <span class="nu">200</span>) {}
    <span class="kw">while</span> (VIC2.rasterLine == <span class="nu">200</span>) {}
    nextShade();
    VIC2.bgColor0 = shade;
  }
}</pre>
```

Block 3 (colors.c64s):
```html
<pre data-try><span class="cm">// Colour constants compile to immediates</span>
<span class="kw">program</span> <span class="an">@</span> <span class="nu">0x0810</span> {
  VIC2.borderColor = BLUE;       <span class="cm">// LDA #6 ; STA $D020</span>
  VIC2.bgColor0    = LIGHT_BLUE; <span class="cm">// LDA #14; STA $D021</span>
  <span class="kw">loop</span> {}
}</pre>
```
Also change the sentence introducing block 2 ("Use a function to keep the main loop clean:") to "Use a function to keep the main loop clean. Functions take no parameters today; share data through global variables:".

- [ ] **Step 4: Rewrite the rest of `c64script.html` to the real language**

Apply this mapping to every remaining occurrence in prose and tables (use `grep -nE "byte|word|c64\.|@addr\(|DARK_GRAY|GRAY|typed parameters|var " website/c64script.html` to find them, and view ~lines 95–150, 240–360 and 480–575 before editing):

| Old | New |
|---|---|
| type `byte`, 8-bit row | `u8` — "0 – 255. Maps to the 6502 accumulator. All arithmetic is modulo 256." |
| type `word`, 16-bit row | `u16` — "0 – 65535. Partial support: declare it and use `lo()` / `hi()`; arithmetic on it is incomplete." |
| "Bind variable to a fixed memory address … for all c64.* hardware fields" (`@addr(0xD020)`) | "Bind a block of data (`data @addr(0x0D40) { … }`) or a variable to a fixed address. The built-in `VIC2`, `SID`, `CIA1`, `CIA2` hardware fields are bound this way." |
| "The c64 object provides direct access to VIC-II hardware registers" | "The `VIC2` object provides direct access to VIC-II registers; `SID`, `CIA1`, `CIA2` work the same way." |
| table row `c64.border` / `$D020` | `VIC2.borderColor` / `$D020` / read & write / Border colour (0–15) |
| table row `c64.background` / `$D021` | `VIC2.bgColor0` / `$D021` / read & write / Background colour (0–15) |
| add rows | `VIC2.spriteEnable` `$D015`, `VIC2.sprite0x` `$D000`, `VIC2.sprite0y` `$D001`, `VIC2.sprite0color` `$D027`, `VIC2.rasterLine` `$D012` (read-only), `VIC2.ctrl1` `$D011`, `VIC2.ctrl2` `$D016`, `VIC2.memPointers` `$D018` |
| `DARK_GRAY`, `GRAY`, `LIGHT_GRAY` | `DARK_GREY`, `MEDIUM_GREY`, `LIGHT_GREY` |
| "plain byte constants" | "plain `u8` constants" |
| "typed parameters and return values … inlines JSR/RTS calls" | "Define reusable `fn` blocks with a return type. Calls compile to `JSR`/`RTS`, or inline the body when marked `@inline`. Parameters are not reliable yet — use global variables." |
| import example `{ compile, LexError, ParseError, TypeError, CodeGenError } from 'f6502'` | `{ compile, C64ScriptError, LexError, ParseError, C64ScriptTypeError, CodeGenError } from 'f6502'` |
| `program(0x0810) { loop { c64.border = c64.border + 1; } }` (in that import example) | `program @ 0x0810 { loop { VIC2.borderColor = VIC2.borderColor + 1; } }` |

In the "Limitations" section (around lines 540–575) add these entries, in the page's existing list style:
- "`poke()` needs a constant address (the value can be any expression). A non-constant address is a compile error."
- "No array indexing and no inline `asm {}` code generation yet: the syntax parses, but nothing is emitted for it."
- "Function parameters are not reliably bound; pass data through global variables."
- "Prefer `while` and `loop`; the `for` statement does not accept an assignment as its initialiser."

- [ ] **Step 5: Rewrite the sample on `showcases.html` and `index.html`**

In `website/showcases.html` (the `<pre>` around line 337, inside the "Write your own" terminal) and `website/index.html` (the `<pre>` around line 295), replace the whole `<pre>…</pre>` with the block below, using that page's token class names (`token-cmt`, `token-kw`, `token-type`, `token-ann`, `token-num`) in place of `cm`/`kw`/`ty`/`an`/`nu`, and keep the `data-try` attribute:

```html
<pre data-try><span class="token-cmt">// Cycle the border through all 16 C64 colours</span>
<span class="token-kw">let</span> <span class="token-ann">@zp</span> color: <span class="token-type">u8</span> = <span class="token-num">0</span>;
<span class="token-kw">let</span> <span class="token-ann">@zp</span> ticks: <span class="token-type">u8</span> = <span class="token-num">0</span>;

<span class="token-kw">program</span> <span class="token-ann">@</span> <span class="token-num">0x0810</span> {
  <span class="token-kw">loop</span> {
    <span class="token-kw">while</span> (VIC2.rasterLine != <span class="token-num">200</span>) {}
    <span class="token-kw">while</span> (VIC2.rasterLine == <span class="token-num">200</span>) {}

    ticks = ticks + <span class="token-num">1</span>;
    <span class="token-kw">if</span> (ticks == <span class="token-num">5</span>) {
      ticks = <span class="token-num">0</span>;
      color = color + <span class="token-num">1</span>;
      <span class="token-kw">if</span> (color == <span class="token-num">16</span>) { color = <span class="token-num">0</span>; }
      VIC2.borderColor = color;
    }
  }
}</pre>
```
Update any caption next to those blocks that says "Rainbow border — cycles all 16 C64 colours" only if it contradicts the code (it does not).

- [ ] **Step 6: Fix the compile section of `usage.html`**

In `website/usage.html`:
- Line ~143: `import { compile } from 'f6502/c64script';` → `import { compile } from 'f6502';`
- The "C64Script integration" block (~lines 545–565): change the import to `from 'f6502'` and replace the program with:

```
const prg: Uint8Array = compile(`
  let @zp color: u8 = 0;
  program @ 0x0810 {
    loop {
      VIC2.borderColor = color;
      color = color + 1;
      if (color == 16) { color = 0; }
    }
  }
`);
```
(update the highlight spans in that block to match; keep the rest of the example: `await player.load(prg)` and the Node `writeFileSync` part.)
- The paragraph after it (~lines 568–571): "(LexError, ParseError, TypeError, or CodeGenError) … importable from f6502/c64script" → "(`LexError`, `ParseError`, `C64ScriptTypeError` or `CodeGenError`, all extending `C64ScriptError`, which carries `line` and `col`) … importable from `f6502`. In a plain `<script>` tag the compiler is `F6502.compile`."
- Add one sentence linking the playground: "Try programs without installing anything in the <a href=\"playground.html\">Playground</a>."

- [ ] **Step 7: The Try-now script and its style**

Create `website/js/try-now.js`:

```js
import { tryNowUrl } from './code-hash.js';

// Adds a "Try now" link to every <pre data-try>. The source is the block's own text, so the
// page keeps a single copy of each sample. Works from any page depth.
const playground = new URL('../playground.html', import.meta.url).href;

for (const pre of document.querySelectorAll('pre[data-try]')) {
  const host = pre.parentElement;
  if (!host || host.querySelector(':scope > .try-now')) continue;
  const link = document.createElement('a');
  link.className = 'try-now';
  link.textContent = '▶ Try now';
  link.target = '_blank';
  link.rel = 'noopener';
  link.href = tryNowUrl(pre.textContent.replace(/\s+$/, '') + '\n', playground);
  host.classList.add('try-now-host');
  host.append(link);
}
```

Append to `website/css/style.css`:

```css
/* ── "Try now" button on C64Script samples ─────────────────────────────── */
.try-now-host { position: relative; }
.try-now {
  position: absolute;
  top: 0.6rem;
  right: 0.75rem;
  z-index: 2;
  padding: 0.3rem 0.7rem;
  font-family: var(--font-pixel);
  font-size: 8px;
  letter-spacing: 0.08em;
  color: var(--bg);
  background: var(--accent);
  border-radius: 4px;
  text-decoration: none;
  opacity: 0.9;
}
.try-now:hover { opacity: 1; }
```

Load the script on the four pages that have `data-try` blocks — add this line just before `</body>` of `website/c64script.html`, `website/index.html`, `website/showcases.html` (they keep their existing `js/app.js` tag):

```html
<script type="module" src="js/try-now.js"></script>
```

- [ ] **Step 8: Run the tests**

Run: `npx vitest run test/website`
Expected: PASS — `docs-samples` finds 5 blocks (3 on `c64script.html`, 1 on `showcases.html`, 1 on `index.html`), all compile, and no page contains the old dialect (`program(0x…)`, `c64.border`, `f6502/c64script`). Fix any remaining occurrence the "no page documents the old dialect" test names.

- [ ] **Step 9: Format and commit**

```bash
npx prettier --write website/js/try-now.js test/website/docs-samples.test.ts
npx eslint website/js/try-now.js test/website/docs-samples.test.ts
npm test 2>&1 | tail -8
git add website/js/try-now.js website/css/style.css website/c64script.html website/usage.html website/showcases.html website/index.html test/website/docs-samples.test.ts
git commit -m "feat(website): Try-now buttons; docs rewritten to the real C64Script syntax" -m "Samples and reference text used a dialect the compiler never implemented (program(0x0810), var, byte, c64.border) and an import path that does not exist. They now match the compiler, and a test compiles every data-try block." -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: End-to-end verification and hand-off

**Files:** none (verification only; fixes go back to the owning task's files).

- [ ] **Step 1: Full test, typecheck and lint of the changed files**

```bash
npm test 2>&1 | tail -10
npm run typecheck
npx eslint src test website/js/code-hash.js website/js/playground.js website/js/playground-examples.js website/js/try-now.js eslint.config.js
```
Expected: tests pass; typecheck exits 0; eslint exit 0 for these paths (the 32 pre-existing errors are in `website/js/app.js`, `website/js/demo.js` and `examples/`, which are not listed).

- [ ] **Step 2: Build and serve**

```bash
npm run build && node scripts/make-stub-roms.mjs
mkdir -p website/dist && cp dist/f6502.min.js website/dist/
PORT=8080 node scripts/serve.mjs &
```

- [ ] **Step 3: Browser checks** (Playwright or Chrome tools; take a screenshot of each)

1. `http://localhost:8080/website/playground.html`: default example runs; border cycles.
2. Dropdown → each of the 5 examples runs (hello shows text; sprite moves; colors shows blue/light-blue).
3. Replace the source with `program(0x0810) {}` → status shows `[1:8]`-style error, line 1 highlighted, previous program still running; then restore a valid program and Run → error clears.
4. Review focus 5: paste a program with `\r\n` line endings → compiles; error line numbers correct.
5. Review focus 6: run `program @ 0x0810 { loop {} }`, then Run a different example → the new program runs (reboot-before-load works).
6. `http://localhost:8080/website/c64script.html`: each of the 3 sample blocks has a **Try now** button; clicking opens the playground in a new tab with that code in the editor, dropdown showing "Shared sample", and running.
7. Same for `showcases.html` and `index.html`.
8. `http://localhost:8080/website/playground.html#code=not-valid!!` → falls back to the default example, no console error. (Review focus 2.)
9. `http://localhost:8080/website/demos/nyancat.html` still loads and runs exactly as before; nav shows **Playground**.
10. Narrow viewport (~600px): panes stack, no horizontal page overflow.

Stop the server (`kill %1`). If any check fails, fix it in the owning task's files, re-run that task's tests, and commit as `fix(website): …`.

- [ ] **Step 4: Report, then ask before publishing**

Summarise to the user: what was built, test results, anything not verified. Then **ask** before: creating the GitHub issue (`gh issue create`, project rule: every PR needs one), pushing `feat/c64script-playground`, and opening the PR. PR description ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

Follow-ups to mention (not done here): porting the real nyancat showcase to C64Script (needs compiler support for indexed/looped memory writes or `asm` code generation, and `examples/nyancat.c64s` is an outdated sketch); `usage.html` documents `c64.peekRam()`, which does not exist on `C64`; function parameters are not properly bound by the compiler.
