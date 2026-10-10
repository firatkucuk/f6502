# f6502 VIC-II Complete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the VIC-II: all eight graphics modes, eight sprites with priority and collisions, correct scrolling, composited per pixel inside the existing per-cycle pipeline, verified by exact-pixel tests and a real-browser run.

**Architecture:** `vic.ts` keeps registers, raster/IRQ and the per-cycle state machine; a pure `vic-graphics.ts` turns fetched cell data into 8 pixels plus foreground flags per mode; `vic-sprites.ts` owns sprite DMA bookkeeping, fetches and shifters. `VicII.outputCycle` composites graphics, sprites, collisions and border for every pixel.

**Tech Stack:** TypeScript (strict), Vitest, ESLint, Prettier, Node LTS. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-10-vic-ii-complete-design.md`

## Global Constraints

- PAL only: 63 cycles/line, 312 lines; framebuffer `384 x 272` RGBA, visible cycles 12-59, visible raster lines 15-286, display window at framebuffer `x = 32..351`, `y = 36..235` (raster 51..250). Raster X of a framebuffer pixel is `fx - 8` (mod 504).
- `src/machine/` stays DOM-free and may not import `src/browser/`.
- No public API change (`C64`, `Player`, `start()`); `VicII.debug` may grow.
- The existing sub-project 2 VIC tests (`test/machine/vic.test.ts`) must keep passing **unmodified**.
- No runtime dependencies; nothing third-party is vendored.
- Out of scope: BA/AEC CPU stalls, border opening, light pen, sprite crunch (sub-project 4); sound; media; CI; Pages site.
- Every commit message ends with these trailers:
  `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01QAsVffzaJc51Ncx7uyv5AK`.
- Report verification with real command output; never claim a suite passes without running it.

## Spec amendment made while planning

Spec section 5.2 item 4 originally turned `display` off at cycle 16 together with DMA. That would
clip the 21st sprite row (it is drawn after cycle 16 of its line). The spec was amended: DMA turns
off at cycle 16, `display` turns off at cycle 58 when DMA is off. The plan follows the amended spec.

## Review Focus

Input classes the spec implies but that are easy to get wrong. Each has a test in the owning task:

1. **Sprite lifetime off-by-one**: first row on raster `Y + 1`, exactly 21 rows (42 with Y-expand), the last row not clipped (Task 3).
2. **Line wrap**: a sprite starting at X = 490 shows its tail at the left edge and collides there although its first pixels are in invisible cycles; X = 504-511 never matches (Task 3).
3. **Collision flags**: raised only on the zero-to-non-zero transition, a read clears the register, `peek` does not, and collisions register under the border and for sprites that are behind the foreground (Task 4).
4. **Invalid modes**: render black but keep their foreground flags (so priority/collisions still work); idle access uses `$39FF` with ECM (Tasks 1, 2).
5. **Odd XSCROLL in multicolour bitmap**: pair boundaries move with the delay, and the previous cell's last pixel bleeds into the next cell (Task 2).
6. **Mid-frame mode switch**: registers are sampled per cycle, not per frame (Task 2).

---

## File Structure

```
src/machine/vic-graphics.ts   renderGraphics(): pure per-cell pixel generator
src/machine/vic-sprites.ts    Sprites: DMA bookkeeping, fetch, shifters
src/machine/vic.ts            modified: modes, compositing, collision registers
scripts/build-graphics-prg.mjs      generates examples/graphics-test.prg
scripts/build-graphics-prg.d.mts    type declaration for the builder
examples/graphics-test.prg
test/machine/vic-graphics.test.ts   Task 1
test/machine/vic-modes.test.ts      Task 2
test/machine/vic-sprites.test.ts    Task 3 (Sprites unit)
test/machine/vic-compose.test.ts    Task 4 (VicII sprites, collisions, IRQ)
test/machine/graphics-machine.test.ts   Task 5 (synthetic KERNAL)
test/machine/vic-helpers.ts         shared RAM-backed VIC world
test/conformance/graphics.test.ts   Task 6 (OpenROMs + graphics-test.prg)
```

---

### Task 1: Graphics generator (`vic-graphics.ts`)

**Files:**
- Create: `src/machine/vic-graphics.ts`
- Test: `test/machine/vic-graphics.test.ts`

**Interfaces:**
- Produces: `renderGraphics(color: Uint8Array, fg: Uint8Array, mode: number, glyph: number, code: number, nibble: number, bg: Uint8Array): void` where `mode = ECM << 2 | BMM << 1 | MCM`, `glyph` is the g-access byte, `code` the video-matrix byte, `nibble` the colour-RAM nibble, `bg` the four background colours (`$D021-$D024`). It fills `color[0..7]` (colour index 0-15) and `fg[0..7]` (0/1).

- [ ] **Step 1: Write the failing test**

`test/machine/vic-graphics.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { renderGraphics } from '../../src/machine/vic-graphics';

const BG = Uint8Array.from([6, 2, 3, 4]);

function render(mode: number, glyph: number, code: number, nibble: number) {
  const color = new Uint8Array(8);
  const fg = new Uint8Array(8);
  renderGraphics(color, fg, mode, glyph, code, nibble, BG);
  return { color: [...color], fg: [...fg] };
}

describe('standard text (mode 0)', () => {
  it('foreground from the colour nibble, background $D021', () => {
    const r = render(0b000, 0b1010_0101, 0, 1);
    expect(r.color).toEqual([1, 6, 1, 6, 6, 1, 6, 1]);
    expect(r.fg).toEqual([1, 0, 1, 0, 0, 1, 0, 1]);
  });
});

describe('multicolour text (mode 1)', () => {
  it('colour bit 3 set: pairs 00/01/10/11 -> $D021/$D022/$D023/colour&7; fg for 10 and 11', () => {
    const r = render(0b001, 0b00_01_10_11, 0, 0x0d);
    expect(r.color).toEqual([6, 6, 2, 2, 3, 3, 5, 5]);
    expect(r.fg).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
  });

  it('colour bit 3 clear: behaves as hi-res with foreground colour 0-7', () => {
    const r = render(0b001, 0xf0, 0, 5);
    expect(r.color).toEqual([5, 5, 5, 5, 6, 6, 6, 6]);
    expect(r.fg).toEqual([1, 1, 1, 1, 0, 0, 0, 0]);
  });
});

describe('standard bitmap (mode 2)', () => {
  it('set bits use the matrix high nibble, clear bits the low nibble', () => {
    const r = render(0b010, 0xf0, 0x1c, 7);
    expect(r.color).toEqual([1, 1, 1, 1, 12, 12, 12, 12]);
    expect(r.fg).toEqual([1, 1, 1, 1, 0, 0, 0, 0]);
  });
});

describe('multicolour bitmap (mode 3)', () => {
  it('pairs: 00 -> $D021, 01 -> high nibble, 10 -> low nibble, 11 -> colour RAM', () => {
    const r = render(0b011, 0b00_01_10_11, 0x1c, 5);
    expect(r.color).toEqual([6, 6, 1, 1, 12, 12, 5, 5]);
    expect(r.fg).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
  });
});

describe('extended-colour text (mode 4)', () => {
  it('clear bits take the background selected by the top two code bits', () => {
    expect(render(0b100, 0xf0, 0x41, 7).color).toEqual([7, 7, 7, 7, 2, 2, 2, 2]); // $D022
    expect(render(0b100, 0xf0, 0xc1, 7).color).toEqual([7, 7, 7, 7, 4, 4, 4, 4]); // $D024
    expect(render(0b100, 0xf0, 0x01, 7).fg).toEqual([1, 1, 1, 1, 0, 0, 0, 0]);
  });
});

describe('invalid modes (5, 6, 7)', () => {
  it('render black but keep the foreground pattern of the mode they resemble', () => {
    const m5 = render(0b101, 0b00_01_10_11, 0, 8);
    expect(m5.color).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(m5.fg).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
    const m5hires = render(0b101, 0xf0, 0, 0);
    expect(m5hires.color).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(m5hires.fg).toEqual([1, 1, 1, 1, 0, 0, 0, 0]);
    const m6 = render(0b110, 0xf0, 0x1c, 5);
    expect(m6.color).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(m6.fg).toEqual([1, 1, 1, 1, 0, 0, 0, 0]);
    const m7 = render(0b111, 0b00_01_10_11, 0x1c, 5);
    expect(m7.color).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(m7.fg).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/machine/vic-graphics.test.ts`
Expected: FAIL — cannot resolve `vic-graphics`.

- [ ] **Step 3: Write `src/machine/vic-graphics.ts`**

```ts
/**
 * Pure per-cell pixel generator for the VIC-II graphics modes.
 * mode = ECM << 2 | BMM << 1 | MCM.
 */

function hires(color: Uint8Array, fg: Uint8Array, glyph: number, on: number, off: number): void {
  for (let i = 0; i < 8; i++) {
    const bit = (glyph >> (7 - i)) & 1;
    color[i] = bit ? on : off;
    fg[i] = bit;
  }
}

function multi(
  color: Uint8Array,
  fg: Uint8Array,
  glyph: number,
  c0: number,
  c1: number,
  c2: number,
  c3: number,
): void {
  for (let p = 0; p < 4; p++) {
    const v = (glyph >> (6 - 2 * p)) & 3;
    const c = v === 0 ? c0 : v === 1 ? c1 : v === 2 ? c2 : c3;
    const f = v >> 1; // pairs 10 and 11 are foreground
    color[2 * p] = c;
    color[2 * p + 1] = c;
    fg[2 * p] = f;
    fg[2 * p + 1] = f;
  }
}

export function renderGraphics(
  color: Uint8Array,
  fg: Uint8Array,
  mode: number,
  glyph: number,
  code: number,
  nibble: number,
  bg: Uint8Array,
): void {
  switch (mode) {
    case 0: // standard text
      hires(color, fg, glyph, nibble, bg[0]!);
      return;
    case 1: // multicolour text
      if (nibble & 8) multi(color, fg, glyph, bg[0]!, bg[1]!, bg[2]!, nibble & 7);
      else hires(color, fg, glyph, nibble, bg[0]!);
      return;
    case 2: // standard bitmap
      hires(color, fg, glyph, code >> 4, code & 15);
      return;
    case 3: // multicolour bitmap
      multi(color, fg, glyph, bg[0]!, code >> 4, code & 15, nibble);
      return;
    case 4: // extended-colour text
      hires(color, fg, glyph, nibble, bg[(code >> 6) & 3]!);
      return;
    case 5: // ECM + MCM: black, flags like multicolour text
      if (nibble & 8) multi(color, fg, glyph, 0, 0, 0, 0);
      else hires(color, fg, glyph, 0, 0);
      return;
    case 6: // ECM + BMM: black, flags like standard bitmap
      hires(color, fg, glyph, 0, 0);
      return;
    default: // 7: ECM + BMM + MCM: black, flags like multicolour bitmap
      multi(color, fg, glyph, 0, 0, 0, 0);
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/machine/vic-graphics.test.ts && npm run typecheck && npm run lint`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(machine): pure VIC-II graphics-mode generator with foreground flags" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01QAsVffzaJc51Ncx7uyv5AK"
```

---

### Task 2: Wire the modes into `VicII` (addressing, idle, scrolling)

**Files:**
- Modify: `src/machine/vic.ts` (`outputCycle` and fields)
- Create: `test/machine/vic-helpers.ts`
- Test: `test/machine/vic-modes.test.ts`

**Interfaces:**
- Consumes: `renderGraphics`.
- Produces: `VicII` renders all eight modes; the pixel/foreground arrays `gColor/gFg` (current cycle) and `shiftedColor/shiftedFg` (after XSCROLL) used by Task 4.
- `vic-helpers.ts` exports `vicWorld()` (16 KB RAM-backed VIC with `ram`, `color`, `vic`) and `px(vic, x, y)`, `runFrames(vic, n)`.

- [ ] **Step 1: Write the shared helper and the failing tests**

`test/machine/vic-helpers.ts`:
```ts
import { FRAME_WIDTH, VicII } from '../../src/machine/vic';

/** A VIC backed by 16 KB of RAM and 1 KB of colour RAM; video matrix at $0400 once $D018 = $1x. */
export function vicWorld() {
  const ram = new Uint8Array(0x4000);
  const color = new Uint8Array(0x400);
  const vic = new VicII({
    readMem: (a) => ram[a & 0x3fff]!,
    readColor: (i) => color[i & 0x3ff]!,
  });
  return { vic, ram, color };
}

export const px = (vic: VicII, x: number, y: number): number => vic.frame[y * FRAME_WIDTH + x]!;

export function runFrames(vic: VicII, n: number): void {
  for (let i = 0; i < n; i++) {
    const f = vic.frameCount;
    while (vic.frameCount === f) vic.tick();
  }
}

/** Framebuffer coordinate of pixel (px, line) inside text cell (col, row). */
export const cellX = (col: number, p = 0): number => 32 + col * 8 + p;
export const cellY = (row: number, line = 0): number => 36 + row * 8 + line;
```

`test/machine/vic-modes.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { PALETTE } from '../../src/machine/palette';
import { cellX, cellY, px, runFrames, vicWorld } from './vic-helpers';

const P = (i: number) => PALETTE[i]!;

function common(w: ReturnType<typeof vicWorld>, d011: number, d016 = 0x08, d018 = 0x12) {
  w.vic.write(0x11, d011);
  w.vic.write(0x16, d016);
  w.vic.write(0x18, d018);
  w.vic.write(0x20, 0x0e); // border
  w.vic.write(0x21, 0x06); // $D021
  w.vic.write(0x22, 0x02); // $D022
  w.vic.write(0x23, 0x03); // $D023
  w.vic.write(0x24, 0x04); // $D024
}

describe('multicolour text through the VIC', () => {
  it('draws multicolour and hi-res cells side by side', () => {
    const w = vicWorld();
    common(w, 0x1b, 0x18);
    w.ram[0x0400] = 1;
    w.ram[0x0401] = 2;
    w.color[0] = 0x0d; // multicolour, foreground 5
    w.color[1] = 0x05; // hi-res, foreground 5
    w.ram[0x0808] = 0b00_01_10_11; // code 1 glyph row 0
    w.ram[0x0810] = 0xf0; // code 2 glyph row 0
    runFrames(w.vic, 2);
    const row = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => px(w.vic, cellX(0, i), cellY(0)));
    expect(row).toEqual([P(6), P(6), P(2), P(2), P(3), P(3), P(5), P(5)]);
    const hires = [0, 3, 4, 7].map((i) => px(w.vic, cellX(1, i), cellY(0)));
    expect(hires).toEqual([P(5), P(5), P(6), P(6)]);
  });
});

describe('bitmap modes through the VIC', () => {
  it('standard bitmap: bitmap base from $D018 bit 3, colours from the matrix byte', () => {
    const w = vicWorld();
    common(w, 0x3b, 0x08, 0x18); // BMM, bitmap at $2000, matrix at $0400
    w.ram[0x0400] = 0x1c;
    w.ram[0x2000] = 0xf0; // cell 0, row 0
    runFrames(w.vic, 2);
    expect(px(w.vic, cellX(0, 0), cellY(0))).toBe(P(1));
    expect(px(w.vic, cellX(0, 3), cellY(0))).toBe(P(1));
    expect(px(w.vic, cellX(0, 4), cellY(0))).toBe(P(12));
    expect(px(w.vic, cellX(0, 7), cellY(0))).toBe(P(12));
  });

  it('bitmap addressing advances by cell (VC << 3) and by pixel row (RC)', () => {
    const w = vicWorld();
    common(w, 0x3b, 0x08, 0x18);
    w.ram[0x0401] = 0x2d; // cell 1: hi 2, lo 13
    w.ram[0x2008 + 3] = 0x80; // cell 1, row 3: leftmost pixel set
    runFrames(w.vic, 2);
    expect(px(w.vic, cellX(1, 0), cellY(0, 3))).toBe(P(2));
    expect(px(w.vic, cellX(1, 1), cellY(0, 3))).toBe(P(13));
    expect(px(w.vic, cellX(1, 0), cellY(0, 2))).toBe(P(13));
  });

  it('multicolour bitmap pairs', () => {
    const w = vicWorld();
    common(w, 0x3b, 0x18, 0x18);
    w.ram[0x0400] = 0x1c;
    w.color[0] = 0x05;
    w.ram[0x2000] = 0b00_01_10_11;
    runFrames(w.vic, 2);
    const row = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => px(w.vic, cellX(0, i), cellY(0)));
    expect(row).toEqual([P(6), P(6), P(1), P(1), P(12), P(12), P(5), P(5)]);
  });

  it('an odd XSCROLL moves the pair boundaries and bleeds the last pixel into the next cell', () => {
    const w = vicWorld();
    common(w, 0x3b, 0x18 | 1, 0x18);
    w.ram[0x0400] = 0x1c;
    w.color[0] = 0x05;
    w.ram[0x2000] = 0b00_01_10_11;
    runFrames(w.vic, 2);
    const row = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => px(w.vic, cellX(0, i), cellY(0)));
    expect(row).toEqual([P(6), P(6), P(6), P(1), P(1), P(12), P(12), P(5)]);
    expect(px(w.vic, cellX(1, 0), cellY(0))).toBe(P(5)); // last pixel of cell 0 delayed into cell 1
  });
});

describe('extended-colour text through the VIC', () => {
  it('takes the background from the top two bits of the character code', () => {
    const w = vicWorld();
    common(w, 0x5b);
    w.ram[0x0400] = 0x41; // glyph 1, background $D022
    w.color[0] = 7;
    w.ram[0x0808] = 0xf0;
    runFrames(w.vic, 2);
    expect(px(w.vic, cellX(0, 0), cellY(0))).toBe(P(7));
    expect(px(w.vic, cellX(0, 4), cellY(0))).toBe(P(2));
  });
});

describe('invalid modes through the VIC', () => {
  it('ECM + BMM renders black inside the window', () => {
    const w = vicWorld();
    common(w, 0x7b, 0x08, 0x18);
    w.ram[0x0400] = 0x1c;
    w.ram[0x2000] = 0xff;
    runFrames(w.vic, 2);
    expect(px(w.vic, cellX(0, 0), cellY(0))).toBe(P(0));
    expect(px(w.vic, cellX(5, 0), cellY(3))).toBe(P(0));
    expect(px(w.vic, 0, 0)).toBe(P(14)); // border unaffected
  });
});

describe('idle state graphics', () => {
  // YSCROLL = 7: the window top is raster 51 but the first badline is raster 55, so
  // rasters 51-54 are idle lines inside the window (framebuffer rows 36-39).
  it('reads $3FFF in idle lines: set bits black, clear bits $D021', () => {
    const w = vicWorld();
    common(w, 0x1f);
    w.ram[0x3fff] = 0xaa;
    runFrames(w.vic, 2);
    expect(px(w.vic, cellX(0, 0), 36)).toBe(P(0));
    expect(px(w.vic, cellX(0, 1), 36)).toBe(P(6));
  });

  it('with ECM the idle access is $39FF', () => {
    const w = vicWorld();
    common(w, 0x5f);
    w.ram[0x3fff] = 0x00;
    w.ram[0x39ff] = 0xff;
    runFrames(w.vic, 2);
    expect(px(w.vic, cellX(0, 0), 36)).toBe(P(0));
    expect(px(w.vic, cellX(0, 1), 36)).toBe(P(0));
  });
});

describe('mode changes mid-frame', () => {
  it('registers are sampled per cycle: ECM+BMM from raster 120 turns the picture black', () => {
    const w = vicWorld();
    common(w, 0x1b);
    runFrames(w.vic, 2);
    while (w.vic.raster !== 120) w.vic.tick();
    w.vic.write(0x11, 0x7b);
    while (w.vic.raster !== 130) w.vic.tick();
    expect(px(w.vic, 100, 119 - 15)).toBe(P(6));
    expect(px(w.vic, 100, 121 - 15)).toBe(P(0));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/machine/vic-modes.test.ts`
Expected: FAIL — the VIC still renders everything as standard text (colour expectations differ).

- [ ] **Step 3: Update `src/machine/vic.ts`**

1. Add the import and fields:
```ts
import { renderGraphics } from './vic-graphics';
```
and, next to the other private fields:
```ts
  private readonly bgColors = new Uint8Array(4);
  private readonly gColor = new Uint8Array(8);
  private readonly gFg = new Uint8Array(8);
  private readonly prevColor = new Uint8Array(8);
  private readonly prevFg = new Uint8Array(8);
  private readonly shiftedColor = new Uint8Array(8);
  private readonly shiftedFg = new Uint8Array(8);
```
Remove the old `prev`, `cur` and `shifted` fields. In `reset()` replace `this.prev.fill(0);` with
`this.prevColor.fill(0); this.prevFg.fill(0);`.

2. Replace the whole `outputCycle` method with:
```ts
  private outputCycle(c: number): void {
    const regs = this.regs;
    const ecm = (regs[0x11]! & 0x40) !== 0;
    const mode = (ecm ? 4 : 0) | (regs[0x11]! & 0x20 ? 2 : 0) | (regs[0x16]! & 0x10 ? 1 : 0);
    const bg = this.bgColors;
    bg[0] = regs[0x21]! & 0x0f;
    bg[1] = regs[0x22]! & 0x0f;
    bg[2] = regs[0x23]! & 0x0f;
    bg[3] = regs[0x24]! & 0x0f;

    if (c >= FIRST_G_CYCLE && c <= LAST_G_CYCLE) {
      let glyph: number;
      let code = 0;
      let nibble = 0;
      if (this.displayState) {
        const vm = ((regs[0x18]! >> 4) & 0x0f) << 10;
        if (this.badline) {
          this.chars[this.vmli] = this.mem.readMem(vm + this.vc);
          this.colors[this.vmli] = this.mem.readColor(this.vc & 0x3ff) & 0x0f;
        }
        code = this.chars[this.vmli]!;
        nibble = this.colors[this.vmli]!;
        let addr: number;
        if (mode & 2) {
          addr = ((regs[0x18]! & 0x08) << 10) | (this.vc << 3) | this.rc;
        } else {
          const cb = ((regs[0x18]! >> 1) & 0x07) << 11;
          addr = cb + (((ecm ? code & 0x3f : code) as number) << 3) + this.rc;
        }
        glyph = this.mem.readMem(addr);
        this.vc = (this.vc + 1) & 0x3ff;
        this.vmli = (this.vmli + 1) % 40;
      } else {
        glyph = this.mem.readMem(ecm ? 0x39ff : 0x3fff);
      }
      renderGraphics(this.gColor, this.gFg, mode, glyph, code, nibble, bg);
    } else {
      this.gColor.fill(bg[0]!);
      this.gFg.fill(0);
    }

    const xs = regs[0x16]! & 7;
    for (let i = 0; i < 8; i++) {
      if (i >= xs) {
        this.shiftedColor[i] = this.gColor[i - xs]!;
        this.shiftedFg[i] = this.gFg[i - xs]!;
      } else {
        this.shiftedColor[i] = this.prevColor[8 + i - xs]!;
        this.shiftedFg[i] = this.prevFg[8 + i - xs]!;
      }
    }
    this.prevColor.set(this.gColor);
    this.prevFg.set(this.gFg);

    if (this.raster < FIRST_VISIBLE_RASTER || this.raster > LAST_VISIBLE_RASTER) return;
    const csel = (regs[0x16]! & 0x08) !== 0;
    const rsel = (regs[0x11]! & 0x08) !== 0;
    const den = (regs[0x11]! & 0x10) !== 0;
    const left = csel ? 32 : 39;
    const right = csel ? 352 : 343;
    const top = rsel ? 51 : 55;
    const bottom = rsel ? 251 : 247;
    const verticalOpen = den && this.raster >= top && this.raster < bottom;
    const border = regs[0x20]! & 0x0f;
    const rowBase = (this.raster - FIRST_VISIBLE_RASTER) * FRAME_WIDTH;
    const fx0 = (c - FIRST_VISIBLE_CYCLE) * 8;
    for (let i = 0; i < 8; i++) {
      const fx = fx0 + i;
      const colour = verticalOpen && fx >= left && fx < right ? this.shiftedColor[i]! : border;
      this.frame[rowBase + fx] = PALETTE[colour]!;
    }
  }
```

- [ ] **Step 4: Run to verify pass, including the unmodified sub-project 2 VIC tests**

Run: `npx vitest run test/machine && npm run typecheck && npm run lint`
Expected: PASS, clean; `test/machine/vic.test.ts` passes untouched.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(machine): VIC-II renders all eight graphics modes with correct g-access addressing" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01QAsVffzaJc51Ncx7uyv5AK"
```

---

### Task 3: Sprite unit (`vic-sprites.ts`)

**Files:**
- Create: `src/machine/vic-sprites.ts`
- Test: `test/machine/vic-sprites.test.ts`

**Interfaces:**
- Produces: `class Sprites { constructor(regs: Uint8Array, mem: { readMem(addr14: number): number }); reset(): void; newLine(): void; cycle(c: number, raster: number): void; sample(x: number): void; active: number; mask: number; readonly colors: Uint8Array; readonly dma, display, mcBase, mc: Uint8Array }`.
  - `regs` is the VIC register file (sprite registers at `$00-$10`, `$15`, `$17`, `$18`, `$1B-$1D`, `$25-$2E`).
  - `cycle(c, raster)` runs the DMA bookkeeping and fetch events for cycle `c` of line `raster`.
  - `sample(x)` advances every active shifter by one pixel at raster X `x` and sets `mask` (bit n = sprite n opaque) and `colors[n]`.
  - `active` is the bitmask of sprites whose `display` flag is on.

- [ ] **Step 1: Write the failing tests**

`test/machine/vic-sprites.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { Sprites } from '../../src/machine/vic-sprites';

function rig() {
  const regs = new Uint8Array(0x40);
  const ram = new Uint8Array(0x4000);
  const sprites = new Sprites(regs, { readMem: (a) => ram[a & 0x3fff]! });
  regs[0x18] = 0x10; // video matrix at $0400 -> sprite pointers at $07F8
  return { regs, ram, sprites };
}

interface LineResult {
  masks: number[]; // opaque-sprite mask per raster X
  colors: number[][]; // colours per raster X
  activeAt30: number;
}

/** Runs one whole line in the same order as VicII.tick. */
function runLine(sprites: Sprites, raster: number): LineResult {
  const masks = new Array<number>(504).fill(0);
  const colors = new Array<number[]>(504).fill([]);
  let activeAt30 = 0;
  sprites.newLine();
  for (let c = 1; c <= 63; c++) {
    sprites.cycle(c, raster);
    if (c === 30) activeAt30 = sprites.active;
    if (sprites.active !== 0) {
      const x0 = ((((c - 12) * 8 + 496) % 504) + 504) % 504;
      for (let i = 0; i < 8; i++) {
        const x = (x0 + i) % 504;
        sprites.sample(x);
        masks[x] = sprites.mask;
        colors[x] = [...sprites.colors];
      }
    }
  }
  return { masks, colors, activeAt30 };
}

function setSprite(
  r: ReturnType<typeof rig>,
  n: number,
  opts: { x: number; y: number; ptr?: number; row0?: number[] },
) {
  r.regs[0x15]! |= 1 << n;
  r.regs[2 * n] = opts.x & 0xff;
  r.regs[1 + 2 * n] = opts.y;
  if (opts.x & 0x100) r.regs[0x10]! |= 1 << n;
  const ptr = opts.ptr ?? 0x40;
  r.ram[0x07f8 + n] = ptr;
  r.regs[0x27 + n] = 1 + n; // colours 1..8
  (opts.row0 ?? [0xff, 0xff, 0xff]).forEach((b, i) => (r.ram[ptr * 64 + i] = b));
}

describe('sprite lifetime', () => {
  it('is displayed on rasters Y+1 .. Y+21 (21 lines)', () => {
    const r = rig();
    setSprite(r, 0, { x: 100, y: 50 });
    const shown: number[] = [];
    for (let raster = 40; raster <= 90; raster++) {
      if (runLine(r.sprites, raster).activeAt30 & 1) shown.push(raster);
    }
    expect(shown[0]).toBe(51);
    expect(shown.at(-1)).toBe(71);
    expect(shown).toHaveLength(21);
  });

  it('Y-expand doubles the lifetime to 42 lines', () => {
    const r = rig();
    setSprite(r, 0, { x: 100, y: 50 });
    r.regs[0x17] = 0x01;
    const shown: number[] = [];
    for (let raster = 40; raster <= 120; raster++) {
      if (runLine(r.sprites, raster).activeAt30 & 1) shown.push(raster);
    }
    expect(shown[0]).toBe(51);
    expect(shown).toHaveLength(42);
  });

  it('a disabled sprite never starts', () => {
    const r = rig();
    setSprite(r, 0, { x: 100, y: 50 });
    r.regs[0x15] = 0;
    for (let raster = 40; raster <= 90; raster++) {
      expect(runLine(r.sprites, raster).activeAt30).toBe(0);
    }
  });
});

describe('fetch addresses and rows', () => {
  it('uses the pointer at VM+$3F8+n and data at pointer*64, three bytes per row', () => {
    const r = rig();
    setSprite(r, 0, { x: 100, y: 20, ptr: 0x41, row0: [0xf0, 0x0f, 0x81] });
    r.ram[0x41 * 64 + 3] = 0x80; // row 1, byte 0
    for (let raster = 15; raster <= 20; raster++) runLine(r.sprites, raster);
    const row0 = runLine(r.sprites, 21).masks;
    for (const x of [100, 101, 102, 103, 112, 113, 114, 115, 116, 123]) {
      expect(row0[x], `x=${x}`).toBe(1);
    }
    for (const x of [99, 104, 107, 108, 111, 117, 122, 124]) expect(row0[x], `x=${x}`).toBe(0);
    const row1 = runLine(r.sprites, 22).masks;
    expect(row1[100]).toBe(1);
    expect(row1[101]).toBe(0);
  });

  it('sprites 3-7 load at the start of their display line', () => {
    const r = rig();
    setSprite(r, 4, { x: 100, y: 20, row0: [0x80, 0, 0] });
    for (let raster = 15; raster <= 20; raster++) runLine(r.sprites, raster);
    expect(runLine(r.sprites, 21).masks[100]).toBe(1 << 4);
  });
});

describe('sprite pixels', () => {
  it('multicolour pairs use $D025, the sprite colour and $D026', () => {
    const r = rig();
    setSprite(r, 0, { x: 100, y: 20, row0: [0b01_10_11_00, 0, 0] });
    r.regs[0x1c] = 0x01;
    r.regs[0x25] = 3;
    r.regs[0x26] = 4;
    for (let raster = 15; raster <= 20; raster++) runLine(r.sprites, raster);
    const line = runLine(r.sprites, 21);
    expect([100, 101].map((x) => line.colors[x]![0])).toEqual([3, 3]);
    expect([102, 103].map((x) => line.colors[x]![0])).toEqual([1, 1]);
    expect([104, 105].map((x) => line.colors[x]![0])).toEqual([4, 4]);
    expect(line.masks[106]).toBe(0);
    expect(line.masks[107]).toBe(0);
  });

  it('X-expand doubles every source pixel and the sprite is 48 pixels wide', () => {
    const r = rig();
    setSprite(r, 0, { x: 100, y: 20, row0: [0x80, 0x00, 0x01] });
    r.regs[0x1d] = 0x01;
    for (let raster = 15; raster <= 20; raster++) runLine(r.sprites, raster);
    const m = runLine(r.sprites, 21).masks;
    expect([100, 101, 146, 147].map((x) => m[x])).toEqual([1, 1, 1, 1]);
    expect([99, 102, 145, 148].map((x) => m[x])).toEqual([0, 0, 0, 0]);
  });

  it('the 9th X bit places a sprite at X >= 256', () => {
    const r = rig();
    setSprite(r, 0, { x: 300, y: 20, row0: [0x80, 0, 0] });
    for (let raster = 15; raster <= 20; raster++) runLine(r.sprites, raster);
    const m = runLine(r.sprites, 21).masks;
    expect(m[300]).toBe(1);
    expect(m[44]).toBe(0);
  });
});

describe('line wrap and invisible X', () => {
  it('a sprite starting at X=490 wraps: its tail shows at X=0..9', () => {
    const r = rig();
    setSprite(r, 0, { x: 490, y: 20 });
    for (let raster = 15; raster <= 20; raster++) runLine(r.sprites, raster);
    const m = runLine(r.sprites, 21).masks;
    expect([490, 503, 0, 9].map((x) => m[x])).toEqual([1, 1, 1, 1]);
    expect(m[10]).toBe(0);
    expect(m[489]).toBe(0);
  });

  it('X = 504..511 never matches a PAL raster X', () => {
    const r = rig();
    setSprite(r, 0, { x: 504, y: 20 });
    for (let raster = 15; raster <= 20; raster++) runLine(r.sprites, raster);
    expect(runLine(r.sprites, 21).masks.every((m) => m === 0)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/machine/vic-sprites.test.ts`
Expected: FAIL — cannot resolve `vic-sprites`.

- [ ] **Step 3: Write `src/machine/vic-sprites.ts`**

```ts
export interface SpriteMemory {
  readMem(addr14: number): number;
}

/** PAL pointer/data fetch cycle of each sprite. */
const FETCH_CYCLE = [58, 60, 62, 1, 3, 5, 7, 9];
const FETCH_AT = new Int8Array(64).fill(-1);
FETCH_CYCLE.forEach((cycle, n) => (FETCH_AT[cycle] = n));

/** Eight sprite units: DMA bookkeeping (Bauer 3.8), fetch and per-pixel shifters. */
export class Sprites {
  readonly dma = new Uint8Array(8);
  readonly display = new Uint8Array(8);
  readonly mcBase = new Uint8Array(8);
  readonly mc = new Uint8Array(8);
  private readonly expandFF = new Uint8Array(8).fill(1);
  private readonly data = new Int32Array(8);
  private readonly shiftData = new Int32Array(8);
  private readonly pos = new Int16Array(8).fill(-1);
  /** Bitmask of sprites whose display flag is on. */
  active = 0;
  /** Output of the last `sample()`: bit n set = sprite n has an opaque pixel here. */
  mask = 0;
  readonly colors = new Uint8Array(8);

  constructor(
    private readonly regs: Uint8Array,
    private readonly mem: SpriteMemory,
  ) {}

  reset(): void {
    this.dma.fill(0);
    this.display.fill(0);
    this.mcBase.fill(0);
    this.mc.fill(0);
    this.expandFF.fill(1);
    this.data.fill(0);
    this.shiftData.fill(0);
    this.pos.fill(-1);
    this.active = 0;
    this.mask = 0;
  }

  /** Shifters do not run across lines. */
  newLine(): void {
    this.pos.fill(-1);
  }

  /** DMA bookkeeping and fetch events for cycle `c` of line `raster`. */
  cycle(c: number, raster: number): void {
    const regs = this.regs;
    switch (c) {
      case 15:
        for (let n = 0; n < 8; n++) if (this.dma[n] && this.expandFF[n]) this.mcBase[n]! += 2;
        break;
      case 16:
        for (let n = 0; n < 8; n++) {
          if (this.dma[n] && this.expandFF[n]) this.mcBase[n]! += 1;
          if (this.mcBase[n] === 63) this.dma[n] = 0;
        }
        break;
      case 55:
        for (let n = 0; n < 8; n++) {
          if ((regs[0x17]! >> n) & 1) this.expandFF[n]! ^= 1;
          else this.expandFF[n] = 1;
        }
        this.dmaCheck(raster);
        break;
      case 56:
        this.dmaCheck(raster);
        break;
      case 58:
        for (let n = 0; n < 8; n++) {
          this.mc[n] = this.mcBase[n]!;
          if (!this.dma[n]) this.display[n] = 0;
          else if (regs[1 + 2 * n] === (raster & 0xff)) this.display[n] = 1;
        }
        this.updateActive();
        break;
    }
    const n = FETCH_AT[c]!;
    if (n >= 0) this.fetch(n);
  }

  /** Advances every active shifter by one pixel at raster X `x`. */
  sample(x: number): void {
    const regs = this.regs;
    let mask = 0;
    for (let n = 0; n < 8; n++) {
      if (((this.active >> n) & 1) === 0) continue;
      let p = this.pos[n]!;
      if (p < 0) {
        const sx = regs[2 * n]! | (((regs[0x10]! >> n) & 1) << 8);
        if (x !== sx) continue;
        p = 0;
        this.shiftData[n] = this.data[n]!;
      }
      const xexp = (regs[0x1d]! >> n) & 1;
      const src = xexp ? p >> 1 : p;
      const word = this.shiftData[n]!;
      let colour = -1;
      if ((regs[0x1c]! >> n) & 1) {
        const pair = (word >> (22 - (src & ~1))) & 3;
        if (pair === 1) colour = regs[0x25]! & 0x0f;
        else if (pair === 2) colour = regs[0x27 + n]! & 0x0f;
        else if (pair === 3) colour = regs[0x26]! & 0x0f;
      } else if ((word >> (23 - src)) & 1) {
        colour = regs[0x27 + n]! & 0x0f;
      }
      if (colour >= 0) {
        mask |= 1 << n;
        this.colors[n] = colour;
      }
      p++;
      this.pos[n] = p >= 24 << xexp ? -1 : p;
    }
    this.mask = mask;
  }

  private dmaCheck(raster: number): void {
    const regs = this.regs;
    for (let n = 0; n < 8; n++) {
      if (
        ((regs[0x15]! >> n) & 1) !== 0 &&
        this.dma[n] === 0 &&
        regs[1 + 2 * n] === (raster & 0xff)
      ) {
        this.dma[n] = 1;
        this.mcBase[n] = 0;
        if ((regs[0x17]! >> n) & 1) this.expandFF[n] = 0;
      }
    }
  }

  private fetch(n: number): void {
    const vm = ((this.regs[0x18]! >> 4) & 0x0f) << 10;
    const pointer = this.mem.readMem(vm + 0x3f8 + n);
    if (!this.dma[n]) return;
    const base = pointer * 64 + this.mc[n]!;
    this.data[n] =
      (this.mem.readMem(base) << 16) | (this.mem.readMem(base + 1) << 8) | this.mem.readMem(base + 2);
    this.mc[n]! += 3;
  }

  private updateActive(): void {
    let a = 0;
    for (let n = 0; n < 8; n++) if (this.display[n]) a |= 1 << n;
    this.active = a;
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/machine/vic-sprites.test.ts && npm run typecheck && npm run lint`
Expected: PASS, clean. If the lifetime test fails by one line, re-check the order at cycle 58 (display turns **off** when DMA is off, **on** when DMA is on and Y matches) and that DMA turns off at cycle 16 only.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(machine): sprite unit with DMA bookkeeping, fetch and shifters" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01QAsVffzaJc51Ncx7uyv5AK"
```

---

### Task 4: Composite sprites into the VIC (priority, collisions, IRQ, border)

**Files:**
- Modify: `src/machine/vic.ts`
- Test: `test/machine/vic-compose.test.ts`

**Interfaces:**
- Consumes: `Sprites`, `renderGraphics`, the `shiftedColor/shiftedFg` arrays from Task 2.
- Produces: `$D01E`/`$D01F` collision registers (read clears, `peek` does not, writes ignored), `$D019` bits 1 and 2, sprite pixels in the framebuffer. `VicII.debug` gains `sprites: { dma, display, mcBase }` (arrays copied).

- [ ] **Step 1: Write the failing tests**

`test/machine/vic-compose.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { PALETTE } from '../../src/machine/palette';
import { px, runFrames, vicWorld } from './vic-helpers';

const P = (i: number) => PALETTE[i]!;

type World = ReturnType<typeof vicWorld>;

function setup(w: World) {
  w.vic.write(0x11, 0x1b);
  w.vic.write(0x16, 0x08);
  w.vic.write(0x18, 0x12); // matrix $0400, char base $0800
  w.vic.write(0x20, 0x0e); // border light blue
  w.vic.write(0x21, 0x06); // background blue
}

function sprite(
  w: World,
  n: number,
  o: { x: number; y: number; colour: number; ptr?: number; rows?: number[] },
) {
  const ptr = o.ptr ?? 0x40 + n;
  w.ram[0x07f8 + n] = ptr;
  const rows = o.rows ?? new Array(63).fill(0xff);
  rows.forEach((b, i) => (w.ram[ptr * 64 + i] = b));
  w.vic.write(2 * n, o.x & 0xff);
  w.vic.write(1 + 2 * n, o.y);
  w.vic.write(0x10, (w.vic.peek(0x10) & ~(1 << n)) | (o.x & 0x100 ? 1 << n : 0));
  w.vic.write(0x27 + n, o.colour);
  w.vic.write(0x15, w.vic.peek(0x15) | (1 << n));
}

// Sprite X=24, Y=50 lines up with the first text cell: framebuffer (32, 36).
const FX = 32;
const FY = 36;

describe('sprite rendering', () => {
  it('draws a solid sprite over the background at the right place and size', () => {
    const w = vicWorld();
    setup(w);
    sprite(w, 0, { x: 24, y: 50, colour: 1 });
    runFrames(w.vic, 2);
    expect(px(w.vic, FX, FY)).toBe(P(1));
    expect(px(w.vic, FX + 23, FY + 20)).toBe(P(1));
    expect(px(w.vic, FX + 24, FY)).toBe(P(6));
    expect(px(w.vic, FX, FY + 21)).toBe(P(6));
    expect(px(w.vic, FX, FY - 1)).toBe(P(14)); // border row above the window
  });

  it('the border hides sprites', () => {
    const w = vicWorld();
    setup(w);
    sprite(w, 0, { x: 10, y: 50, colour: 1 }); // left of the display window
    runFrames(w.vic, 2);
    expect(px(w.vic, 18, FY)).toBe(P(14));
  });
});

describe('priority', () => {
  it('a lower-numbered sprite is drawn over a higher-numbered one', () => {
    const w = vicWorld();
    setup(w);
    sprite(w, 1, { x: 24, y: 50, colour: 2 });
    sprite(w, 0, { x: 24, y: 50, colour: 1 });
    runFrames(w.vic, 2);
    expect(px(w.vic, FX + 5, FY + 5)).toBe(P(1));
  });

  it('a behind-foreground sprite is hidden by set glyph pixels but not by background', () => {
    const w = vicWorld();
    setup(w);
    w.ram[0x0400] = 1;
    w.color[0] = 5;
    w.ram[0x0808] = 0xf0; // left 4 pixels foreground on row 0
    sprite(w, 0, { x: 24, y: 50, colour: 2 });
    w.vic.write(0x1b, 0x01); // behind foreground
    runFrames(w.vic, 2);
    expect(px(w.vic, FX, FY)).toBe(P(5)); // glyph wins
    expect(px(w.vic, FX + 4, FY)).toBe(P(2)); // sprite over background
  });
});

describe('collisions and IRQ', () => {
  it('sprite-sprite: both bits set, flag raised once, read clears, peek does not', () => {
    const w = vicWorld();
    setup(w);
    w.vic.write(0x1a, 0x04);
    sprite(w, 0, { x: 24, y: 50, colour: 1 });
    sprite(w, 1, { x: 30, y: 54, colour: 2 });
    runFrames(w.vic, 2);
    expect(w.vic.peek(0x1e)).toBe(0b11);
    expect(w.vic.peek(0x1e)).toBe(0b11); // peek does not clear
    expect(w.vic.read(0x19) & 0x04).toBe(0x04);
    expect(w.vic.irq).toBe(true);
    expect(w.vic.read(0x1e)).toBe(0b11);
    expect(w.vic.read(0x1e)).toBe(0);
  });

  it('the flag is raised on the zero-to-non-zero transition only', () => {
    const w = vicWorld();
    setup(w);
    sprite(w, 0, { x: 24, y: 50, colour: 1 });
    sprite(w, 1, { x: 30, y: 54, colour: 2 });
    runFrames(w.vic, 2);
    w.vic.write(0x19, 0x04); // acknowledge the flag but leave $D01E non-zero
    runFrames(w.vic, 2); // collisions again while the register is non-zero
    expect(w.vic.peek(0x19) & 0x04).toBe(0);
    w.vic.read(0x1e); // now the register is cleared
    runFrames(w.vic, 2);
    expect(w.vic.peek(0x19) & 0x04).toBe(0x04);
  });

  it('three overlapping sprites set three bits', () => {
    const w = vicWorld();
    setup(w);
    for (const n of [0, 1, 2]) sprite(w, n, { x: 24 + n, y: 50, colour: 1 + n });
    runFrames(w.vic, 2);
    expect(w.vic.read(0x1e)).toBe(0b111);
  });

  it('sprite-background: set only over foreground pixels, even for a behind-foreground sprite', () => {
    const w = vicWorld();
    setup(w);
    w.ram[0x0400] = 1;
    w.color[0] = 5;
    w.ram[0x0808] = 0xf0;
    sprite(w, 0, { x: 24, y: 50, colour: 2, rows: [0xff, 0xff, 0xff, ...new Array(60).fill(0)] });
    w.vic.write(0x1b, 0x01);
    w.vic.write(0x1a, 0x02);
    runFrames(w.vic, 2);
    expect(w.vic.read(0x1f)).toBe(0x01);
    expect(w.vic.irq || (w.vic.peek(0x19) & 0x02) !== 0).toBe(true);
  });

  it('no sprite-background collision over pure background', () => {
    const w = vicWorld();
    setup(w);
    sprite(w, 0, { x: 24, y: 50, colour: 2 });
    runFrames(w.vic, 2);
    expect(w.vic.peek(0x1f)).toBe(0);
  });

  it('collisions are detected under the border while the pixels stay hidden', () => {
    const w = vicWorld();
    setup(w);
    sprite(w, 0, { x: 10, y: 50, colour: 1 });
    sprite(w, 1, { x: 12, y: 50, colour: 2 });
    runFrames(w.vic, 2);
    expect(w.vic.peek(0x1e)).toBe(0b11);
    expect(px(w.vic, 18, FY)).toBe(P(14));
  });

  it('writes to the collision registers are ignored', () => {
    const w = vicWorld();
    setup(w);
    sprite(w, 0, { x: 24, y: 50, colour: 1 });
    sprite(w, 1, { x: 24, y: 50, colour: 2 });
    runFrames(w.vic, 2);
    w.vic.write(0x1e, 0x00);
    expect(w.vic.peek(0x1e)).toBe(0b11);
  });
});

describe('sprite state in debug', () => {
  it('DMA and display are on during the sprite and off after its 21 rows', () => {
    const w = vicWorld();
    setup(w);
    sprite(w, 0, { x: 24, y: 50, colour: 1 });
    runFrames(w.vic, 1); // ends at raster 0 of the next frame
    while (w.vic.raster !== 60) w.vic.tick();
    expect(w.vic.debug.sprites.dma[0]).toBe(1);
    expect(w.vic.debug.sprites.display[0]).toBe(1);
    expect(w.vic.debug.sprites.mcBase[0]).toBe(27); // 9 increments of 3 (rasters 51-59)
    while (w.vic.raster !== 80) w.vic.tick();
    expect(w.vic.debug.sprites.dma[0]).toBe(0);
    expect(w.vic.debug.sprites.display[0]).toBe(0);
    // A sprite restarts when raster & $FF matches Y again (Y + 256 = 306 is inside 312 lines).
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/machine/vic-compose.test.ts`
Expected: FAIL — sprites are not rendered (pixel expectations differ) and `$D01E`/`$D01F` read 0.

- [ ] **Step 3: Update `src/machine/vic.ts`**

1. Imports and fields:
```ts
import { Sprites } from './vic-sprites';
```
```ts
  private readonly sprites: Sprites;
  private spriteSpriteHits = 0;
  private spriteBgHits = 0;
```
In the constructor, before `this.reset()`: `this.sprites = new Sprites(this.regs, mem);`.

2. `reset()`: add `this.spriteSpriteHits = 0; this.spriteBgHits = 0; this.sprites.reset();`.

3. `startLine()`: add `this.sprites.newLine();` as its first statement.

4. Registers: in `peek()` replace the `case 0x1e: case 0x1f: return 0;` block with:
```ts
      case 0x1e:
        return this.spriteSpriteHits;
      case 0x1f:
        return this.spriteBgHits;
```
and make `read()` clear on read:
```ts
  read(reg: number): number {
    reg &= 0x3f;
    if (reg === 0x1e) {
      const v = this.spriteSpriteHits;
      this.spriteSpriteHits = 0;
      return v;
    }
    if (reg === 0x1f) {
      const v = this.spriteBgHits;
      this.spriteBgHits = 0;
      return v;
    }
    return this.peek(reg);
  }
```
In `write()` add `case 0x1e: case 0x1f: return;` before the `default`.

5. `debug` getter: extend the returned object with
```ts
      sprites: {
        dma: Array.from(this.sprites.dma),
        display: Array.from(this.sprites.display),
        mcBase: Array.from(this.sprites.mcBase),
      },
```

6. `tick()`: replace its body with
```ts
    const c = this.cycle;
    if (c === 14) this.beginDisplayLine();
    this.sprites.cycle(c, this.raster);
    const visible = c >= FIRST_VISIBLE_CYCLE && c <= LAST_VISIBLE_CYCLE;
    if (visible || this.sprites.active !== 0) this.outputCycle(c, visible);
    if (c === 58) this.endDisplayLine();
    if (c === CYCLES_PER_LINE) {
      this.cycle = 1;
      this.nextLine();
    } else {
      this.cycle = c + 1;
    }
```

7. Replace the **tail** of `outputCycle` (everything from the line `if (this.raster < FIRST_VISIBLE_RASTER ...` to the end of the method) and change its signature to `outputCycle(c: number, visible: boolean)`. The graphics and XSCROLL part from Task 2 stays. The new tail:
```ts
    const csel = (regs[0x16]! & 0x08) !== 0;
    const rsel = (regs[0x11]! & 0x08) !== 0;
    const den = (regs[0x11]! & 0x10) !== 0;
    const left = csel ? 32 : 39;
    const right = csel ? 352 : 343;
    const top = rsel ? 51 : 55;
    const bottom = rsel ? 251 : 247;
    const verticalOpen = den && this.raster >= top && this.raster < bottom;
    const border = regs[0x20]! & 0x0f;
    const writeFrame =
      visible && this.raster >= FIRST_VISIBLE_RASTER && this.raster <= LAST_VISIBLE_RASTER;
    const rowBase = (this.raster - FIRST_VISIBLE_RASTER) * FRAME_WIDTH;
    const fx0 = (c - FIRST_VISIBLE_CYCLE) * 8;
    const x0 = (((((c - FIRST_VISIBLE_CYCLE) * 8 + 496) % 504) + 504) % 504) | 0;
    const spritesOn = this.sprites.active !== 0;

    for (let i = 0; i < 8; i++) {
      const fx = fx0 + i;
      const inWindow = visible && verticalOpen && fx >= left && fx < right;
      let colour = this.shiftedColor[i]!;
      const fg = inWindow ? this.shiftedFg[i]! : 0;
      if (spritesOn) {
        this.sprites.sample((x0 + i) % 504);
        const mask = this.sprites.mask;
        if (mask !== 0) {
          if ((mask & (mask - 1)) !== 0) this.hitSprites(mask);
          if (fg) this.hitBackground(mask);
          const n = 31 - Math.clz32(mask & -mask); // lowest-numbered sprite wins
          if (!((regs[0x1b]! >> n) & 1 && fg)) colour = this.sprites.colors[n]!;
        }
      }
      if (writeFrame) this.frame[rowBase + fx] = PALETTE[inWindow ? colour : border]!;
    }
  }

  private hitSprites(bits: number): void {
    const before = this.spriteSpriteHits;
    this.spriteSpriteHits |= bits;
    if (before === 0) this.status |= 0x04;
  }

  private hitBackground(bits: number): void {
    const before = this.spriteBgHits;
    this.spriteBgHits |= bits;
    if (before === 0) this.status |= 0x02;
  }
```
(Make sure `outputCycle`'s early `return` for out-of-range rasters from Task 2 is **removed**: collisions must be evaluated on every line.)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/machine && npm run typecheck && npm run lint`
Expected: PASS, clean; `vic.test.ts`, `vic-modes.test.ts` and the sprite unit tests still pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(machine): composite sprites with priority, collision registers and IRQ flags" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01QAsVffzaJc51Ncx7uyv5AK"
```

---

### Task 5: Machine-level test through the real bus

**Files:**
- Test: `test/machine/graphics-machine.test.ts`

**Interfaces:**
- Consumes: `C64`, a synthetic KERNAL built in the test. No source changes expected; if the test exposes a defect in bus/VIC wiring, fix it in `src/machine/` with the test as the reproduction.

- [ ] **Step 1: Write the test**

`test/machine/graphics-machine.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { C64 } from '../../src/machine/c64';
import { PALETTE } from '../../src/machine/palette';
import { FRAME_WIDTH } from '../../src/machine/vic';
import { filled } from './helpers';

/** KERNAL that performs `writes` (LDA #v / STA addr) and then spins. */
function kernalWriting(writes: Array<[number, number]>) {
  const kernal = filled(8192, 0xea);
  const code: number[] = [0x78]; // SEI
  for (const [addr, value] of writes) code.push(0xa9, value, 0x8d, addr & 0xff, addr >> 8);
  const jmpAt = code.length;
  code.push(0x4c, (0xe000 + jmpAt) & 0xff, (0xe000 + jmpAt) >> 8);
  kernal.set(code, 0);
  kernal[0x1ffc] = 0x00;
  kernal[0x1ffd] = 0xe0;
  return { kernal, basic: filled(8192, 0), chargen: filled(4096, 0) };
}

const pixel = (c64: C64, x: number, y: number) => c64.frame.pixels[y * FRAME_WIDTH + x]!;

describe('graphics through the real bus', () => {
  it('standard bitmap plus a sprite, programmed by CPU writes', () => {
    const c64 = new C64(
      kernalWriting([
        [0xd011, 0x3b], // bitmap, DEN, RSEL, YSCROLL 3
        [0xd016, 0x08],
        [0xd018, 0x18], // matrix $0400, bitmap $2000
        [0xd020, 0x0e],
        [0xd021, 0x06],
        [0x04d2, 0x1c], // cell (10, 5): hi nibble 1, lo nibble 12
        [0x2690, 0xf0], // cell 210 row 0: left four pixels set
        [0x07f8, 0x81], // sprite 0 pointer -> $2040
        [0x2040, 0xff], // sprite row 0, byte 0
        [0xd000, 24],
        [0xd001, 50],
        [0xd027, 2],
        [0xd015, 0x01],
      ]),
    );
    c64.runFrame();
    c64.runFrame();
    const P = (i: number) => PALETTE[i]!;
    expect(pixel(c64, 0, 0)).toBe(P(14)); // border
    expect(pixel(c64, 112, 76)).toBe(P(1)); // bitmap cell (10, 5), set pixel
    expect(pixel(c64, 116, 76)).toBe(P(12)); // clear pixel
    for (let x = 32; x < 40; x++) expect(pixel(c64, x, 36)).toBe(P(2)); // sprite row 0, byte 0
    expect(pixel(c64, 32, 35)).toBe(P(14)); // border row above the window
  });
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run test/machine/graphics-machine.test.ts`
Expected: PASS (it exercises the code from Tasks 1-4 through `C64`). If it fails, treat it as a defect: reproduce, fix in `src/machine/`, keep the test as is.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "test(machine): bitmap and sprite programmed through the real C64 bus" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01QAsVffzaJc51Ncx7uyv5AK"
```

---

### Task 6: `graphics-test.prg` builder and OpenROMs conformance test

**Files:**
- Create: `scripts/build-graphics-prg.mjs`, `scripts/build-graphics-prg.d.mts`, `examples/graphics-test.prg` (generated)
- Test: `test/conformance/graphics.test.ts`

**Interfaces:**
- Produces: `buildGraphicsPrg(): Uint8Array` (a PRG loading at `$C000`, started with `SYS 49152`).

- [ ] **Step 1: Write the failing conformance test**

`test/conformance/graphics.test.ts`:
```ts
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildGraphicsPrg } from '../../scripts/build-graphics-prg.mjs';
import { C64 } from '../../src/machine/c64';
import { PALETTE } from '../../src/machine/palette';
import { FRAME_WIDTH } from '../../src/machine/vic';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '..', '..', '.testdata', 'openroms', 'bin');

function roms() {
  const read = (name: string) => {
    const file = join(DIR, name);
    if (!existsSync(file)) throw new Error(`${file} missing: run "npm run fetch-test-data"`);
    return new Uint8Array(readFileSync(file));
  };
  return {
    kernal: read('kernal_generic.rom'),
    basic: read('basic_generic.rom'),
    chargen: read('chargen_openroms.rom'),
  };
}

const P = (i: number) => PALETTE[i]!;

describe('graphics-test.prg on OpenROMs', () => {
  it('shows a multicolour bitmap, two overlapping sprites and the collision indicator', () => {
    const c64 = new C64(roms());
    expect(c64.runUntilReady(600)).toBe(true);
    c64.loadPrg(buildGraphicsPrg());
    for (let i = 0; i < 200; i++) c64.runFrame();
    const at = (x: number, y: number) => c64.frame.pixels[y * FRAME_WIDTH + x]!;

    // collision indicator: the program switched the border to light blue
    expect(at(0, 0)).toBe(P(14));
    // multicolour bitmap row (no sprite there): 00 -> $D021 (6), 01 -> hi nibble (1),
    // 10 -> lo nibble (12), 11 -> colour RAM (5)
    const row = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => at(32 + i, 100));
    expect(row).toEqual([P(6), P(6), P(1), P(1), P(12), P(12), P(5), P(5)]);
    // sprite 0 (colour 1) at X=40,Y=60 -> framebuffer (48, 46)
    expect(at(48, 46)).toBe(P(1));
    // overlap of sprites 0 and 1 shows the lower-numbered sprite 0
    expect(at(56, 50)).toBe(P(1));
    // sprite 1 only (colour 2): X=48,Y=64 -> x 56..79, rows from 50; right of sprite 0 (x<72)
    expect(at(75, 52)).toBe(P(2));
  });
});
```

`scripts/build-graphics-prg.d.mts`:
```ts
export function buildGraphicsPrg(): Uint8Array;
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:conformance -- graphics`
Expected: FAIL — cannot resolve `scripts/build-graphics-prg.mjs`.

- [ ] **Step 3: Write `scripts/build-graphics-prg.mjs`**

```js
// Builds examples/graphics-test.prg: a tiny machine-code program (load $C000, start with
// SYS 49152) that exercises the VIC-II: multicolour bitmap, two overlapping sprites, and a
// border-colour change when the sprite-sprite collision register becomes non-zero.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LOAD = 0xc000;

export function buildGraphicsPrg() {
  const code = [];
  const labels = new Map();
  const fixups = [];
  let nextLabel = 0;
  const lo = (v) => v & 0xff;
  const hi = (v) => (v >> 8) & 0xff;
  const b = (...bytes) => code.push(...bytes);
  const lda = (v) => b(0xa9, v);
  const ldx = (v) => b(0xa2, v);
  const ldy = (v) => b(0xa0, v);
  const sta = (a) => b(0x8d, lo(a), hi(a));
  const staZp = (z) => b(0x85, z);
  const staIndY = (z) => b(0x91, z);
  const incZp = (z) => b(0xe6, z);
  const iny = () => b(0xc8);
  const dex = () => b(0xca);
  const label = (name) => labels.set(name, code.length);
  const bne = (name) => {
    b(0xd0, 0);
    fixups.push({ at: code.length - 1, name, kind: 'rel' });
  };
  const beq = (name) => {
    b(0xf0, 0);
    fixups.push({ at: code.length - 1, name, kind: 'rel' });
  };
  const jmp = (name) => {
    b(0x4c, 0, 0);
    fixups.push({ at: code.length - 2, name, kind: 'abs' });
  };

  /** Fills `pages` 256-byte pages starting at `start` with `value`, through zero page $FB/$FC. */
  const fillPages = (start, pages, value) => {
    const loop = `fill${nextLabel++}`;
    lda(lo(start));
    staZp(0xfb);
    lda(hi(start));
    staZp(0xfc);
    ldy(0);
    ldx(pages);
    label(loop);
    lda(value);
    staIndY(0xfb);
    iny();
    bne(loop);
    incZp(0xfc);
    dex();
    bne(loop);
  };

  /** Fills `count` (<= 255) bytes at `start` with `value`. */
  const fillBytes = (start, count, value) => {
    const loop = `bytes${nextLabel++}`;
    ldy(0);
    label(loop);
    lda(value);
    b(0x99, lo(start), hi(start)); // STA start,Y
    iny();
    b(0xc0, count); // CPY #count
    bne(loop);
  };

  b(0x78); // SEI: freeze the KERNAL IRQ so the screen stays static

  fillPages(0x2000, 32, 0x1b); // bitmap: pairs 00 01 10 11 on every row
  fillPages(0x0400, 4, 0x1c); // video matrix: hi nibble 1 (white), lo nibble 12 (grey)
  fillPages(0xd800, 4, 0x05); // colour RAM: green
  fillBytes(0x0c00, 63, 0xff); // sprite data: solid 24x21

  for (let n = 0; n < 8; n++) {
    lda(0x30); // sprite data at $0C00 (pointer 0x30 * 64)
    sta(0x07f8 + n);
  }

  lda(40); sta(0xd000); // sprite 0 X
  lda(60); sta(0xd001); // sprite 0 Y
  lda(48); sta(0xd002); // sprite 1 X
  lda(64); sta(0xd003); // sprite 1 Y
  lda(1); sta(0xd027); // sprite 0 colour: white
  lda(2); sta(0xd028); // sprite 1 colour: red
  lda(0x03); sta(0xd015); // enable sprites 0 and 1

  lda(0x00); sta(0xd020); // border black
  lda(0x06); sta(0xd021); // background blue
  lda(0x3b); sta(0xd011); // bitmap mode, DEN, RSEL, YSCROLL 3
  lda(0x18); sta(0xd016); // multicolour, 40 columns
  lda(0x18); sta(0xd018); // matrix $0400, bitmap $2000

  label('wait');
  b(0xad, 0x1e, 0xd0); // LDA $D01E (reading clears it)
  beq('wait');
  lda(0x0e);
  sta(0xd020); // collision seen: border light blue
  label('spin');
  jmp('spin');

  for (const f of fixups) {
    const target = labels.get(f.name);
    if (target === undefined) throw new Error(`undefined label ${f.name}`);
    if (f.kind === 'rel') {
      const rel = target - (f.at + 1);
      if (rel < -128 || rel > 127) throw new Error(`branch to ${f.name} out of range`);
      code[f.at] = rel & 0xff;
    } else {
      code[f.at] = lo(LOAD + target);
      code[f.at + 1] = hi(LOAD + target);
    }
  }
  return Uint8Array.from([lo(LOAD), hi(LOAD), ...code]);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'graphics-test.prg');
  const prg = buildGraphicsPrg();
  writeFileSync(out, prg);
  console.log(`wrote ${out} (${prg.length} bytes)`);
}
```

- [ ] **Step 4: Run to verify pass, generate the example file**

Run:
```bash
node scripts/build-graphics-prg.mjs
npm run test:conformance -- graphics
```
Expected: `wrote .../examples/graphics-test.prg`, then PASS. If a pixel assertion fails, check first that the OpenROMs boot reached `READY.` and that `SYS 49152` ran (`c64.peek(0xd015)` should be 3); debug in the machine layer and add a unit test for any real defect found.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test(conformance): graphics test program on OpenROMs with exact-pixel assertions" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01QAsVffzaJc51Ncx7uyv5AK"
```

---

### Task 7: Browser acceptance, throughput, README and final verification

**Files:**
- Modify: `README.md`
- Create: `docs/screenshots/sp3-graphics.png`

**Interfaces:**
- Consumes: built `dist/f6502.min.js`, `examples/graphics-test.prg`, `.testdata/openroms/bin/*.rom`.

- [ ] **Step 1: Throughput with 8 sprites active**

Run:
```bash
npm run build
node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { C64 } from './dist/index.js';
import { buildGraphicsPrg } from './scripts/build-graphics-prg.mjs';
const d='.testdata/openroms/bin/';
const c=new C64({kernal:readFileSync(d+'kernal_generic.rom'),basic:readFileSync(d+'basic_generic.rom'),chargen:readFileSync(d+'chargen_openroms.rom')});
c.runUntilReady(600); c.loadPrg(buildGraphicsPrg()); for(let i=0;i<60;i++) c.runFrame();
const w = (a, v) => (c.busWrite ?? c.writeIo).call(c, a, v);
for (let n=2;n<8;n++){ w(0xd000+2*n, 40+8*n); w(0xd001+2*n, 60+4*n); w(0xd027+n,1+n); }
w(0xd015,0xff);
const t=performance.now(); for(let i=0;i<500;i++) c.runFrame(); const s=(performance.now()-t)/1000;
console.log('8 sprites, 500 frames in',s.toFixed(2),'s =',(500/50.1245/s).toFixed(0),'x real time');"
```
Expected: at least 10x real time (reported, not a gate). If lower, profile `outputCycle` and make sure the sprite path is skipped when `sprites.active === 0`.

- [ ] **Step 2: Real-browser acceptance**

1. Start the server: `PORT=8767 node scripts/serve.mjs &` (anchor any later `pkill`/`pgrep` pattern with `^node scripts/serve.mjs`).
2. With the Playwright browser tools open `http://127.0.0.1:8767/examples/basic.html?prg=graphics-test.prg`, wait about 5 s, screenshot the `#screen` canvas to `.playwright-mcp/sp3-graphics.png`.
3. Expect: the multicolour bitmap stripes, two overlapping sprites (white over red), and a light-blue border.
4. Copy the screenshot to `docs/screenshots/sp3-graphics.png`. Stop the server.

- [ ] **Step 3: Update `README.md`**

Replace the status paragraph with:
```markdown
Status: the cycle-accurate 6502 core, the C64 machine (memory map, CIAs, keyboard, a complete
VIC-II with all graphics modes, sprites and collisions) and the browser layer are implemented.
Sound, disk/tape media, cycle-exact raster effects and the demo site are planned (see
`docs/superpowers/specs/`).
```

- [ ] **Step 4: Final verification (report real output)**

Run, in order, with a shell that word-splits:
```bash
npx prettier --write README.md docs examples scripts >/dev/null
bash -c 'for c in "npm run -s lint" "npm run -s typecheck" "npm test" "npm run -s test:conformance" "npm run -s build"; do echo "=== $c"; out=$($c 2>&1); code=$?; echo "$out" | grep -E "Tests |Test Files|rror|Prettier|success|FAIL" | head -6; echo "exit: $code"; done'
```
Expected: every command exits 0.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: VIC-II complete - verified graphics modes, sprites and collisions in the browser" -m "Gates: lint, typecheck, unit, conformance, build; 8-sprite throughput measured; real-browser screenshot committed." -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01QAsVffzaJc51Ncx7uyv5AK"
```

---

## Spec coverage check

| Spec requirement | Task |
|---|---|
| Eight graphics modes, invalid modes black with foreground flags | 1, 2 |
| G-access addressing (text, bitmap, idle `$3FFF`/`$39FF`) | 2 |
| XSCROLL correct in all modes, mid-frame mode changes | 2 |
| Sprite registers, DMA bookkeeping, fetch timing, pixel generation | 3 |
| 21/42-line lifetime, first line `Y+1`, wrap, X 504-511 invisible | 3 |
| Priority, collisions, IRQ transitions, read-clears, border behaviour | 4 |
| Per-line fast path when no sprite is active | 4 |
| Machine-level test through the real bus | 5 |
| Generated graphics program + OpenROMs exact-pixel conformance | 6 |
| Real-browser screenshot, throughput guard, README | 7 |
| vic.ts split; sub-project 2 VIC tests unmodified | 1, 2, 3, 4 |

Additions beyond the spec's lists (internal only): `VicII.debug.sprites`, `test/machine/vic-helpers.ts`.
