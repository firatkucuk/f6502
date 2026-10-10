# f6502 Cycle-Exact VIC-II Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the VIC-II cycle-exact for PAL (6569R3): the CPU is held on read cycles while BA is low, every VIC access happens in its documented cycle, the border comes from the real flip-flop rules (so border opening works), the sprite quirks demos rely on are reproduced, and the result is verified against independent VICE reference screenshots.

**Architecture:** `core/` gains an optional `CpuHooks.rdy()` that idles the CPU on read cycles. `VicII.tick()` is restructured to process, before each CPU access, the VIC activity of that cycle (badline condition, sprite bookkeeping, c/g-accesses, pixels, border flip-flops) and to publish `baLow`. A pinned subset of the VICE testprogs is compared pixel-for-pixel to its reference PNGs.

**Tech Stack:** TypeScript (strict), Vitest, ESLint, Prettier, Node LTS. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-10-cycle-exact-vic-design.md`

## Global Constraints

- PAL only: 63 cycles/line, 312 lines, framebuffer `384 x 272` RGBA (Pepto palette), visible cycles 12-59, visible raster lines 15-286, raster X of a framebuffer pixel is `fx - 8` (mod 504).
- `src/core/` stays DOM-free and may import nothing from `machine/` or `browser/`; `machine/` may not import `browser/`.
- The existing CPU suites (`test/core`, Klaus functional test, SingleStepTests) pass **unmodified**.
- `CpuHooks.rdy` is optional: with no hook the core behaves exactly as before.
- Third-party material (VICE testprogs) is fetched pinned and checksummed into the git-ignored `.testdata/`; nothing is vendored.
- No runtime dependencies. No public API change beyond `CpuHooks.rdy`.
- Every PR must reference its issue (`Closes #N`). Every commit message ends with these trailers:
  `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01QAsVffzaJc51Ncx7uyv5AK`.
- Report verification with real command output; never claim a suite passes without running it.

## Cycle model (read before Task 2)

`VicII.tick()` is called once per CPU cycle **after** that cycle's bus access (`onCycle`). From
this plan on it processes the VIC activity of the *next* cycle: the machine runs one priming
`tick()` after reset, so every `tick()` happens between CPU access `n-1` and CPU access `n` and
`baLow` is the BA level the CPU must respect for access `n`. Consequences:

- A CPU write in cycle `n` is first seen by the VIC when it processes cycle `n+1`: the required
  one-cycle write latency, with no shadow register file.
- A CPU read in cycle `n` sees the VIC state after cycle `n` was processed.
- `VicII` starts with `raster = 0` and `cycle = 2` (power-on mid-line 0), so line `R` begins at
  tick `63 * R`, as in sub-project 3, and the existing tick-count based tests keep their meaning.
- The raster counter increments when cycle 1 is processed, except at the frame wrap: line 311
  stays at 311 during cycle 1 and becomes 0 when cycle 2 is processed (`frameCount++` there).

## Review Focus

Failure modes the spec implies but that are easy to get wrong. Each has a test in the owning task:

1. **Writes are never stalled**: stolen-cycle counts for a read-only loop (43 per badline) differ from a write run (Tasks 1, 2).
2. **Mid-line badline conditions**: a condition appearing at cycle 30 starts BA at 30 and c-accesses at 33; DEN is only honoured if seen during line `$30` (Task 2).
3. **BA windows wrap and merge**: sprite 3-7 windows cross the line boundary; adjacent windows merge (Task 2).
4. **Border opening needs per-pixel CSEL/RSEL timing**; static windows, 38/24 modes and DEN=0 are unchanged (Task 3).
5. **Sprite crunch is cycle-exact**; MCBASE is 6-bit with a power-on anomaly that ends after one display (Task 4).
6. **The reference harness cannot silently pass**: an unexpected pass of a known-fail fails the suite; the PNG decoder handles every filter type (Task 5).

---

## File Structure

```
src/core/bus.ts, src/core/cpu.ts      Task 1: CpuHooks.rdy + stall in read()
src/machine/vic-schedule.ts           Task 2: sprite P cycles, SPRITE_BA windows
src/machine/vic.ts                    Tasks 2-3: tick() restructure, BA, c/g access, border flip-flops
src/machine/vic-sprites.ts            Tasks 2, 4: dmaMask, crunch, MCBASE, persistent shifters
src/machine/c64.ts                    Task 2: rdy wiring, priming tick
scripts/fetch-test-data.mjs           Task 5: vicetests source (listed at pin time)
scripts/gen-vice-manifest.mjs         Task 6: candidate manifest generator
test/core/stall.test.ts               Task 1
test/machine/vic-timing.test.ts       Task 2
test/machine/vic-border.test.ts       Task 3
test/machine/vic-sprite-quirks.test.ts Task 4
test/conformance/png.ts, png.test.ts  Task 5: PNG decoder
test/conformance/vice.test.ts, vice-tests.json   Tasks 5-6
```

---

### Task 1: The `rdy` hook and stall semantics (core)

**Files:**
- Modify: `src/core/bus.ts`, `src/core/cpu.ts`
- Test: `test/core/stall.test.ts`

**Interfaces:**
- Produces: `CpuHooks.rdy?(): boolean`. While it returns false, every bus **read** is preceded by idle cycles (`cycles++`, `onCycle()`, interrupt sampling, no bus access), up to `MAX_STALL_CYCLES = 4096` consecutive idle cycles per read. Writes never wait.

- [ ] **Step 1: Write the failing test**

`test/core/stall.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { MOS6502 } from '../../src/core';
import { I } from '../../src/core/flags';
import { RamBus } from './helpers';

function rig(program: number[], rdy: (cpu: MOS6502) => boolean, onCycle?: (cpu: MOS6502) => void) {
  const bus = new RamBus();
  bus.mem.set(program, 0x0200);
  bus.mem[0xfffc] = 0x00;
  bus.mem[0xfffd] = 0x02;
  bus.mem[0xfffe] = 0x00;
  bus.mem[0xffff] = 0x03;
  const ref: { cpu?: MOS6502 } = {};
  const cpu = new MOS6502(bus, {
    rdy: () => rdy(ref.cpu!),
    onCycle: () => onCycle?.(ref.cpu!),
  });
  ref.cpu = cpu;
  return { cpu, bus };
}

describe('CpuHooks.rdy', () => {
  it('holds a read for each idle cycle, with no bus access, and counts the cycles', () => {
    // BA low for cycles 7..9 (the three cycles after reset): the opcode fetch waits.
    const { cpu, bus } = rig([0xa9, 0x42], (c) => c.cycles >= 7 && c.cycles < 10);
    cpu.reset();
    bus.trace = [];
    expect(cpu.step()).toBe(5); // 3 idle + opcode + operand
    expect(cpu.regs.a).toBe(0x42);
    expect(bus.trace).toEqual([
      [0x0200, 0xa9, 'read'],
      [0x0201, 0x42, 'read'],
    ]);
  });

  it('never delays a write; the next read pays the remaining stall', () => {
    // STA $10 ; LDA #1. BA low for cycles 9..12 (index of cpu.cycles): the write is cycle 10.
    const { cpu, bus } = rig([0x85, 0x10, 0xa9, 0x01], (c) => c.cycles >= 9 && c.cycles < 12);
    cpu.regs.a = 0x77;
    cpu.reset();
    bus.trace = [];
    expect(cpu.step()).toBe(3); // opcode(8), operand(9), write(10): the write is not held
    expect(bus.mem[0x10]).toBe(0x77);
    expect(bus.trace![2]).toEqual([0x0010, 0x77, 'write']);
    expect(cpu.step()).toBe(4); // two idle cycles (10, 11) + opcode + operand
    expect(cpu.regs.a).toBe(0x01);
  });

  it('holds the dummy reads of indexed and read-modify-write instructions too', () => {
    // INC $10,X is 6 cycles. BA low for the whole instruction: only reads stall.
    const stolen: number[] = [];
    const { cpu } = rig([0xf6, 0x10], (c) => c.cycles >= 7 && c.cycles < 20, () => stolen.push(1));
    cpu.reset();
    const start = cpu.cycles;
    cpu.step();
    // 6 real cycles (4 reads + 2 writes); the two writes are not held, every read is.
    expect(cpu.cycles - start).toBeGreaterThan(6);
  });

  it('samples interrupt lines during idle cycles', () => {
    const { cpu } = rig(
      [0xea, 0xea],
      (c) => c.cycles >= 7 && c.cycles < 10,
      (c) => {
        if (c.cycles === 8) c.setIrq(true); // asserted while the CPU is held
      },
    );
    cpu.reset();
    cpu.regs.p &= ~I;
    expect(cpu.step()).toBe(5); // 3 idle + NOP
    expect(cpu.step()).toBe(7); // the interrupt sequence, taken at the instruction boundary
    expect(cpu.regs.pc).toBe(0x0300);
  });

  it('gives up after 4096 consecutive idle cycles per read (guard)', () => {
    const { cpu } = rig([0xa9, 0x01], () => false);
    cpu.reset();
    const start = cpu.cycles;
    cpu.step();
    expect(cpu.regs.a).toBe(0x01);
    expect(cpu.cycles - start).toBe(2 + 2 * 4096);
  });

  it('without the hook behaves exactly as before', () => {
    const bus = new RamBus();
    bus.mem.set([0xa9, 0x42], 0x0200);
    bus.mem[0xfffc] = 0x00;
    bus.mem[0xfffd] = 0x02;
    const cpu = new MOS6502(bus);
    cpu.reset();
    expect(cpu.step()).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/core/stall.test.ts`
Expected: FAIL (type error / the CPU never stalls: cycle counts differ).

- [ ] **Step 3: Implement**

`src/core/bus.ts`: add to `CpuHooks`:
```ts
  /**
   * Return false while the CPU must be held (BA low). Consulted before every bus READ;
   * writes never wait. The CPU idles one cycle (onCycle fires, interrupt lines are sampled)
   * per call that returns false.
   */
  rdy?(): boolean;
```

`src/core/cpu.ts`:
1. Below the imports add `const MAX_STALL_CYCLES = 4096;`.
2. Next to `private readonly onCycle` add `private readonly rdy: (() => boolean) | null;`.
3. In the constructor, after `this.onCycle = ...`: `this.rdy = hooks.rdy ? hooks.rdy.bind(hooks) : null;`.
4. Replace `read()`:
```ts
  private read(addr: number): number {
    if (this.rdy !== null) {
      for (let idle = 0; idle < MAX_STALL_CYCLES && !this.rdy(); idle++) this.endCycle();
    }
    const v = this.bus.read(addr & 0xffff) & 0xff;
    this.endCycle();
    return v;
  }
```

- [ ] **Step 4: Run to verify pass, including every existing CPU suite**

Run: `npx vitest run test/core && npm run test:conformance -- singlestep klaus && npm run typecheck && npm run lint`
Expected: PASS; the existing core and conformance suites are untouched and green.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): optional rdy hook holds the CPU on read cycles (BA stalls)" -m "Refs #<issue for task 1>" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01QAsVffzaJc51Ncx7uyv5AK"
```

---

### Task 2: Cycle schedule, BA, per-cycle badline condition, c/g-access timing

**Files:**
- Create: `src/machine/vic-schedule.ts`
- Modify: `src/machine/vic.ts` (rewrite of the cycle machine), `src/machine/vic-sprites.ts` (`dmaMask`, shared P table), `src/machine/c64.ts`
- Test: `test/machine/vic-timing.test.ts`

**Interfaces:**
- Produces: `VicII.baLow: boolean`; `VicII.debug.cycle` (the next cycle to be processed); `Sprites.dmaMask(): number`; `SPRITE_P_CYCLE`, `SPRITE_BA` from `vic-schedule.ts`; `C64` passes `rdy: () => !vic.baLow` and primes the VIC with one `tick()` after reset.

- [ ] **Step 1: Write the failing tests**

`test/machine/vic-timing.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { C64 } from '../../src/machine/c64';
import { VicII } from '../../src/machine/vic';
import { filled } from './helpers';
import { vicWorld } from './vic-helpers';

/** Ticks until `raster` becomes R (cycle 1 of line R processed) and records BA for cycles 1..63. */
function recordLine(vic: VicII, raster: number): boolean[] {
  while (vic.raster !== raster) vic.tick();
  const ba: boolean[] = [vic.baLow];
  for (let c = 2; c <= 63; c++) {
    vic.tick();
    ba.push(vic.baLow);
  }
  return ba;
}

const cyclesLow = (ba: boolean[]) => ba.flatMap((v, i) => (v ? [i + 1] : []));
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

function setup() {
  const w = vicWorld();
  w.vic.write(0x11, 0x1b); // DEN, RSEL, YSCROLL 3 -> badlines on rasters 51, 59, ...
  w.vic.write(0x18, 0x12);
  return w;
}

describe('BA waveform', () => {
  it('a plain line has no BA; a badline holds BA low in cycles 12-54', () => {
    const { vic } = setup();
    expect(cyclesLow(recordLine(vic, 50))).toEqual([]);
    expect(cyclesLow(recordLine(vic, 51))).toEqual(range(12, 54));
    expect(cyclesLow(recordLine(vic, 52))).toEqual([]);
  });

  it('DEN is only honoured if it was set during line $30', () => {
    const { vic } = setup();
    vic.write(0x11, 0x0b); // DEN off before line $30
    expect(cyclesLow(recordLine(vic, 51))).toEqual([]);
  });

  it('one sprite adds a 5-cycle window; adjacent windows merge; wrapped windows cross the line', () => {
    const w = setup();
    const { vic, ram } = w;
    // sprite 0 only, Y=100 (DMA on at cycle 55 of line 100)
    vic.write(0x15, 0x01);
    vic.write(0x01, 100);
    ram[0x07f8] = 0x40;
    expect(cyclesLow(recordLine(vic, 100))).toEqual(range(55, 59));
    expect(cyclesLow(recordLine(vic, 101))).toEqual(range(55, 59));
  });

  it('all eight sprites: cycles 55-63 on the starting line and 1-10 plus 55-63 afterwards', () => {
    const { vic } = setup();
    vic.write(0x15, 0xff);
    for (let n = 0; n < 8; n++) vic.write(1 + 2 * n, 100);
    expect(cyclesLow(recordLine(vic, 100))).toEqual(range(55, 63));
    expect(cyclesLow(recordLine(vic, 101))).toEqual([...range(1, 10), ...range(55, 63)]);
  });

  it('sprite 3 alone: its window wraps (61-63 of the previous line, 1-2 of the next)', () => {
    const { vic } = setup();
    vic.write(0x15, 0x08);
    vic.write(0x07, 100);
    expect(cyclesLow(recordLine(vic, 100))).toEqual([61, 62, 63]);
    expect(cyclesLow(recordLine(vic, 101))).toEqual([1, 2, 61, 62, 63]);
  });
});

describe('badline start timing', () => {
  it('a condition that appears at cycle 30 starts BA at 30 and holds it through cycle 54', () => {
    const { vic } = setup();
    vic.write(0x11, 0x1c); // YSCROLL 4: no badline on raster 51
    while (vic.raster !== 51) vic.tick();
    const ba: boolean[] = [vic.baLow];
    for (let c = 2; c <= 63; c++) {
      if (c === 30) vic.write(0x11, 0x1b); // YSCROLL 3: seen when cycle 30 is processed
      vic.tick();
      ba.push(vic.baLow);
    }
    expect(cyclesLow(ba)).toEqual(range(30, 54));
  });
});

describe('c-access leads g-access by one cycle', () => {
  it('reads the matrix byte of cell n+1 in the same cycle as the glyph of cell n', () => {
    const reads: number[] = [];
    const ram = new Uint8Array(0x4000);
    const vic = new VicII({
      readMem: (a) => {
        reads.push(a);
        return ram[a]!;
      },
      readColor: () => 0,
    });
    vic.write(0x11, 0x1b);
    vic.write(0x18, 0x12); // matrix $0400, chars $0800
    ram[0x0400] = 5;
    ram[0x0401] = 6;
    while (vic.raster !== 51) vic.tick(); // cycle 1 of line 51 processed
    reads.length = 0;
    for (let c = 2; c <= 17; c++) vic.tick();
    const matrixAndGlyph = reads.filter((a) => a >= 0x0400 && a < 0x0900);
    // cycle 15: matrix[0]; cycle 16: glyph(code 5, row 0) then matrix[1]; cycle 17: glyph(code 6) ...
    expect(matrixAndGlyph.slice(0, 5)).toEqual([0x0400, 0x0828, 0x0401, 0x0830, 0x0402]);
  });
});

describe('machine-level stolen cycles', () => {
  /** A KERNAL that enables the display and then runs NOPs forever. */
  function nopMachine(den: boolean) {
    const kernal = filled(8192, 0xea);
    const prologue = [0xa9, den ? 0x1b : 0x0b, 0x8d, 0x11, 0xd0, 0x4c, 0x08, 0xe0];
    kernal.set(prologue, 0);
    kernal[0x1ffc] = 0x00;
    kernal[0x1ffd] = 0xe0;
    // $E008.. is all NOPs (0xEA); a JMP back near the end of ROM keeps the loop going
    kernal.set([0x4c, 0x08, 0xe0], 0x1000);
    return new C64({ kernal, basic: filled(8192, 0), chargen: filled(4096, 0) });
  }

  function stolenPerFrame(c64: C64): number {
    c64.runFrame(); // settle: DEN seen on line $30
    c64.runFrame();
    const start = c64.cpu.cycles;
    let instructions = 0;
    const end = start + 19_656 * 10;
    while (c64.cpu.cycles < end) {
      c64.cpu.step();
      instructions++;
    }
    const total = c64.cpu.cycles - start;
    return (total - 2 * instructions) / (total / 19_656);
  }

  it('with the display off the CPU is never held', () => {
    expect(stolenPerFrame(nopMachine(false))).toBeLessThan(6); // JMP loop overhead only
  });

  it('with the display on a read-only CPU loses 25 badlines x 43 cycles per frame', () => {
    const stolen = stolenPerFrame(nopMachine(true));
    expect(stolen).toBeGreaterThan(1075 - 14);
    expect(stolen).toBeLessThan(1075 + 14);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/machine/vic-timing.test.ts`
Expected: FAIL — `vic.baLow` is undefined / BA never goes low.

- [ ] **Step 3: Write `src/machine/vic-schedule.ts`**

```ts
/** PAL: the cycle (1..63) of each sprite's pointer fetch; the data bytes follow in the next cycle. */
export const SPRITE_P_CYCLE = [58, 60, 62, 1, 3, 5, 7, 9] as const;

/**
 * SPRITE_BA[c] bit n: BA is low in cycle c because sprite n's DMA window covers it (only while
 * that sprite's DMA is on). The window runs from 3 cycles before the pointer fetch to the last
 * data cycle (P-3 .. P+1) and wraps across the line boundary.
 */
export const SPRITE_BA = new Uint8Array(64);
SPRITE_P_CYCLE.forEach((p, n) => {
  for (let k = -3; k <= 1; k++) {
    const c = ((p + k - 1 + 63) % 63) + 1;
    SPRITE_BA[c]! |= 1 << n;
  }
});
```

- [ ] **Step 4: Update `src/machine/vic-sprites.ts`**

1. Import the shared table: `import { SPRITE_P_CYCLE } from './vic-schedule';` and replace the local `FETCH_CYCLE` array with `SPRITE_P_CYCLE` (`SPRITE_P_CYCLE.forEach((cycle, n) => { FETCH_AT[cycle] = n; });`).
2. Add a method:
```ts
  /** Bit n set = sprite n's DMA is on. */
  dmaMask(): number {
    let m = 0;
    for (let n = 0; n < 8; n++) if (this.dma[n]) m |= 1 << n;
    return m;
  }
```

- [ ] **Step 5: Rewrite the cycle machine in `src/machine/vic.ts`**

Replace the field block, `debug`, `reset()`, `tick()`, `nextLine`/`startLine`/`beginDisplayLine`/`endDisplayLine` and the `outputCycle` header as follows (registers `read/peek/write`, `checkRasterCompare`, `hitSprites/hitBackground` and the pixel/border/sprite loop at the end of `outputCycle` stay exactly as they are for now).

1. Imports: add `import { SPRITE_BA } from './vic-schedule';` and constants
```ts
const FIRST_C_CYCLE = 15;
const LAST_C_CYCLE = 54;
```
2. Fields: remove `denLatch`, `badline`; add/replace:
```ts
  /** BA during the cycle most recently processed: true holds the CPU on read cycles. */
  baLow = false;

  /** The cycle the next tick() processes. */
  private cycle = 2;
  private lineWrapPending = false;
  private denSeen = false;
  /** Cycle at which BA went low for the current badline, or -1. */
  private baStart = -1;
  private readonly chars = new Uint8Array(64);
  private readonly colors = new Uint8Array(64);
```
(the old `chars`/`colors` of length 40 are replaced.)
3. `debug`: add `cycle: this.cycle` to the returned object.
4. `reset()`: replace the lines that set `denLatch`, `badline`, `raster`, `cycle` with
```ts
    this.denSeen = false;
    this.displayState = false;
    this.baStart = -1;
    this.baLow = false;
    this.lineWrapPending = false;
    this.vcBase = this.vc = this.rc = this.vmli = 0;
    this.raster = 0;
    this.cycle = 2;
    this.chars.fill(0);
    this.colors.fill(0);
```
(keep the `prevColor/prevFg`, sprite resets and `matched = true`).
5. Replace `tick()` and delete `nextLine`, `startLine`, `beginDisplayLine`, `endDisplayLine`, adding:
```ts
  tick(): void {
    const c = this.cycle;
    const regs = this.regs;

    // Line start: the raster counter increments in cycle 1; it wraps to 0 in cycle 2 of line 0.
    if (c === 1) {
      this.baStart = -1;
      if (this.raster === LINES - 1) {
        this.lineWrapPending = true;
      } else {
        this.raster++;
        this.newRaster();
      }
    } else if (c === 2 && this.lineWrapPending) {
      this.lineWrapPending = false;
      this.raster = 0;
      this.vcBase = 0;
      this.frameCount++;
      this.newRaster();
    }
    if (this.raster === 0x30 && (regs[0x11]! & 0x10) !== 0) this.denSeen = true;

    // Badline condition, evaluated every cycle.
    const cond =
      this.denSeen &&
      this.raster >= 0x30 &&
      this.raster <= 0xf7 &&
      (this.raster & 7) === (regs[0x11]! & 7);
    if (cond) {
      this.displayState = true;
      if (c >= 12 && c <= LAST_C_CYCLE && this.baStart < 0) this.baStart = c;
    }
    if (c === 14) {
      this.vc = this.vcBase;
      this.vmli = 0;
      if (cond) this.rc = 0;
    }

    this.sprites.cycle(c, this.raster);
    this.graphics(c);
    const visible = c >= FIRST_VISIBLE_CYCLE && c <= LAST_VISIBLE_CYCLE;
    if (visible || this.sprites.active !== 0) this.outputCycle(c, visible);

    if (c === 58) {
      if (this.rc === 7) {
        this.displayState = cond;
        this.vcBase = this.vc;
      }
      if (this.displayState) this.rc = (this.rc + 1) & 7;
    }

    // BA for this cycle: the CPU consults it before its access.
    let ba = this.baStart >= 0 && c <= LAST_C_CYCLE;
    if (!ba) ba = (SPRITE_BA[c]! & this.sprites.dmaMask()) !== 0;
    this.baLow = ba;

    this.cycle = c === CYCLES_PER_LINE ? 1 : c + 1;
  }

  private newRaster(): void {
    if (this.raster === 0x30) this.denSeen = (this.regs[0x11]! & 0x10) !== 0;
    this.checkRasterCompare();
  }

  /** g-access (phi1, cycles 16-55) then c-access (phi2, cycles 15-54). */
  private graphics(c: number): void {
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
        code = this.chars[this.vmli & 63]!;
        nibble = this.colors[this.vmli & 63]!;
        let addr: number;
        if (mode & 2) {
          addr = ((regs[0x18]! & 0x08) << 10) | (this.vc << 3) | this.rc;
        } else {
          const cb = ((regs[0x18]! >> 1) & 0x07) << 11;
          addr = cb + ((ecm ? code & 0x3f : code) << 3) + this.rc;
        }
        glyph = this.mem.readMem(addr);
        this.vc = (this.vc + 1) & 0x3ff;
        this.vmli = (this.vmli + 1) & 63;
      } else {
        glyph = this.mem.readMem(ecm ? 0x39ff : 0x3fff);
      }
      renderGraphics(this.gColor, this.gFg, mode, glyph, code, nibble, bg);
    } else {
      this.gColor.fill(bg[0]!);
      this.gFg.fill(0);
    }

    if (this.baStart >= 0 && c >= Math.max(FIRST_C_CYCLE, this.baStart + 3) && c <= LAST_C_CYCLE) {
      const vm = ((regs[0x18]! >> 4) & 0x0f) << 10;
      this.chars[this.vmli & 63] = this.mem.readMem(vm + this.vc);
      this.colors[this.vmli & 63] = this.mem.readColor(this.vc & 0x3ff) & 0x0f;
    }
  }
```
6. In `outputCycle(c, visible)` delete everything from the top of the method down to and including the line `this.prevFg.set(this.gFg);` **except** the XSCROLL block; i.e. the method now starts with the `const regs = this.regs;` line, followed by the XSCROLL shift loop and the two `prev*.set(...)` lines, then the unchanged border/sprite pixel loop. (`graphics()` already produced `gColor`/`gFg` for this cycle.)

- [ ] **Step 6: Wire the machine (`src/machine/c64.ts`)**

1. In the constructor change the CPU creation to
```ts
    this.cpu = new MOS6502(this.bus, {
      onCycle: () => this.tickChips(),
      rdy: () => !this.vic.baLow,
    });
```
2. In `reset()`, after `this.vic.reset();` add `this.vic.tick(); // process the first cycle before the CPU's first access`.

- [ ] **Step 7: Run to verify pass, then the whole suite**

Run: `npx vitest run test/machine && npm test && npm run test:conformance && npm run typecheck && npm run lint`
Expected: new tests PASS. The earlier VIC/sprite/machine tests must still pass; if an old expectation encoded the removed approximation (for example a cycle-exact count), update it, keep the intent, and record a `Ruling:` line. The OpenROMs boot, typing and `graphics-test.prg` conformance tests must pass on the stalled machine.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(machine): cycle-exact VIC access schedule, BA stalls and per-cycle badline condition" -m "Refs #<issue for task 2>" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01QAsVffzaJc51Ncx7uyv5AK"
```

---

### Task 3: Border flip-flops and border-independent foreground

**Files:**
- Modify: `src/machine/vic.ts`
- Test: `test/machine/vic-border.test.ts`

**Interfaces:**
- Consumes: Task 2's `tick()`/`outputCycle`.
- Produces: main and vertical border flip-flops evaluated per pixel and at cycle 63; the foreground flag no longer depends on the border; side and top/bottom borders can be opened.

- [ ] **Step 1: Write the failing tests**

`test/machine/vic-border.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { PALETTE } from '../../src/machine/palette';
import type { VicII } from '../../src/machine/vic';
import { px, runFrames, vicWorld } from './vic-helpers';

const P = (i: number) => PALETTE[i]!;

function setup() {
  const w = vicWorld();
  w.vic.write(0x11, 0x1b);
  w.vic.write(0x16, 0x08);
  w.vic.write(0x18, 0x12);
  w.vic.write(0x20, 0x0e); // border light blue
  w.vic.write(0x21, 0x06); // background blue
  return w;
}

/** Ticks until the next tick will process `cycle` of `raster`. */
function runTo(vic: VicII, raster: number, cycle: number): void {
  while (!(vic.raster === raster && vic.debug.cycle === cycle)) vic.tick();
}

describe('static windows are unchanged', () => {
  it('25x40 window: graphics inside x 32..351, y 36..235, border outside', () => {
    const { vic } = setup();
    runFrames(vic, 2);
    expect(px(vic, 31, 100)).toBe(P(14));
    expect(px(vic, 32, 100)).toBe(P(6));
    expect(px(vic, 351, 100)).toBe(P(6));
    expect(px(vic, 352, 100)).toBe(P(14));
    expect(px(vic, 100, 35)).toBe(P(14));
    expect(px(vic, 100, 36)).toBe(P(6));
    expect(px(vic, 100, 235)).toBe(P(6));
    expect(px(vic, 100, 236)).toBe(P(14));
  });

  it('38 columns / 24 rows', () => {
    const { vic } = setup();
    vic.write(0x16, 0x00);
    vic.write(0x11, 0x13);
    runFrames(vic, 2);
    expect(px(vic, 38, 100)).toBe(P(14));
    expect(px(vic, 39, 100)).toBe(P(6));
    expect(px(vic, 342, 100)).toBe(P(6));
    expect(px(vic, 343, 100)).toBe(P(14));
    expect(px(vic, 100, 39)).toBe(P(14));
    expect(px(vic, 100, 40)).toBe(P(6));
  });

  it('DEN=0 keeps the whole frame in the border', () => {
    const { vic } = setup();
    vic.write(0x11, 0x0b);
    runFrames(vic, 2);
    expect(px(vic, 100, 100)).toBe(P(14));
  });
});

describe('opening the side border', () => {
  it('switching CSEL off just before the right compare and on again opens the border for that line', () => {
    const { vic } = setup();
    runFrames(vic, 2);
    runTo(vic, 100, 55); // raster 100, about to process cycle 55 (X 336..343)
    vic.write(0x16, 0x00); // CSEL=0: the right compare moves to X=335, which is already past
    runTo(vic, 100, 58);
    vic.write(0x16, 0x08); // CSEL=1 again for the next line's left compare
    while (vic.raster !== 102) vic.tick();
    const y = 100 - 15;
    expect(px(vic, 360, y)).toBe(P(6)); // graphics where the border would be
    expect(px(vic, 380, y)).toBe(P(6));
    expect(px(vic, 360, y + 1)).toBe(P(14)); // the next line is back to a normal border
    expect(px(vic, 360, y - 1)).toBe(P(14));
  });
});

describe('opening the bottom border', () => {
  it('RSEL=1 until line 247, then RSEL=0 through line 251: the vertical flip-flop is never set', () => {
    const { vic } = setup();
    runFrames(vic, 2);
    runTo(vic, 248, 2); // cycle 1 of line 248 processed
    vic.write(0x11, 0x13); // RSEL=0: bottom compare 247 already passed, 251 no longer matches
    while (vic.raster !== 262) vic.tick();
    expect(px(vic, 100, 255 - 15)).toBe(P(6)); // would be border without the trick
    expect(px(vic, 100, 260 - 15)).toBe(P(6));
  });
});

describe('the foreground flag does not depend on the border', () => {
  it('a sprite behind the foreground still collides with graphics under the 38-column side strip', () => {
    const w = setup();
    const { vic, ram, color } = w;
    vic.write(0x16, 0x00); // CSEL=0: the strips at X 24..30 are border
    ram[0x0400] = 1;
    color[0] = 5;
    ram[0x0808] = 0xff; // solid foreground in cell 0, row 0
    ram[0x07f8] = 0x40;
    ram[0x40 * 64] = 0xfe; // row 0: only the 7 leftmost pixels (X 24..30), all under the strip
    vic.write(0x00, 24); // sprite 0 at X=24, over the hidden strip
    vic.write(0x01, 50);
    vic.write(0x27, 2);
    vic.write(0x15, 0x01);
    runFrames(vic, 3);
    expect(vic.peek(0x1f) & 1).toBe(1); // collision with graphics under the strip
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/machine/vic-border.test.ts`
Expected: FAIL — the opening tests show border colour (rectangle logic) and the collision under the strip is missed.

- [ ] **Step 3: Implement in `src/machine/vic.ts`**

1. Fields:
```ts
  private mainBorder = true;
  private verticalBorder = true;
```
and in `reset()`: `this.mainBorder = true; this.verticalBorder = true;`.

2. In `outputCycle`, replace the block from `const csel = ...` through the end of the pixel loop with:
```ts
    const csel = (regs[0x16]! & 0x08) !== 0;
    const rsel = (regs[0x11]! & 0x08) !== 0;
    const den = (regs[0x11]! & 0x10) !== 0;
    const left = csel ? 24 : 31;
    const right = csel ? 344 : 335;
    const top = rsel ? 51 : 55;
    const bottom = rsel ? 251 : 247;
    const border = regs[0x20]! & 0x0f;
    const writeFrame =
      visible && this.raster >= FIRST_VISIBLE_RASTER && this.raster <= LAST_VISIBLE_RASTER;
    const rowBase = (this.raster - FIRST_VISIBLE_RASTER) * FRAME_WIDTH;
    const fx0 = (c - FIRST_VISIBLE_CYCLE) * 8;
    const x0 = ((((c - FIRST_VISIBLE_CYCLE) * 8 + 496) % 504) + 504) % 504;
    const spritesOn = this.sprites.active !== 0;

    for (let i = 0; i < 8; i++) {
      const x = (x0 + i) % 504;
      if (visible) {
        // Bauer 3.9: the border flip-flops are driven by the X and Y comparisons.
        if (x === right) this.mainBorder = true;
        if (x === left) {
          if (this.raster === bottom) this.verticalBorder = true;
          else if (this.raster === top && den) this.verticalBorder = false;
          if (!this.verticalBorder) this.mainBorder = false;
        }
      }
      let colour = this.shiftedColor[i]!;
      const fg = this.shiftedFg[i]!;
      if (spritesOn) {
        this.sprites.sample(x);
        const mask = this.sprites.mask;
        if (mask !== 0) {
          if ((mask & (mask - 1)) !== 0) this.hitSprites(mask);
          if (fg) this.hitBackground(mask);
          const n = 31 - Math.clz32(mask & -mask); // lowest-numbered sprite wins
          if (!((regs[0x1b]! >> n) & 1 && fg)) colour = this.sprites.colors[n]!;
        }
      }
      if (writeFrame) {
        this.frame[rowBase + fx0 + i] = PALETTE[this.mainBorder ? border : colour]!;
      }
    }
```
3. In `tick()`, right after the `if (c === 58) {...}` block add the cycle-63 rules:
```ts
    if (c === 63) {
      const rsel = (regs[0x11]! & 0x08) !== 0;
      const bottom = rsel ? 251 : 247;
      const top = rsel ? 51 : 55;
      if (this.raster === bottom) this.verticalBorder = true;
      else if (this.raster === top && (regs[0x11]! & 0x10) !== 0) this.verticalBorder = false;
    }
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/machine && npm test && npm run test:conformance && npm run typecheck && npm run lint`
Expected: PASS, with the earlier window, sprite and conformance tests unchanged. If the earlier "the border hides sprites" or "collisions under the border" tests need a changed expectation because of the foreground change, update them and add a `Ruling:` line.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(machine): VIC-II border flip-flops enable border opening; foreground independent of the border" -m "Refs #<issue for task 3>" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01QAsVffzaJc51Ncx7uyv5AK"
```

---

### Task 4: Sprite quirks (crunch, 6-bit MCBASE, persistent shifters) and the ECM mask

**Files:**
- Modify: `src/machine/vic-sprites.ts`, `src/machine/vic.ts`, `test/machine/vic-sprites.test.ts` (rig primes MCBASE)
- Test: `test/machine/vic-sprite-quirks.test.ts`

**Interfaces:**
- Produces: `Sprites.busy` (`display` mask or running shifters); `VicII.clearSpriteMcBase()` (`@internal`, for tests that need the post-anomaly state); MCBASE is a 6-bit counter, `$3F` at power-on, cleared when sprite display ends; `expandFF` is evaluated every cycle; shifters are not reset at line boundaries and keep running after the display flag drops.

- [ ] **Step 1: Write the failing tests**

`test/machine/vic-sprite-quirks.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { VicII } from '../../src/machine/vic';
import { Sprites } from '../../src/machine/vic-sprites';

function rig(primed = true) {
  const regs = new Uint8Array(0x40);
  const ram = new Uint8Array(0x4000);
  const sprites = new Sprites(regs, { readMem: (a) => ram[a & 0x3fff]! });
  regs[0x18] = 0x10;
  if (primed) sprites.mcBase.fill(0);
  return { regs, ram, sprites };
}

function enable(r: ReturnType<typeof rig>, n: number, x: number, y: number, ptr = 0x40) {
  r.regs[0x15]! |= 1 << n;
  r.regs[2 * n] = x & 0xff;
  if (x & 0x100) r.regs[0x10]! |= 1 << n;
  r.regs[1 + 2 * n] = y;
  r.ram[0x07f8 + n] = ptr;
  for (let i = 0; i < 63; i++) r.ram[ptr * 64 + i] = 0xff;
}

/** One line; `afterCycle` runs after the given cycle (a CPU write there is seen by the next one). */
function line(
  r: ReturnType<typeof rig>,
  raster: number,
  afterCycle?: { cycle: number; fn: () => void },
) {
  const masks = new Array<number>(504).fill(0);
  for (let c = 1; c <= 63; c++) {
    r.sprites.cycle(c, raster);
    if (r.sprites.busy) {
      const x0 = ((((c - 12) * 8 + 496) % 504) + 504) % 504;
      for (let i = 0; i < 8; i++) {
        const x = (x0 + i) % 504;
        r.sprites.sample(x);
        masks[x] = r.sprites.mask;
      }
    }
    if (afterCycle && afterCycle.cycle === c) afterCycle.fn();
  }
  return masks;
}

describe('MCBASE', () => {
  it('is a 6-bit counter that powers up at $3F: the first display lasts 64 lines, then it is normal', () => {
    const r = rig(false);
    enable(r, 0, 100, 50);
    const shown: number[] = [];
    for (let raster = 40; raster <= 200; raster++) {
      line(r, raster);
      // display flag during the line = on at cycle 30 of this line (set at cycle 58 before)
      if (r.sprites.display[0]) shown.push(raster);
    }
    expect(shown.length).toBeGreaterThanOrEqual(63);
    const second: number[] = [];
    for (let raster = 40; raster <= 90; raster++) {
      line(r, raster);
      if (r.sprites.display[0]) second.push(raster);
    }
    expect(second.length).toBeLessThanOrEqual(22);
    expect(second.length).toBeGreaterThanOrEqual(20);
  });

  it('is cleared when display ends, not when DMA turns on', () => {
    const r = rig(true);
    enable(r, 0, 100, 50);
    for (let raster = 40; raster <= 80; raster++) line(r, raster);
    expect(r.sprites.mcBase[0]).toBe(0);
  });
});

describe('sprite crunch', () => {
  /** Y-expanded sprite; returns mcBase after the cycle-16 of the line where expandFF is 0. */
  function mcBaseAfterLine(clearAt: number | null) {
    const r = rig(true);
    enable(r, 0, 100, 50);
    r.regs[0x17] = 0x01;
    for (let raster = 40; raster <= 52; raster++) line(r, raster);
    // line 53: on a Y-expanded sprite the flip-flop alternates, so find a line with it cleared
    const before = r.sprites.mcBase[0]!;
    line(r, 53, clearAt === null ? undefined : { cycle: clearAt, fn: () => (r.regs[0x17] = 0) });
    return { before, after: r.sprites.mcBase[0]! };
  }

  it('clearing Y-expand before cycle 15 advances MCBASE by 3, after cycle 16 not at all', () => {
    const none = mcBaseAfterLine(null);
    const early = mcBaseAfterLine(14); // visible to cycle 15 and 16
    const late = mcBaseAfterLine(16); // visible only after the increments
    const delta = (o: { before: number; after: number }) => (o.after - o.before + 64) % 64;
    expect(delta(late)).toBe(delta(none));
    expect(delta(early)).toBe(3);
  });

  it('clearing between cycle 15 and 16 advances MCBASE by only 1 (the crunch)', () => {
    const none = mcBaseAfterLine(null);
    const crunch = mcBaseAfterLine(15);
    const d = (o: { before: number; after: number }) => (o.after - o.before + 64) % 64;
    expect(d(none)).toBe(0); // on this line the flip-flop is clear, so no increment normally
    expect(d(crunch)).toBe(1); // flip-flop set between cycle 15 and 16: +0 at 15, +1 at 16
  });
});

describe('shifters', () => {
  it('a started shifter finishes its row after the display flag drops at cycle 58', () => {
    const r = rig(true);
    // sprite 0: X=350, Y=50, only its LAST row (row 20) is set; sprite 1 at X=360 overlaps it.
    r.regs[0x15] = 0x03;
    r.regs[0] = 350 - 256;
    r.regs[1] = 50;
    r.regs[2] = 360 - 256;
    r.regs[3] = 51;
    r.regs[0x10] = 0x03; // X bit 8 of sprites 0 and 1
    r.ram[0x07f8] = 0x40;
    r.ram[0x07f9] = 0x41;
    for (let i = 60; i < 63; i++) r.ram[0x40 * 64 + i] = 0xff; // row 20 of sprite 0
    for (let i = 0; i < 63; i++) r.ram[0x41 * 64 + i] = 0xff;
    let last: number[] = [];
    for (let raster = 40; raster <= 71; raster++) last = line(r, raster);
    // raster 71: sprite 0's last row, X 350..373; sprite 1 (rows from 52) covers X 360..383
    expect(last[365]).toBe(0b11);
  });

  it('a shifter started at the end of a line keeps running into the next line', () => {
    const r = rig(true);
    r.regs[0x15] = 0x01;
    r.regs[0] = 400 - 256;
    r.regs[0x10] = 0x01;
    r.regs[1] = 50;
    r.ram[0x07f8] = 0x40;
    for (let i = 0; i < 63; i++) r.ram[0x40 * 64 + i] = 0xff;
    for (let raster = 40; raster <= 51; raster++) line(r, raster);
    const next = line(r, 52);
    expect(next[410]).toBe(1); // tail of the shifter that started at X=400 on line 51
  });
});

describe('ECM address mask', () => {
  it('ECM + BMM never fetches with address bits 9 or 10 set', () => {
    const reads: number[] = [];
    const ram = new Uint8Array(0x4000);
    const vic = new VicII({
      readMem: (a) => {
        reads.push(a);
        return ram[a]!;
      },
      readColor: () => 0,
    });
    vic.write(0x11, 0x7b); // ECM + BMM + DEN + RSEL + YSCROLL 3
    vic.write(0x18, 0x18); // bitmap at $2000, matrix at $0400
    for (let f = 0; f < 2; f++) {
      const start = vic.frameCount;
      while (vic.frameCount === start) vic.tick();
    }
    const bitmapReads = reads.filter((a) => a >= 0x2000 && a < 0x4000);
    expect(bitmapReads.length).toBeGreaterThan(1000);
    expect(bitmapReads.every((a) => (a & 0x600) === 0)).toBe(true);
  });
});
```

(Clean up the redundant register assignments in the "finishes its row" test while writing it; only the final values matter: sprite 0 at X=350 (`regs[0]=94`, `regs[0x10]` bit 0), sprite 1 at X=360 (`regs[2]=104`, bit 1).)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/machine/vic-sprite-quirks.test.ts`
Expected: FAIL — `sprites.busy` is undefined; MCBASE and shifter behaviour differ.

- [ ] **Step 3: Implement in `src/machine/vic-sprites.ts`**

1. Fields: add `private running = 0;` and
```ts
  /** True while any sprite is displayed or still shifting out a started row. */
  get busy(): boolean {
    return (this.active | this.running) !== 0;
  }
```
2. `reset()`: `this.mcBase.fill(0x3f); this.running = 0;`.
3. Delete `newLine()` (and its call in `VicII`; Task 2 already removed the call).
4. `cycle()`:
   - At the top, add the per-cycle flip-flop evaluation:
```ts
    for (let n = 0; n < 8; n++) if (((regs[0x17]! >> n) & 1) === 0) this.expandFF[n] = 1;
```
   - Cycles 15 and 16: use 6-bit arithmetic: `this.mcBase[n] = (this.mcBase[n]! + 2) & 0x3f;` and `+ 1`.
   - Cycle 55: only toggle when Y-expand is set (remove the `else this.expandFF[n] = 1`).
   - `dmaCheck`: do **not** clear `mcBase` on DMA start (keep resetting `expandFF` when Y-expand is set).
   - Cycle 58: replace the display handling with
```ts
        for (let n = 0; n < 8; n++) {
          this.mc[n] = this.mcBase[n]!;
          if (!this.dma[n]) {
            if (this.display[n]) this.mcBase[n] = 0; // display ends: MCBASE is cleared now
            this.display[n] = 0;
          } else if (regs[1 + 2 * n] === (raster & 0xff)) this.display[n] = 1;
        }
```
5. `sample()`: iterate sprites that are displayed **or** running; a shifter may only start when `display` is on, and `running` is recomputed:
```ts
    for (let n = 0; n < 8; n++) {
      const displayed = ((this.active >> n) & 1) !== 0;
      let p = this.pos[n]!;
      if (p < 0) {
        if (!displayed) continue;
        const sx = regs[2 * n]! | (((regs[0x10]! >> n) & 1) << 8);
        if (x !== sx) continue;
        p = 0;
        this.shiftData[n] = this.data[n]!;
      }
      ...unchanged colour/mask logic...
      p++;
      this.pos[n] = p >= 24 << xexp ? -1 : p;
    }
    let running = 0;
    for (let n = 0; n < 8; n++) if (this.pos[n]! >= 0) running |= 1 << n;
    this.running = running;
    this.mask = mask;
```

- [ ] **Step 4: Implement in `src/machine/vic.ts`**

1. Replace every `this.sprites.active !== 0` with `this.sprites.busy` (in `tick()` and `outputCycle`).
2. Add:
```ts
  /** @internal Test helper: the post-power-on state in which no sprite anomaly is pending. */
  clearSpriteMcBase(): void {
    this.sprites.mcBase.fill(0);
  }
```
3. ECM address mask for the bitmap fetch in `graphics()`:
```ts
        if (mode & 2) {
          addr = ((regs[0x18]! & 0x08) << 10) | (this.vc << 3) | this.rc;
          if (ecm) addr &= ~0x600; // ECM forces address bits 9 and 10 low (like the idle access)
        }
```

- [ ] **Step 5: Keep the earlier tests meaningful**

- `test/machine/vic-sprites.test.ts`: in `rig()` add `sprites.mcBase.fill(0);` after the constructor, and remove the `sprites.newLine();` call in its `runLine` helper.
- `test/machine/vic-helpers.ts`: in `vicWorld()` add `vic.clearSpriteMcBase();` before returning, **except** in tests that assert the anomaly (this task's tests build their own rigs).

- [ ] **Step 6: Run to verify pass**

Run: `npx vitest run test/machine && npm test && npm run test:conformance && npm run typecheck && npm run lint`
Expected: PASS. The OpenROMs graphics conformance test must still pass: the first appearance of the sprites is now anomalous for one frame, and the test samples after 300 frames.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(machine): sprite crunch, 6-bit MCBASE with power-on anomaly, persistent shifters, ECM bitmap mask" -m "Refs #<issue for task 4>" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01QAsVffzaJc51Ncx7uyv5AK"
```

---

### Task 5: PNG decoder, the `vicetests` source and the comparison harness

**Files:**
- Modify: `scripts/fetch-test-data.mjs`
- Create: `test/conformance/png.ts`, `test/conformance/png.test.ts`, `test/conformance/vice.test.ts`, `test/conformance/vice-tests.json` (initially an empty list)
- Modify: `docs/test-data-notes.md`

**Interfaces:**
- Produces: `decodePng(bytes): { width, height, data /* RGBA */ }`; the `vicetests` source in the fetch script (file list resolved at pin time and stored in the manifest); a harness that, per manifest entry, boots OpenROMs, loads the PRG, runs `frames` frames and compares the 384x272 frame to the reference exactly.

- [ ] **Step 1: Write the failing PNG test**

`test/conformance/png.test.ts`:
```ts
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodePng } from './png';

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function png(width: number, height: number, colorType: number, rows: number[][]): Uint8Array {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const raw = rows.flatMap((r) => r);
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Uint8Array.from(raw))),
    chunk('IEND', new Uint8Array(0)),
  ];
  return Uint8Array.from(parts.flatMap((p) => [...p]));
}

describe('decodePng', () => {
  it('decodes 8-bit RGBA with filter type 0', () => {
    const img = decodePng(png(2, 1, 6, [[0, 1, 2, 3, 255, 4, 5, 6, 255]]));
    expect([img.width, img.height]).toEqual([2, 1]);
    expect([...img.data]).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
  });

  it('applies the Sub, Up, Average and Paeth filters', () => {
    // 2x4 RGBA image, 4 scanlines, one filter type each (1..4)
    const rows = [
      [1, 10, 20, 30, 255, 1, 1, 1, 0], // Sub: second pixel = first + (1,1,1,0)
      [2, 1, 1, 1, 0, 2, 2, 2, 0], // Up
      [3, 0, 0, 0, 0, 0, 0, 0, 0], // Average
      [4, 5, 5, 5, 0, 1, 1, 1, 0], // Paeth
    ];
    const img = decodePng(png(2, 4, 6, rows));
    expect([...img.data.subarray(0, 8)]).toEqual([10, 20, 30, 255, 11, 21, 31, 255]);
    expect([...img.data.subarray(8, 16)]).toEqual([11, 21, 31, 255, 13, 23, 33, 255]);
    expect(img.data.length).toBe(2 * 4 * 4);
  });

  it('decodes 8-bit RGB (colour type 2) as opaque RGBA', () => {
    const img = decodePng(png(1, 1, 2, [[0, 9, 8, 7]]));
    expect([...img.data]).toEqual([9, 8, 7, 255]);
  });

  it('rejects interlaced, wrong-signature and unsupported-depth files', () => {
    expect(() => decodePng(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toThrow(/PNG/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/conformance/png.test.ts`
Expected: FAIL — cannot resolve `./png`.

- [ ] **Step 3: Write `test/conformance/png.ts`**

```ts
import { inflateSync } from 'node:zlib';

export interface DecodedPng {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  data: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Minimal PNG decoder: 8-bit, non-interlaced, colour types 2 (RGB), 3 (palette) and 6 (RGBA). */
export function decodePng(bytes: Uint8Array): DecodedPng {
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) {
    throw new Error('not a PNG file (bad signature)');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  let palette: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (pos + 8 <= bytes.length) {
    const length = view.getUint32(pos);
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    const body = bytes.subarray(pos + 8, pos + 8 + length);
    pos += 12 + length;
    if (type === 'IHDR') {
      const header = new DataView(body.buffer, body.byteOffset, body.byteLength);
      width = header.getUint32(0);
      height = header.getUint32(4);
      const depth = body[8]!;
      colorType = body[9]!;
      if (depth !== 8) throw new Error(`unsupported PNG bit depth ${depth}`);
      if (body[12] !== 0) throw new Error('interlaced PNG is not supported');
    } else if (type === 'PLTE') {
      palette = Uint8Array.from(body);
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 3 ? 1 : 0;
  if (channels === 0) throw new Error(`unsupported PNG colour type ${colorType}`);

  const compressed = Uint8Array.from(idat.flatMap((c) => [...c]));
  const raw = inflateSync(compressed);
  const stride = width * channels;
  const pixels = new Uint8Array(stride * height);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = Uint8Array.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels]! : 0;
      const b = prev[i]!;
      const c = i >= channels ? prev[i - channels]! : 0;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = (line[i]! + add) & 0xff;
    }
    pixels.set(line, y * stride);
    prev = line;
  }

  const data = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    if (colorType === 6) {
      data.set(pixels.subarray(p * 4, p * 4 + 4), p * 4);
    } else if (colorType === 2) {
      data.set(pixels.subarray(p * 3, p * 3 + 3), p * 4);
      data[p * 4 + 3] = 255;
    } else {
      const index = pixels[p]!;
      if (!palette) throw new Error('palette PNG without PLTE');
      data[p * 4] = palette[index * 3]!;
      data[p * 4 + 1] = palette[index * 3 + 1]!;
      data[p * 4 + 2] = palette[index * 3 + 2]!;
      data[p * 4 + 3] = 255;
    }
  }
  return { width, height, data };
}
```

- [ ] **Step 4: Run to verify the decoder passes**

Run: `npx vitest run test/conformance/png.test.ts && npm run typecheck && npm run lint`
Expected: PASS, clean.

- [ ] **Step 5: Add the `vicetests` source to `scripts/fetch-test-data.mjs`**

1. Import: `import { execSync } from 'node:child_process';`.
2. Add a helper and the source (the file list is resolved at pin time and stored in the manifest, so verify mode needs no network listing):
```js
function githubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execSync('gh auth token', { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

async function apiJson(url) {
  const token = githubToken();
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'f6502-fetch-test-data',
      Accept: 'application/vnd.github+json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

/** PAL VIC-II tests that ship a reference screenshot: <dir>/<name>.prg + <dir>/references/<name>.prg.png */
async function listViceTests(repo, sha) {
  const dirs = (await apiJson(`https://api.github.com/repos/${repo}/contents/VICII?ref=${sha}`)) ?? [];
  const files = [];
  for (const dir of dirs.filter((d) => d.type === 'dir')) {
    const refs = await apiJson(
      `https://api.github.com/repos/${repo}/contents/VICII/${dir.name}/references?ref=${sha}`,
    );
    if (!refs) continue;
    for (const ref of refs) {
      if (!ref.name.endsWith('.prg.png') || /ntsc/i.test(ref.name)) continue;
      files.push(`VICII/${dir.name}/references/${ref.name}`);
      files.push(`VICII/${dir.name}/${ref.name.slice(0, -'.png'.length)}`);
    }
  }
  return files.sort();
}
```
3. In `SOURCES` add:
```js
  vicetests: { repo: 'libsidplayfp/VICE-testprogs', dest: 'vicetests', list: listViceTests },
```
4. In `fetchSource(source, sha, expected)` choose the file list as
```js
  const files = expected
    ? Object.keys(expected)
    : source.list
      ? await source.list(source.repo, sha)
      : source.files;
```
and use `files` instead of `source.files` in the `pool(...)` call and in the `source.files` references inside `fetchSource`.

- [ ] **Step 6: Pin and fetch**

Run: `node scripts/fetch-test-data.mjs --pin vicetests && node scripts/fetch-test-data.mjs vicetests | tail -2 && du -sh .testdata/vicetests && ls .testdata/vicetests/VICII | head -30`
Expected: a pinned SHA, a file list of PAL PRG/reference pairs, checksums verified on the second run. Record the licence note (VICE testprogs are distributed with VICE, GPL-2.0-or-later; not vendored) and the total size in `docs/test-data-notes.md`.

- [ ] **Step 7: Write the harness (`test/conformance/vice.test.ts`) with an empty manifest**

`test/conformance/vice-tests.json`: `[]`.

`test/conformance/vice.test.ts`:
```ts
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { C64 } from '../../src/machine/c64';
import { decodePng } from './png';

interface Entry {
  name: string;
  prg: string; // relative to .testdata/vicetests
  reference: string;
  frames?: number;
  /** Number of differing pixels tolerated (default 0). */
  tolerance?: number;
  /** 'pass' or 'known-fail:<reason>' */
  expect: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '.testdata');
const ROMS = join(ROOT, 'openroms', 'bin');
const VICE = join(ROOT, 'vicetests');
const manifest = JSON.parse(readFileSync(join(HERE, 'vice-tests.json'), 'utf8')) as Entry[];
const REPORT = process.env.VICE_REPORT === '1';

function roms() {
  const read = (name: string) => {
    const file = join(ROMS, name);
    if (!existsSync(file)) throw new Error(`${file} missing: run "npm run fetch-test-data"`);
    return new Uint8Array(readFileSync(file));
  };
  return {
    kernal: read('kernal_generic.rom'),
    basic: read('basic_generic.rom'),
    chargen: read('chargen_openroms.rom'),
  };
}

/** Number of differing pixels between our frame and the reference (RGB must match exactly). */
function diff(c64: C64, referencePath: string): number {
  const ref = decodePng(new Uint8Array(readFileSync(referencePath)));
  if (ref.width !== 384 || ref.height !== 272) {
    throw new Error(`reference ${referencePath} is ${ref.width}x${ref.height}, expected 384x272`);
  }
  const pixels = c64.frame.pixels;
  let different = 0;
  for (let i = 0; i < 384 * 272; i++) {
    const v = pixels[i]!;
    const r = v & 0xff;
    const g = (v >> 8) & 0xff;
    const b = (v >> 16) & 0xff;
    if (r !== ref.data[i * 4] || g !== ref.data[i * 4 + 1] || b !== ref.data[i * 4 + 2]) {
      different++;
    }
  }
  return different;
}

describe('VICE VIC-II reference screenshots', () => {
  it('has a manifest', () => {
    expect(Array.isArray(manifest)).toBe(true);
  });

  for (const entry of manifest) {
    it(`${entry.name} (${entry.expect})`, () => {
      const prg = join(VICE, entry.prg);
      const reference = join(VICE, entry.reference);
      if (!existsSync(prg) || !existsSync(reference)) {
        throw new Error(`${entry.name}: files missing, run "npm run fetch-test-data"`);
      }
      const c64 = new C64(roms());
      expect(c64.runUntilReady(600)).toBe(true);
      c64.loadPrg(new Uint8Array(readFileSync(prg)));
      for (let i = 0; i < (entry.frames ?? 200); i++) c64.runFrame();
      const mismatches = diff(c64, reference);
      if (REPORT) console.log(`VICE ${entry.name}: ${mismatches} differing pixels`);
      const tolerance = entry.tolerance ?? 0;
      if (entry.expect === 'pass') {
        expect(mismatches, `${entry.name}: differing pixels`).toBeLessThanOrEqual(tolerance);
      } else {
        expect(entry.expect.startsWith('known-fail:'), 'expect must be pass or known-fail:<reason>').toBe(true);
        expect(
          mismatches,
          `${entry.name} is marked known-fail but now matches: remove the known-fail`,
        ).toBeGreaterThan(tolerance);
      }
    });
  }
});
```

- [ ] **Step 8: Run**

Run: `npm run test:conformance && npm run typecheck && npm run lint`
Expected: PASS (empty manifest: only the "has a manifest" test runs).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "test(conformance): PNG decoder, pinned VICE VIC-II tests and the reference comparison harness" -m "Refs #<issue for task 5>" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01QAsVffzaJc51Ncx7uyv5AK"
```

---

### Task 6: Curate the manifest, run the references, fix what they reveal

**Files:**
- Create: `scripts/gen-vice-manifest.mjs`
- Modify: `test/conformance/vice-tests.json`, `src/machine/*` as the references demand
- Create: unit tests for every defect found

**Interfaces:**
- Produces: a manifest with at least 10 entries expecting `pass`, every other candidate either passing or `known-fail:<reason>` with a tracking issue.

- [ ] **Step 1: Generate the candidate list**

`scripts/gen-vice-manifest.mjs`:
```js
// Lists every fetched PAL test that has a reference screenshot and writes a candidate manifest
// (expect: "pass") to test/conformance/vice-tests.json for classification.
import { readdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VICE = join(ROOT, '.testdata', 'vicetests');
const entries = [];
for (const dir of readdirSync(join(VICE, 'VICII'), { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const refs = join(VICE, 'VICII', dir.name, 'references');
  if (!existsSync(refs)) continue;
  for (const ref of readdirSync(refs).filter((f) => f.endsWith('.prg.png'))) {
    const prg = ref.slice(0, -'.png'.length);
    if (!existsSync(join(VICE, 'VICII', dir.name, prg))) continue;
    entries.push({
      name: `${dir.name}/${prg}`,
      prg: `VICII/${dir.name}/${prg}`,
      reference: `VICII/${dir.name}/references/${ref}`,
      expect: 'pass',
    });
  }
}
writeFileSync(
  join(ROOT, 'test', 'conformance', 'vice-tests.json'),
  JSON.stringify(entries, null, 2) + '\n',
);
console.log(`wrote ${entries.length} candidates`);
```

Run: `node scripts/gen-vice-manifest.mjs`

- [ ] **Step 2: Classify in report mode**

Run: `VICE_REPORT=1 npx vitest run test/conformance/vice.test.ts 2>&1 | grep -E "^VICE|Tests |FAIL" | sort | head -80`
Record, per test, the number of differing pixels. For the first pass use `expect: 'pass'` everywhere; failures are the work list.

- [ ] **Step 3: Triage loop (time-boxed)**

For each failing test, in order of fewest differing pixels:
1. Read its `readme.txt` / source in `.testdata/vicetests/VICII/<dir>/` and view our frame next to the reference (write both to PNG under `/tmp/claude-1000/` with a throwaway script).
2. Decide the cause: a mis-modelled VIC rule (fix in `src/machine/`, add a unit test that fails first), an OpenROMs-vs-original-KERNAL difference or a start-up assumption (record as `known-fail:<reason>`), or a harness issue (frames to run, start address: fix the manifest entry or the harness).
3. After a fix, re-run the whole manifest: a fix must not regress passing entries.
4. Time-box each test to a bounded effort; anything unresolved becomes `known-fail:<reason>` and is listed in a tracking issue.

- [ ] **Step 4: Finalise the manifest**

Edit `vice-tests.json`: entries that pass keep `pass`; the rest become `known-fail:<reason>`; remove entries that cannot work for a harness reason (e.g. require disk or a non-PRG start). Ensure at least **10** entries expect `pass`.

Run: `npm run test:conformance && npm test && npm run typecheck && npm run lint`
Expected: PASS (known-fails are expected to differ and are asserted to differ).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test(conformance): curated VICE VIC-II reference set and the timing fixes it revealed" -m "Refs #<issue for task 6>" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01QAsVffzaJc51Ncx7uyv5AK"
```

---

### Task 7: Browser acceptance, throughput, README and final verification

**Files:**
- Modify: `README.md`
- Create: `docs/screenshots/sp4-vice-reference.png`

- [ ] **Step 1: Throughput with 8 sprites on the stalled machine**

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
const t=performance.now(); for(let i=0;i<500;i++) c.runFrame(); const s=(performance.now()-t)/1000;
console.log('graphics-test.prg, 500 frames in',s.toFixed(2),'s =',(500/50.1245/s).toFixed(0),'x real time');"
```
Expected: at least 10x real time (reported, not a gate). If below, profile `tick()`/`outputCycle` (the per-cycle schedule work) before shipping.

- [ ] **Step 2: Real-browser acceptance**

1. Start the server in the background (`PORT=8770 node scripts/serve.mjs &`; anchor any `pgrep`/`pkill` pattern with `^node scripts/serve.mjs`).
2. With the Playwright tools open `http://127.0.0.1:8770/examples/basic.html?prg=../.testdata/vicetests/<a passing test PRG>` and screenshot the `#screen` canvas to `.playwright-mcp/sp4-vice-reference.png`.
3. Compare visually with the test's reference PNG (same directory, `references/`); copy the screenshot to `docs/screenshots/sp4-vice-reference.png`.
4. Re-check typing in the same page (type `PRINT "OK"`), then stop the server.

- [ ] **Step 3: Update `README.md`**

Replace the status paragraph with:
```markdown
Status: the cycle-accurate 6502 core, the C64 machine and a cycle-exact PAL VIC-II (badline and
sprite-DMA CPU stalls, border opening, sprite crunch) with all graphics modes and sprites, plus
the browser layer, are implemented and checked against VICE reference screenshots. Sound,
disk/tape media and the demo site are planned (see `docs/superpowers/specs/`).
```

- [ ] **Step 4: Final verification (report real output)**

```bash
npx prettier --write README.md docs scripts examples test >/dev/null
bash -c 'for c in "npm run -s lint" "npm run -s typecheck" "npm test" "npm run -s test:conformance" "npm run -s build"; do echo "=== $c"; out=$($c 2>&1); code=$?; echo "$out" | grep -E "Tests |Test Files|rror|Prettier|success|FAIL" | head -6; echo "exit: $code"; done'
```
Expected: every command exits 0.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: cycle-exact VIC-II verified against VICE references and in the browser" -m "Refs #<issue for task 7>. Gates: lint, typecheck, unit, conformance (incl. VICE references), build; throughput measured; real-browser screenshot committed." -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01QAsVffzaJc51Ncx7uyv5AK"
```

---

## Spec coverage check

| Spec requirement | Task |
|---|---|
| `CpuHooks.rdy`, stall semantics, guard, existing suites unmodified | 1 |
| Access schedule table, BA (badline + sprite windows, wrap, merge) | 2 |
| Per-cycle badline condition, DEN at line `$30`, c-access leading g-access, DMA delay | 2 |
| Write latency (one cycle), raster IRQ/frame-wrap timing | 2 (cycle model) |
| Border flip-flops, side and top/bottom opening, static windows unchanged | 3 |
| Foreground independent of the border (supersedes sub-project 3 text) | 3 |
| Sprite crunch, 6-bit MCBASE and power-on anomaly, persistent shifters | 4 |
| ECM address mask for invalid modes | 4 |
| PNG harness, pinned `vicetests` source, manifest with known-fail rules | 5, 6 |
| At least 10 reference tests passing, known-fails tracked | 6 |
| OpenROMs boot/typing/graphics conformance on the stalled machine | 2, 3, 4 (suite runs every task) |
| Throughput guard, browser acceptance, README | 7 |

Items consciously not covered: CIA corner cases (only if a selected reference needs them; handled in Task 6 triage with a unit test per fix), NTSC, 6567/8565, light pen, DRAM refresh.
