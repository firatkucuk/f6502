# f6502 sub-project 3: VIC-II complete (graphics modes, sprites, collisions)

Date: 2026-10-10
Status: draft, awaiting review
Parent: the project decomposition in `docs/superpowers/specs/2026-10-10-6502-core-design.md`
section 1 (this is sub-project 3 of 6). Builds on
`docs/superpowers/specs/2026-10-10-c64-machine-skeleton-design.md` section 7.

## 1. Goal and context

Complete the VIC-II so typical games and demos render correctly: all eight graphics modes, eight
sprites with priority and collisions, and scrolling with the new modes. The sub-project 2 VIC
already runs as a per-cycle state machine that emits 8 pixels per cycle; this work composes the new
modes and sprites per pixel inside that pipeline.

### Decisions made

- **Approach A:** per-pixel compositing inside the existing per-cycle pipeline. Registers are
  sampled per cycle, so mid-line changes (raster bars, mode switches) work for free and the
  structure is what sub-project 4 refines.
- **Verification:** our own test programs and unit tests with expected pixels derived from the
  VIC-II documentation (Bauer). Third-party VIC suites are deferred to sub-project 4.
- No public API change; the framebuffer API and the browser layer are untouched.

## 2. Scope

In scope:
- Graphics modes: standard/multicolour text, standard/multicolour bitmap, extended-colour (ECM)
  text, and the three invalid combinations (black, with foreground flags).
- Eight sprites: pointer and data fetch, DMA bookkeeping, hi-res and multicolour, X and Y
  expansion, the 9th X bit, priority against foreground graphics, sprite-sprite priority.
- Sprite-sprite and sprite-background collision registers and their IRQ flags.
- Scrolling (`XSCROLL`/`YSCROLL`) correct for every mode.
- A generated graphics test program and a real-browser acceptance run.

Out of scope: BA/AEC CPU stalls for badlines and sprite DMA, border opening, light pen, sprite
crunch and other cycle-exact quirks (sub-project 4); sound (5); disk/tape (6); CI and the Pages
site.

## 3. Code layout

| File | Responsibility |
|---|---|
| `src/machine/vic.ts` | registers, raster/IRQ, per-cycle state machine, compositing loop |
| `src/machine/vic-graphics.ts` | pure functions: mode table, per-cell pixel pairs and foreground flags |
| `src/machine/vic-sprites.ts` | `SpriteUnit` state: DMA bookkeeping, fetch, shifter, pixel output |

`VicII.debug` grows sprite state (`mcBase`, DMA and display flags) for tests. `C64`, `Player` and
`start()` are unchanged.

## 4. Graphics generator

`ECM` (`$D011` bit 6), `BMM` (`$D011` bit 5) and `MCM` (`$D016` bit 4) are sampled every cycle.

| ECM | BMM | MCM | Mode | Pixel source |
|---|---|---|---|---|
| 0 | 0 | 0 | Standard text | existing sub-project 2 behaviour |
| 0 | 0 | 1 | Multicolour text | colour-RAM bit 3 = 0: hi-res glyph in colour 0-7. Bit 3 = 1: pairs `00` -> `$D021`, `01` -> `$D022`, `10` -> `$D023`, `11` -> colour RAM bits 0-2 |
| 0 | 1 | 0 | Standard bitmap | bit set -> video-matrix high nibble, clear -> low nibble |
| 0 | 1 | 1 | Multicolour bitmap | pairs `00` -> `$D021`, `01` -> matrix high nibble, `10` -> matrix low nibble, `11` -> colour RAM |
| 1 | 0 | 0 | Extended-colour text | glyph index `code & $3F`; clear bits -> `$D021 + (code >> 6)`; set bits -> colour RAM |
| 1 | 0 | 1 | invalid | black |
| 1 | 1 | 0 | invalid | black |
| 1 | 1 | 1 | invalid | black |

**Foreground flag** (used for sprite priority and collisions), produced per pixel:
- Hi-res modes: the glyph/bitmap bit is set.
- Multicolour modes: the pair is `10` or `11`.
- Invalid modes render black but the flag follows the mode they resemble (ECM+BMM like bitmap,
  ECM+MCM like multicolour text).
- Outside the graphics cycles (16-55) the flag is false. The border does not clear it, and idle-state graphics (`$3FFF`/`$39FF`) set it for their set bits (amended in sub-project 4, pinned in `vic-deferred.test.ts`).

**G-access addresses**

| Case | Address |
|---|---|
| Text modes | `CB + code * 8 + RC`, `CB = $D018 bits 1-3 << 11` |
| Bitmap modes | `((CB bit 3) << 13) \| (VC << 3) \| RC` |
| Idle state | `$3FFF` (`$39FF` when ECM is set), shown with colour 0 |

`XSCROLL` delays the 8-pixel stream as in sub-project 2, so multicolour pair boundaries move with
it. The border logic, the 38/24 windows and `DEN` are unchanged.

## 5. Sprites

### 5.1 Registers

| Register | Meaning |
|---|---|
| `$D000/$D001 ... $D00E/$D00F` | sprite 0-7 X (low 8 bits) and Y |
| `$D010` | X bit 8 of each sprite |
| `$D015` | enable |
| `$D017` / `$D01D` | Y-expand / X-expand |
| `$D01B` | priority: 1 = behind foreground graphics |
| `$D01C` | multicolour |
| `$D025` / `$D026` | multicolour 0 / 1 (shared) |
| `$D027-$D02E` | per-sprite colour |
| `$D01E` / `$D01F` | sprite-sprite / sprite-background collision; a read returns and clears, `peek` does not clear, writes are ignored |

### 5.2 DMA bookkeeping (Bauer section 3.8)

Per sprite: `dma`, `display`, `mcBase`, `mc`, `expandFF`, a 24-bit data word, a shifter position.

1. **Cycle 55:** if Y-expand is set, toggle `expandFF` (it is held at 1 while Y-expand is clear).
2. **Cycles 55 and 56:** if the sprite is enabled, `Y == raster & $FF` and DMA is off, turn DMA on,
   clear `mcBase`, and if Y-expand is set clear `expandFF`.
3. **Cycle 58:** `mc = mcBase`; if DMA is off, `display` turns off; if DMA is on and
   `Y == raster & $FF`, `display` turns on.
4. **Cycles 15 / 16 of the next line:** if `expandFF` is set, `mcBase += 2` then `+= 1`; then if
   `mcBase == 63`, DMA turns off. (`display` stays on until cycle 58, so the last sprite row, which
   is drawn after cycle 16 of its line, is not clipped.)

Consequences pinned by tests: a sprite first appears on raster line `Y + 1` and runs 21 lines (42
with Y-expand).

### 5.3 Fetch timing (PAL, one fetch event per sprite, no CPU stall)

| Sprite | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|---|
| Fetch cycle | 58 | 60 | 62 | 1 | 3 | 5 | 7 | 9 |

At its cycle: pointer = `read(VM + $03F8 + n)`; if DMA is on, 3 data bytes at
`pointer * 64 + mc` and `mc += 3`. Sprites 3-7 therefore load at the start of the line they are
displayed on.

### 5.4 Pixel generation

All 504 pixels of every line are stepped, including outside the visible cycles, so a sprite that
starts at X = 490 still shows its tail at the left edge. The raster X of a pixel is `fx - 8`
(mod 504), the display-window convention, so sprite X = 24 lines up with the first text column.

- A shifter starts when `display` is on and the raster X equals the sprite's 9-bit X; it runs 24
  pixels (48 with X-expand).
- Hi-res: bit set -> sprite colour, clear -> transparent.
- Multicolour: pairs `00` transparent, `01` -> `$D025`, `10` -> sprite colour, `11` -> `$D026`.
- X-expand doubles every source pixel (a multicolour pair is then 4 pixels wide).
- X values 504-511 never match a PAL raster X, so those sprites are invisible.

## 6. Compositing, collisions and IRQ

Per pixel, in order:
1. The generator gives colour `g` and foreground flag `fg` (after `XSCROLL`).
2. Each active sprite gives a pixel or transparent; `mask` is the set of sprites opaque here.
3. **Collisions**, independent of the border and of priority: if `popcount(mask) >= 2` set those
   bits in `$D01E`; if `mask != 0 and fg` set those bits in `$D01F`.
4. **Visible sprite:** the lowest-numbered sprite in `mask`; hidden if its `$D01B` bit is set and
   `fg` is true (then `g` shows).
5. The border overrides everything inside the border area (sprites do not show over the border).

**IRQ flags (`$D019`):** bit 2 (sprite-sprite) is raised when `$D01E` goes from zero to non-zero;
bit 1 (sprite-background) when `$D01F` does. Further collisions while the register is non-zero do
not raise the flag again; reading the register clears it. Both are masked by `$D01A` bits 1-2
through the existing `irq` getter.

**Performance:** the per-pixel sprite work runs only when at least one sprite has `display` on for
the current line (a per-line `activeMask`). Lines without sprites keep the sub-project 2 fast path.

## 7. Example program and verification

- `scripts/build-graphics-prg.mjs` exports `buildGraphicsPrg()` and writes
  `examples/graphics-test.prg` (machine code at `$C000`, started with `SYS 49152`): multicolour
  bitmap with a known pattern, 8 sprites (hi-res, multicolour, expanded, one behind the
  foreground) and a border-colour change on collision.
- The conformance test imports the builder, boots OpenROMs, loads the program via `loadPrg`, and
  asserts exact framebuffer pixels.

| Tier | What |
|---|---|
| Unit | VIC with fake memory: every mode (pixels + flags), ECM background select, invalid modes, idle address, odd `XSCROLL` in multicolour bitmap, mid-frame mode switch; sprite lifetime, pointer/data addresses, pixels, expansion, 9th X bit, line-wrap straddle, collision registers (read clears, `peek` does not), IRQ transitions, priority, border hides sprites but collisions register, three-way overlap, performance guard |
| Machine | a synthetic KERNAL programs the VIC through the real bus |
| Conformance | OpenROMs + `graphics-test.prg` with exact-pixel assertions |
| Browser | real-browser run of `examples/basic.html?prg=graphics-test.prg`, screenshot committed under `docs/screenshots/` |

## 8. Definition of done

1. All unit tests pass, including the boundary rule.
2. The OpenROMs `graphics-test.prg` conformance test passes with exact-pixel assertions.
3. A real-browser screenshot shows the bitmap, the sprites and the collision indicator.
4. `lint`, `typecheck` and `build` are clean; the public bundle API is unchanged.
5. Headless throughput is at least 10x real time with 8 sprites active (reported, not a gate).
6. README status updated.

## 9. Risks and open items

- The sprite X offset convention (`fx = X + 8`) and the fetch cycle table follow Bauer's document
  but are not verified against hardware here; sub-project 4's third-party VIC suites verify them.
- Sprite-sprite collision timing relative to the fetch of sprites 3-7 is nominal until BA stalls
  exist.
- Splitting `vic.ts` must not change sub-project 2 behaviour: the existing VIC tests are the
  regression net and must pass unmodified.
