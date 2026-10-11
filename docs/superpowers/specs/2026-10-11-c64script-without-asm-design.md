# C64Script without inline assembly — Design

Date: 2026-10-11

## Goal

The showcases use `asm {}` for things the language cannot say. The aim of C64Script is to write
programs without it, so close those gaps in the language, then rewrite the three showcases that
use assembly (`character-art`, `sprite-dance`, `flappy-bird`) in plain C64Script.

`asm {}` itself stays (it is documented and has its own playground example). Only the *need* for
it in ordinary programs goes away.

## What the showcases need

| Program | Assembly does | Language gap |
|---|---|---|
| `character-art` | fills 1000 cells; paints a row from a table | loop over a position that is only known at run time; `table[i]` |
| `sprite-dance` | `lda wave,x`; stores to `$D000 + 2n` | `table[i]`; a store to a computed address |
| `flappy-bird` | walks screen RAM column-wise; fills sky and ground | runtime screen position; 16-bit address arithmetic |

## Capabilities (four steps, one PR each, in this order)

### 1. 16-bit arithmetic

- `u16` supports `+`, `-`, `+=`, `-=` and all comparisons. A `u8` operand is zero-extended; the
  result of any expression containing a `u16` is a `u16`. Overflow wraps at 16 bits.
- `for (let i: u16 = 0; i < 1000; i++)` and `while` loops over a `u16` work (`++`/`--` already
  exist for `u16` variables).
- Assigning a `u16` to a `u8` still needs `lo()` or `as u8` (existing rule).
- `&`, `|`, `^`, `<<`, `>>` on `u16` are **not** added; constants still fold.

**Codegen.** An expression that contains a `u16` is evaluated into a reserved zero-page pair
`$F8/$F9` (low/high): the 8-bit generator is unchanged and keeps using A. `$F8–$FF` are outside
the allocator's range (`$02–$F7`), so no user variable moves. The restriction on the right-hand
operand (literal, variable, constant, register) stays, which keeps every operation to "accumulator
op operand" with no temporaries.

### 2. Runtime addresses: `peek`, `poke`, `screen`, `color`

- `poke(addr, value)` accepts any `u16` (or `u8`) expression as the address. A constant address
  compiles exactly as today; a computed one stores through a zero-page pointer pair `$FA/$FB`
  with `STA ($FA),Y`.
- `peek(addr)` returns the `u8` at any address, constant or computed. (There is no read of an
  arbitrary address today.)
- `screen(row, col)` and `color(row, col)` accept `u8` variables and expressions. The result is
  `0x0400 + row * 40 + col` (or `0xD800 + …`) as a `u16`. `row * 40` is built from shifts and adds:
  `row * 32 + row * 8`. Constant arguments still fold at compile time and keep their range checks.
- A row or column outside the screen is **not** checked at run time (the constant case is).

### 3. Array indexing

- `a[i]` reads and writes for:
  - `let @addr(ADDR) a: [u8; N];` and a plain `let a: [u8; N];` that fits the zero page;
  - the fields of a `data` block: `data @addr(T) { wave: [u8; 128] = […] }` makes `wave` an
    array you can index (`wave[i]`) and whose address `${wave}` / `wave` as a `u16` constant is
    the field's address (the follow-up recorded when named addresses landed).
- The index is a `u8` or `u16` expression of the usual restricted form. A constant index is
  checked against `N` at compile time; a runtime index is **not** bounds-checked.
- Element type is `u8` (and `bool`). `[u16; N]` is out of scope.

**Codegen.** `u8` index with a constant base: `LDX index` then `LDA base,X` / `STA base,X`.
`u16` index or zero-page base: base + index into `$FA/$FB`, then `LDY #0` and `LDA/STA ($FA),Y`.

### 4. Convert the showcases

- `character-art`: two nested `for` loops with `poke(screen(r, c), 0xA0)` and
  `poke(color(r, c), rows[r])`.
- `sprite-dance`: `poke(0xD000 + reg, wave[idx])` with `reg` and `idx` kept as `u8`/`u16`
  variables updated by addition.
- `flappy-bird`: `column()` becomes a loop over rows with `poke(screen(row, col), ch)`; the sky
  and ground become loops.
- `AGENTS.md`: the showcase guide drops "tables and loops over memory use `asm {}`".
- The "Not in the language yet" table loses the rows for `buf[i]` and 16-bit arithmetic as each
  lands; its tests are the checked record.

## Errors (all located)

- 16-bit value stored in a `u8` without `lo()`/`as u8` (unchanged).
- Constant array index `>= N`: `index 40 is out of range for 'a' (length 40)`.
- Indexing something that is not an array: `'x' is not an array`.
- `[u16; N]` element reads/writes: `arrays of u16 are not supported yet`.
- A right-hand operand that is not a literal/variable/constant/register keeps its existing hint.

## Non-goals

`*`, `/`, `%` at run time; `&&`/`||`; pointers (`ptr<u8>`) and structs; bounds checks at run
time; signed arithmetic; 2-D array syntax; a standard library of routines; changing `asm {}`.

## Compatibility

Every existing program compiles to the same bytes: the new paths are taken only where the
checker used to reject the program. `$F8–$FF` are reserved by the compiler (they were already
unallocated). A `data` field name that equals an existing variable or function name is a
duplicate-definition error, as for any two globals.

## Verification

1. **Per capability**: tests that fail first — arithmetic carry/borrow across the byte boundary
   (255+1, 0-1, 0x00FF+0x0001), mixed `u8`/`u16`, comparisons at the boundaries (0x00FF vs
   0x0100), loops of 1000 iterations; runtime `poke`/`peek` against constants; `screen(r, c)` for
   every corner and a mid cell against the constant form; indexing reads/writes at 0, N-1 and
   across a page boundary, both index widths.
2. **No regressions**: byte-for-byte equality of the existing showcases and playground examples
   compiled before and after, until step 4 rewrites them.
3. **Showcases**: the existing behavioural tests (`showcase-sources.test.ts`) pass unchanged
   against the rewritten sources; they are the contract that the conversion changes nothing the
   player sees. A test asserts that the three sources contain no `asm`.
4. Browser check of each rewritten showcase; full suite, typecheck and lint; guide samples
   (`docs-samples`, `docs-claims`) for every new row.

## Risks

- **Step 1 is the invasive one.** Expression codegen is 8-bit throughout; the two-register model
  keeps that path untouched and adds a parallel 16-bit path chosen by `isU16`. Mitigation: the
  byte-for-byte regression check above.
- **Speed.** A runtime `screen(r, c)` costs a few dozen cycles. The showcases use it for a
  one-off fill (≈1000 cells ≈ 0.1 s of emulated time) and per pipe step, which fits a frame.
- **Frame budget in `flappy-bird`.** The column loop moves from tight assembly to compiled
  statements; the step is already every 5th frame, and a test runs the game for hundreds of
  frames to confirm it keeps up with the raster sync.
