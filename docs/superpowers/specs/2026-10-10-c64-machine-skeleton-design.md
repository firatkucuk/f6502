# f6502 sub-project 2: C64 machine skeleton and browser layer

Date: 2026-10-10
Status: draft, awaiting review
Parent: the project decomposition in `docs/superpowers/specs/2026-10-10-6502-core-design.md`
section 1 (this is sub-project 2 of 6).

## 1. Goal and context

Build a C64 machine on top of the finished cycle-accurate `core/` CPU (sub-project 1, merged) and a
browser layer, so that a page can include the library, attach it to a canvas, and see a working BASIC
prompt, type, and run a `.prg` loaded from a URL.

Done when (see section 11): `READY.` appears on the canvas in a real browser, typing works, and a
`.prg` fetched from a URL runs.

### Decisions already made (project level)

- TypeScript strict, ESM source, no runtime dependencies; ESM + IIFE (`F6502`) bundles.
- ROMs are never bundled. The demo uses OpenROMs (MEGA65/open-roms) by default with user-supplied
  original ROMs as an option.
- GitHub Actions CI and the GitHub Pages site are deferred until after verification (final phase).

### Decisions made for this sub-project

- **Approach A:** per-cycle chips driven by the CPU's `onCycle` hook, with a deliberately simple VIC-II
  (no badline CPU stalls). Sub-project 4 refines the VIC rather than rewriting it.
- **Loader:** `.prg` with smart start; explicit `{ address, start }` for raw binaries.
- **Timing:** PAL only (985,248 Hz, 63 cycles/line, 312 lines, 19,656 cycles/frame).
- **Keyboard:** symbolic mapping with a forced virtual shift.
- **No sound and no joystick** in this sub-project.

## 2. Scope

In scope:
- `src/machine/`: memory map and PLA banking, 6510 port, CIA1/CIA2, keyboard matrix, VIC-II standard
  text mode, `C64` orchestration, `.prg` parsing.
- `src/browser/`: `start()` / `Player`, canvas rendering, rAF loop, keyboard mapping, ROM and program
  fetching.
- A development demo page `examples/basic.html` and a dependency-free static server script.
- OpenROMs source added to the pinned test-data fetch script.

Out of scope (deferred): sound/SID (sub-project 5), joystick/paddles, bitmap/multicolour/ECM text and
sprites (3), badline stalls and cycle-exact VIC/CIA corner cases (4), disk/tape/IEC (6), cartridges,
NTSC, CI, Pages.

## 3. Architecture

```
src/core/      MOS6502, Bus                          (unchanged)
src/machine/   C64 and its chips                     (no DOM, no network; runs in Node)
src/browser/   canvas, keyboard, fetch, rAF loop
src/index.ts   re-exports all three
```

Dependencies point one way: `browser` -> `machine` -> `core`. ESLint forbids `machine/` importing
`browser/` (as it already forbids `core/` importing either).

### 3.1 `src/machine/` modules

| File | Responsibility |
|---|---|
| `memory.ts` | 64 KB RAM, 1 KB 4-bit colour RAM, ROM images, power-on RAM pattern |
| `bus.ts` | `C64Bus` implements the core `Bus`; page-table address decode |
| `cpu-port.ts` | 6510 on-chip port at `$00/$01` |
| `cia.ts` | `Cia` (MOS 6526), instantiated twice |
| `keyboard.ts` | 8x8 key matrix state |
| `vic.ts` | `VicII`: registers, raster, IRQ, standard text mode, framebuffer |
| `palette.ts` | the 16 C64 colours (Pepto) |
| `prg.ts` | `.prg` parsing and placement |
| `c64.ts` | `C64`: wires CPU + bus + chips, owns the cycle loop |

### 3.2 `src/browser/` modules

| File | Responsibility |
|---|---|
| `player.ts` | `start()`, `Player`, rAF loop, canvas presentation |
| `keymap.ts` | pure function: `KeyboardEvent`-like -> C64 keys + shift state |
| `loader.ts` | `fetch` and `Source` normalisation |

## 4. Public API

### 4.1 Machine (headless; used by tests and the browser layer)

```ts
interface RomSet { kernal: Uint8Array; basic: Uint8Array; chargen: Uint8Array }

class C64 {
  constructor(roms: RomSet, options?: { video?: 'pal' });
  reset(): void;
  runCycles(n: number): void;
  runFrame(): void;                           // one PAL frame = 19,656 cycles
  runUntilReady(maxFrames?: number): boolean; // true when READY. is on screen
  readonly frame: { width: 384; height: 272; pixels: Uint32Array };  // RGBA
  keyDown(key: C64Key): void;
  keyUp(key: C64Key): void;
  restore(): void;                            // RESTORE key: NMI pulse
  type(text: string): void;                   // KERNAL keyboard buffer ($0277, count at $C6)
  loadPrg(bytes: Uint8Array, opts?: { run?: 'auto' | 'basic' | 'sys' | 'none';
                                       address?: number; start?: number }): void;
  readonly cpu: MOS6502;
  peek(addr: number): number;                 // CPU-visible byte, no side effects
}
```

### 4.2 Browser

```ts
type Source = string /* URL */ | ArrayBuffer | Uint8Array | Blob | File;

interface StartOptions {
  canvas: string | HTMLCanvasElement;
  roms: { kernal: Source; basic: Source; chargen: Source };
  program?: Source | { source: Source; address?: number; start?: number };
  scale?: number | 'fit';                      // default 'fit'
  keyboardTarget?: 'canvas' | 'document';      // default 'canvas'
}

interface Player {
  readonly c64: C64;
  pause(): void; resume(): void; reset(): void;
  load(source: Source, opts?: LoadOptions): Promise<void>;
  type(text: string): void;
  destroy(): void;                             // cancel rAF, remove listeners
}

function start(options: StartOptions): Promise<Player>;
```

Page usage:

```html
<canvas id="screen"></canvas>
<script src="f6502.min.js"></script>
<script>
  F6502.start({ canvas: '#screen',
                roms: { kernal: 'kernal.rom', basic: 'basic.rom', chargen: 'chargen.rom' },
                program: 'game.prg' });
</script>
```

## 5. Memory, banking and the 6510 port

### 5.1 CPU memory map (no cartridge: `GAME=1`, `EXROM=1`)

| Range | Contents |
|---|---|
| `$0000-$0001` | 6510 port: DDR at `$00`, data at `$01` |
| `$0002-$9FFF` | RAM |
| `$A000-$BFFF` | BASIC ROM if `LORAM=1 and HIRAM=1`, else RAM (reads only; writes always go to RAM) |
| `$C000-$CFFF` | RAM |
| `$D000-$DFFF` | RAM / character ROM / I/O per the table below (writes to ROM-shadowed areas go to RAM) |
| `$E000-$FFFF` | KERNAL ROM if `HIRAM=1`, else RAM |

`$D000` window by `CHAREN HIRAM LORAM`:

| Condition | `$D000-$DFFF` shows |
|---|---|
| `HIRAM=0 and LORAM=0` | RAM |
| `HIRAM=0 and CHAREN=0` | RAM |
| `CHAREN=1` (otherwise) | I/O |
| `CHAREN=0 and HIRAM=1` | character ROM |

I/O window:

| Range | Chip | This sub-project |
|---|---|---|
| `$D000-$D3FF` | VIC-II | registers mirrored every 64 bytes; `$D02F-$D03F` read `$FF` |
| `$D400-$D7FF` | SID | stub: writes accepted, reads `$FF` |
| `$D800-$DBFF` | colour RAM | 4-bit; the upper nibble reads as 1s |
| `$DC00-$DCFF` | CIA1 | mirrored every 16 bytes |
| `$DD00-$DDFF` | CIA2 | mirrored every 16 bytes |
| `$DE00-$DFFF` | expansion I/O | reads `$FF` |

### 5.2 6510 port

- Banking uses the effective bits `(data | ~DDR) & 0x07`; at power-up (DDR=0) pull-ups give
  `LORAM=HIRAM=CHAREN=1`.
- Reading `$01`: output bits return `data`; input bits return 1 (bit 4, cassette sense, reads 1 with no
  datasette); bits 6-7 read 0 (capacitor decay not modelled).
- CPU writes to `$00/$01` do not touch the RAM underneath; the VIC still sees that RAM.

### 5.3 Implementation and validation

- A 256-entry page table (one per 256-byte page) holds `RAM | BASIC | KERNAL | CHARGEN | IO`, rebuilt
  only when `$00` or `$01` changes.
- ROM images must be exactly 8192 (kernal), 8192 (basic), 4096 (chargen) bytes, otherwise `RomError`
  names the image and both sizes.
- Power-on RAM uses the standard C64 pattern (alternating 64-byte blocks of `$00`/`$FF`).
- `peek(addr)` returns the CPU-visible byte without side effects (I/O registers included).

### 5.4 VIC's memory view

14-bit address plus bank `~CIA2.PRA & 3`. In banks 0 and 2, `$1000-$1FFF` reads the character ROM
instead of RAM. Colour RAM is read on a separate 4-bit path.

## 6. CIAs and keyboard

### 6.1 `Cia` (MOS 6526), ticked once per CPU cycle

| Register | Behaviour |
|---|---|
| `$0-$3` ports/DDRs | output bits drive the pin; input bits read the external value (pull-up = 1) |
| `$4-$7` timers A/B | 16-bit down-counters with latch; start, one-shot, force-load, input from phi2 / TA underflow (Timer B); writing the high latch byte while stopped also loads the counter |
| `$D` ICR | read returns pending flags (bit 7 = any enabled flag set) and clears flags and the IRQ line; write with bit 7=1 sets mask bits, bit 7=0 clears them |
| `$8-$B` TOD | BCD tenths/sec/min/hour from cycles (~98,525 cycles per tenth on PAL), hour-read latch, alarm (ICR bit 2) |
| `$C` SDR | stored; no serial shifting (ICR bit 3 never fires) |
| FLAG pin | `setFlag(level)` exposed; not wired yet |

- IRQ line: `(pendingFlags & mask) != 0`, level.
- Timing: cycle-stepped with the 1-cycle start delay and 1-cycle delayed IRQ after underflow. Corner
  cases (ICR read on the exact underflow cycle, PB6/PB7 timer output toggling) are deferred to
  sub-project 4.

### 6.2 Wiring (in `C64`)

| Signal | Source | Destination |
|---|---|---|
| IRQ | CIA1 or VIC-II (wired-OR, level) | CPU `setIrq` |
| NMI | CIA2 or RESTORE (edge) | CPU `setNmi` |
| CIA1 PRA | out = keyboard column select; in = joystick 2 (reads 1) | |
| CIA1 PRB | in = keyboard rows; out = joystick 1 (reads 1) | |
| CIA2 PRA bits 0-1 | out = VIC bank (`~PRA & 3`) | VIC memory view |
| CIA2 PRA bits 6-7 | IEC CLK IN / DATA IN: read 1 (idle bus) | |
| CIA2 PRB | user port: inputs read 1 | |

With nothing on the IEC bus, a disk `LOAD` reports DEVICE NOT PRESENT.

### 6.3 Keyboard matrix

```
          PB7    PB6   PB5  PB4   PB3   PB2   PB1   PB0
PA7:      STOP    Q    C=   SPACE  2    CTRL  <-    1
PA6:      /       ^    =    RSHIFT HOME ;     *     £
PA5:      ,       @    :    .      -    L     P     +
PA4:      N       O    K    M      0    J     I     9
PA3:      V       U    H    B      8    G     Y     7
PA2:      X       T    F    C      6    D     R     5
PA1:      LSHIFT  E    S    Z      4    A     W     3
PA0:      CRSR↓   F5   F3   F1     F7   CRSR→ RETURN DEL
```

- `press(key)` / `release(key)` are reference-counted.
- Scanning works in both directions (columns via PRA read through PRB, and the reverse).
- RESTORE is not in the matrix: `restore()` pulses the NMI line.

## 7. VIC-II

Scope: standard hi-res text mode, border, display window, colours, raster counter and raster IRQ.
Bitmap, multicolour, ECM and sprites are sub-project 3; a program selecting one of those modes renders
as standard text meanwhile (documented).

### 7.1 Registers `$D000-$D02E`

Behave as on hardware including unused bits reading 1:
- `$D011/$D012`: `ECM BMM DEN RSEL YSCROLL`; raster compare bit 8 and low byte; reads return the
  current raster.
- `$D016`: `MCM CSEL XSCROLL`. `$D018`: video matrix and character base.
- `$D019` IRQ status (write 1 to clear), `$D01A` IRQ enable.
- `$D020-$D026` read back `value | $F0`.
- Sprite registers are stored and read back; nothing renders; collisions read 0.

### 7.2 Timing and IRQ

63 cycles/line, 312 lines, 19,656 cycles/frame. The raster IRQ fires on the comparison going from false
to true (checked at the start of each line and when `$D011/$D012` is written); rewriting the same value
does not retrigger. VIC IRQ line = `(status & enable & $0F) != 0`.

### 7.3 Per-cycle state machine (Bauer VIC-II document, section 3.7)

- `VCBASE` cleared at raster line 0; at the start of each line `VC = VCBASE`; `RC = 0` on a badline
  (raster in `$30-$F7`, `raster & 7 == YSCROLL`, `DEN` set on `$30`).
- Video matrix line buffer is filled on badlines and replayed for the 8 pixel lines.
- End of line: if `RC == 7`, `VCBASE = VC`; otherwise `RC` increments. Idle state outside the window.
- g-access cycles 16-55 produce the 40 columns. Each cycle reads character code, colour nibble and
  glyph byte directly with **no CPU stall** (documented approximation; sub-project 4 adds BA/AEC).
- 8 pixels per cycle: foreground from the colour nibble, background `$D021`; `XSCROLL` is a delay of 0-7
  pixels using the previous cycle's pixels.
- Border colour `$D020` outside the window; CSEL (38/40 columns) and RSEL (24/25 rows) shrink the
  window; `DEN=0` makes the whole frame border.

### 7.4 Framebuffer

`384 x 272`, `Uint32Array` RGBA, Pepto palette. Visible cycles per line 12-59 (48 cycles = 384 px: 4
left border, 40 display, 4 right border). Visible raster lines 15-286 (36 border lines, 200 display
lines 51-250, 36 border lines).

## 8. Browser layer

### 8.1 Rendering and loop

- Canvas stays 384x272, drawn with `putImageData` once per presented frame; CSS
  `image-rendering: pixelated`. `scale` is an integer multiplier; `'fit'` keeps your CSS box.
- `requestAnimationFrame` with a fractional accumulator at 50.1245 Hz (985,248 / 19,656); elapsed time
  clamped; at most 5 frames per tick.

### 8.2 Keyboard (`keymap.ts`, pure function)

- Canvas gets `tabindex=0` and focuses on click; handled keys call `preventDefault`; blur releases all
  keys.
- Symbolic mapping by `event.key`: letters to their C64 letter keys with a held PC Shift passed through
  as C64 SHIFT; a character table decides shift for symbols, forcing the **virtual shift** on or off so
  Shift+2 gives `"` on both machines.
- Specials:

| PC key | C64 key |
|---|---|
| Enter | RETURN |
| Backspace | INST/DEL (Shift = INST) |
| Esc | RUN/STOP |
| Tab | CTRL |
| Left Ctrl | C= |
| Shift+Home | CLR |
| Arrows | CRSR keys (left and up add SHIFT) |
| F2/F4/F6/F8 | SHIFT+F1/F3/F5/F7 |
| Page Up | RESTORE (NMI) |

### 8.3 Program loading

1. Run frames until `READY.` is in screen RAM (scan, ROM-independent), at most 600 frames (12 s
   emulated). On timeout load anyway, then reject with `ReadyTimeoutError`.
2. Parse: first 2 bytes are the little-endian load address; fewer than 3 bytes or data past `$FFFF`
   throws `PrgError` and writes nothing.
3. Copy straight into RAM at the load address, ignoring ROM banking.
4. Start:
   - load address `$0801`: set `VARTAB/ARYTAB/STREND` (`$2D-$32`) to the end of the program, then type
     `RUN` + RETURN;
   - any other address: type `SYS <address>` + RETURN (a typed `SYS` returns cleanly to `READY.`; a
     direct PC jump from inside BASIC's input loop would not);
   - explicit `{ address, start }`: copy at `address`, then `SYS <start>` (default `start = address`).
   The longest typed string, `SYS 65535` + RETURN, is 10 characters and fits the KERNAL's 10-byte
   keyboard buffer exactly.

### 8.4 Errors and sources

| Situation | Behaviour |
|---|---|
| ROM wrong size | `RomError` (image, expected, actual) |
| `fetch` fails or non-2xx | rejects with `LoadError` (URL, status) |
| PRG truncated or overruns `$FFFF` | `PrgError`; nothing written to RAM |
| `READY.` never appears within 12 s emulated | load proceeds, then `ReadyTimeoutError` |
| unmapped bus access | open-bus rules of section 5; the machine never throws mid-frame |

`File`/`Blob`/`ArrayBuffer` sources support `<input type="file">` for user-supplied ROMs and programs.
Cross-origin URLs need CORS headers (documented in the README).

## 9. Test data and ROMs

- `scripts/fetch-test-data.mjs` gains an `openroms` source: `MEGA65/open-roms` at a pinned commit SHA
  with SHA-256 checksums: `bin/kernal_generic.rom`, `bin/basic_generic.rom`,
  `bin/chargen_openroms.rom` plus `LICENSE`/`COPYING`, into the git-ignored `.testdata/openroms/`.
- `scripts/serve.mjs` (`npm run example`) is a dependency-free static server so `examples/basic.html`
  can load those ROMs by relative URL.
- Before the Pages-site phase, the OpenROMs licence is confirmed from the fetched `LICENSE` and recorded
  in `docs/test-data-notes.md`. This gates only future demo hosting.

## 10. Testing

| Tier | What | Needs network |
|---|---|---|
| Unit (`npm test`) | banking table, CIA timers/ICR/TOD, keyboard matrix, VIC registers/raster/IRQ/pixels, PRG parser, keymap, player with fakes; machine integration with a **synthetic 8 KB KERNAL** built in the test | no |
| Conformance (`npm run test:conformance`) | OpenROMs boot to `READY.`; typed `PRINT 2+2`; a fixture BASIC `.prg` runs; a fixture machine-code `.prg` runs via `SYS` and returns to `READY.` | fetched once |
| Browser acceptance | real browser loads `examples/basic.html`; screenshots recorded in the PR | local |

Specific unit cases:
- All 8 `CHAREN/HIRAM/LORAM` combinations map `$A000`, `$D000`, `$E000` per section 5; writes under ROM
  land in RAM; DDR/data interplay; I/O mirroring; character-ROM shadow in VIC banks 0 and 2 only.
- Timer A underflow/reload/one-shot/force-load; ICR mask set/clear and read-clears; Timer B cascade; TOD
  BCD rollover and hour latch; keyboard scan in both directions, two simultaneous keys, DDR masking;
  CIA2 PRA gives the right VIC bank; CIA1 raises IRQ, CIA2 and RESTORE raise NMI as edges.
- VIC register masks/read-back; one frame = 19,656 cycles, raster wraps 311 -> 0; raster IRQ fires once,
  clears via `$D019`, no retrigger on rewrite of the same value; known screen/colour RAM renders a known
  pixel pattern at known framebuffer coordinates; border/background colours; 38-column and 24-row
  windows; `XSCROLL`; `DEN=0`; `VCBASE` ends the frame at 1000.
- Keymap: every special key, shift forcing for symbols, shift passthrough for letters; PRG parser
  (valid, truncated, overflow); BASIC pointer fixup; `type()` chunking.

## 11. Definition of done

1. All unit tests pass, including the boundary rule (`machine/` may not import `browser/`).
2. Headless OpenROMs boot reaches `READY.` and accepts typed input (`PRINT 2+2`).
3. A BASIC `.prg` and a machine-code `.prg` run correctly through `program` / `load`.
4. Browser acceptance: the example page shows `READY.` in a real browser, typing works, and a `.prg`
   runs; screenshots attached to the PR.
5. `lint`, `typecheck` and `build` are clean; the ESM and IIFE bundles load and export `C64` and
   `start`.
6. Headless throughput is at least 10x real time in Node (reported, not a hard gate).

## 12. Risks and open items for planning

- OpenROMs may exercise chip behaviour not yet modelled (e.g. raster-based PAL/NTSC detection loops,
  SID reads at boot). The conformance boot test exposes these; the plan reserves explicit debugging
  time and fixes them in the machine layer.
- The cycle-to-pixel constants follow Bauer's document (g-accesses on cycles 16-55); sub-project 4
  verifies them against VIC test suites.
- The OpenROMs licence for hosting the ROM binaries on the demo site is confirmed before the Pages
  phase (section 9).
- Exact SHAs and checksums for the OpenROMs files are pinned by the fetch script's `--pin` mode during
  implementation.
