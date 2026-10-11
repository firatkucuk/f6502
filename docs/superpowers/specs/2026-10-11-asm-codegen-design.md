# `asm {}` code generation — Design

Date: 2026-10-11

## Goal

Make inline assembly work in C64Script. Today `asm { … }` parses but is a compile error ("not
supported yet"). After this change a program can drop to raw 6502 for loops, indexed stores and
anything the language cannot express, with variables and constants available by name.

This unblocks porting the Nyan Cat showcase to C64Script (its loops are `STA abs,X`) and runtime
screen positions later.

## Decisions

- **v1 scope** (confirmed): opcodes, labels, `${expr}` interpolation, `lo()`/`hi()`, `+`/`-`
  offsets. **Not in v1**: data directives (`.byte`), macros, bare program names without `${}`,
  undocumented opcodes, struct fields.
- **Single source of truth for encodings**: the assembler's (mnemonic, mode) → opcode table is
  derived at startup from `OPS` in `src/core/opcodes.ts` (official opcodes only). Nothing is
  duplicated, and tests round-trip every official opcode against it.
- **Program symbols need `${…}`**; bare identifiers are labels (as the language spec says).
- **One instruction per line.** The lexer discards newlines, so the parser recovers instruction
  boundaries from token line numbers.

## Syntax

```
asm {
  sei
  lda #$1B                // $hex, 0xhex, decimal, 'H' character literal
  sta $D011
  ldx #39
  lda #' '
clear:                    // label, scoped to this block
  sta ${screen(0, 0)},x   // ${ constant expression }
  dex
  bpl clear
  lda ${count}            // zero-page variable → zero-page operand
  cmp #${MAX}             // const → its value
  sta ${buf} + 1          // offset
  lda #lo(${TABLE})       // low byte of a constant
  jsr ${redraw}           // call a C64Script function
}
asm clobbers(A, X) { … }  // validated, otherwise informational
```

```
operand := ε | 'a' | '#' expr | expr | expr ',' ('x' | 'y')
         | '(' expr ',' 'x' ')' | '(' expr ')' ',' 'y' | '(' expr ')'
expr    := term (('+' | '-') number)*
term    := number | char | '${' constant-expression '}' | 'lo' '(' expr ')' | 'hi' '(' expr ')' | label
```

Mnemonics are case-insensitive; labels are case-sensitive. `//` comments already work.

## Semantics

### `${…}`
The braces hold an ordinary C64Script expression, resolved in the enclosing scope:

| Contents | Value |
|---|---|
| a `@zp`/un-annotated variable | its zero-page address |
| an `@addr` variable | its absolute address |
| a `const`, a colour, `screen()`/`color()`, any constant expression | its value |
| a function name (non-inline) | its entry address (`jsr ${f}` / `jmp ${f}`) |

`#${variable}` is an error (ambiguous: use `lo(${variable})`). `#${const}` is the value.

Stores to a named **`u8`/`bool` constant** (`sta ${MAX}`, `inc ${MAX}`) are an error: it is a data
value, so the address it would name is almost certainly a mistake. A **`u16` constant** or any
constant expression is an address and may be stored to (`sta ${TABLE},x`,
`sta ${screen(0, 0)},x`). Storing *through* a pointer (`sta (${PTR}),y`) is always allowed.

A name is either a variable or a function; declaring both is an error, so `f` and `${f}` always
agree. Only `jsr`/`jmp` count as calls (for recursion detection): `lda #lo(${f})` merely takes
the address.

### Addressing mode
Chosen from the operand syntax and the folded value:
- `#e` → immediate; value must be 0–255.
- `e` / `e,x` / `e,y` → zero page (`zp`, `zpx`, `zpy`) when the value is 0–255 **and** the
  instruction has that mode; otherwise absolute (`abs`, `abx`, `aby`). Example: `lda $10,y` has
  no zero-page,Y form, so it assembles as `aby` with `$0010`, as real assemblers do.
- Only a zero-page form exists and the value does not fit → error.
- `(e,x)`, `(e),y` → `izx`, `izy` (value must be 0–255); `(e)` → `ind` (JMP only).
- Branches take a label; the offset is resolved at link time.
- `a` or no operand on `asl/lsr/rol/ror` → accumulator.

### Labels
Scoped to the block and made unique per *emission* (an `@inline` function containing asm may be
expanded several times). A duplicate or undefined label is an error. A branch out of range
reports the label name and the line.

### Registers and `clobbers`
The compiler keeps no value in a register across statements, so any asm block is safe to insert.
`clobbers(A, X, Y, flags)` is validated (unknown names are an error) and otherwise informational.
Contract for the block's author: leave the stack balanced and the decimal flag clear.

### Errors (all located)
unknown mnemonic · undocumented/JAM opcode · mode not available for the instruction · value out
of range for the mode · undefined `${name}` or label · duplicate label · write to a constant ·
`#` on a variable · malformed operand · branch out of range.

## Components

| File | Change |
|---|---|
| `src/c64script/lexer.ts` | `$HEX` literals; `#` token |
| `src/c64script/ast.ts` | structured asm items (labels, instructions, operands) replace the raw-text `AsmInstr` |
| `src/c64script/parser.ts` | `parseAsm` builds structured items using token lines |
| `src/c64script/asm.ts` (new) | opcode table from the core, mode selection, encoding helpers |
| `src/c64script/checker.ts` | validate `clobbers`, resolve `${…}` names, record calls made by `jsr ${fn}` |
| `src/c64script/codegen.ts` | emit instructions, labels and fixups |
| `src/c64script/linker.ts` | branch-range error names the original label and line |
| `website/` | language reference section, a playground example, highlighter keywords |

## Verification

1. **Opcode round-trip**: for every official `OPS` entry, assemble a sample in its mode and expect
   that opcode byte.
2. **Operand forms**: every mode, `$`/`0x`/decimal/char, `lo`/`hi`, offsets, zp-vs-abs choice,
   `${…}` of zp/abs/const/function.
3. **Programs on the emulator core**: screen fill loop, zero-page variable updated from asm, a
   function called with `jsr ${f}`, asm inside an `@inline` function called twice (unique
   labels), forward and backward branches.
4. **Errors**: one test per message above, with line numbers.
5. Full suite, typecheck, lint; browser check of the playground example.

## Out of scope / follow-ups

Data directives and macros; undocumented opcodes; struct-field interpolation; using asm to give
`screen(row, col)` runtime arguments; the Nyan Cat port itself (next sub-project).
