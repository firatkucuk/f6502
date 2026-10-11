# C64Script Playground — Design

Date: 2026-10-11 (revised after sizing the work; see "Findings")

## Goal

A website page where a visitor writes C64Script, presses **Run**, and sees the program running in the
emulator on the same page. "Try now" buttons on the site's C64Script samples open the playground with
that sample loaded. Static site, no backend.

## Findings that shaped this design

1. **The compiler was not in the browser bundle.** `src/index.ts` does not export `src/c64script`,
   so `dist/f6502.min.js` has no `compile`. `test/c64script` is also not part of `npm test`.
2. **No website sample compiles.** `c64script.html`, `showcases.html`, `index.html` and `usage.html`
   document a dialect (`program(0x0810)`, `var`, `byte`/`word`, `c64.border`) that the compiler does
   not implement. The compiler implements `program @ 0x0810`, `let`, `u8`/`u16`, `VIC2.borderColor`.
   `usage.html` also imports from `f6502/c64script`, a subpath that `package.json` does not export.
3. **`poke()` silently emits nothing** unless both address and value are compile-time constants
   (`src/c64script/codegen.ts`, `genCall`). In a playground that is a trap.
4. **`examples/nyancat.c64s` is not the shipped showcase.** The shipped demo is built by
   `scripts/build-nyancat-prg.mjs` (two sprite layers, 18-column trail, terminal styling). The
   `.c64s` is an older single-sprite sketch whose comments say the trail "is implemented as a loop in
   the compiled PRG". The compiler has no indexing, no variable-address `poke`, and no `asm`
   code generation, so a faithful port is a separate piece of work.

## Decisions

- **Compiler delivery:** export `compile` and the error classes from `src/index.ts`
  (`F6502.compile`). `TypeError` is exported as `C64ScriptTypeError`.
- **Compiler is the source of truth:** the website docs are rewritten to the real syntax (approved).
- **Editor:** plain `<textarea>` over a Prism-highlighted `<pre>` overlay. No new dependencies.
- **Nyancat showcase from source: deferred** to a follow-up (finding 4). The existing PRG showcase
  is left untouched in this change. The follow-up is best done with the playground, and needs the
  compiler work described there.
- **Scope:** no saving, no debugger, no download button.

## Components

### 1. Library

- `src/index.ts` adds an explicit export list from `./c64script` (`compile`, `C64ScriptError`,
  `LexError`, `ParseError`, `CodeGenError`, `TypeError as C64ScriptTypeError`, and the types).
- `package.json` `test` script also runs `test/c64script` and `test/website`.

### 2. Compiler correctness: `poke`

- `poke(<const address>, <any expression>)` stores the evaluated value (previously dropped when the
  value was not constant).
- `poke(<non-constant address>, …)` throws `CodeGenError` with line/col instead of emitting nothing.

### 3. Playground `website/playground.html` + `website/js/playground.js`

- Shared nav/footer/styles; a "Playground" nav link on every page.
- Layout: editor left, emulator right (stacked on narrow screens). Toolbar: **Run**
  (Ctrl/Cmd+Enter), **Reset**, example dropdown, status line.
- Editor: textarea over per-line Prism-highlighted `<pre>`, scroll-synced, line numbers, Tab
  inserts two spaces, failing line highlighted.
- Run: `compile` → `player.reset()` → `player.load(File)`. A `C64ScriptError` shows
  `[line:col] message` and marks the line; the emulator keeps the previous program.
- One `Player`, created once with the stub ROMs in `website/demos/`.
- Examples live in `website/js/playground-examples.js` and are compiled by a test.

### 4. "Try now" on site samples

- `website/js/code-hash.js` encodes/decodes source as `#code=<base64url(UTF-8)>`.
- `website/js/try-now.js` adds a **Try now** link to every `<pre data-try>` using the block's
  `textContent`; the link opens `playground.html#code=…`.
- The playground loads `#code=` on start; a malformed hash falls back to the default example.
- A test extracts every `data-try` block from every page and compiles it, so docs cannot drift.

### 5. Docs rewritten to the real syntax

- Samples and reference text on `c64script.html`, `usage.html`, `showcases.html`, `index.html`
  use `program @ 0x0810`, `let`, `u8`/`u16`, `VIC2.*`; compile example imports from `f6502`.
- The reference no longer documents features the compiler lacks (arrays/indexing, `asm`,
  variable-address `poke`).

## Verification

`npm test`, `npm run typecheck`, `npm run lint`; build; serve with `scripts/serve.mjs`; in a
browser: run an example, trigger a syntax error, open a Try-now link, confirm the emulator
reflects the code.

## Process notes

- Each PR needs a GitHub issue (project rule).
- The commit/PR attribution lines come from the session reminder.
