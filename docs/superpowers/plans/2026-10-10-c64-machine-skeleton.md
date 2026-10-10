# f6502 C64 Machine Skeleton and Browser Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A C64 machine (`src/machine/`) and a browser layer (`src/browser/`) on top of the finished 6502 core, so a page can include the library, attach it to a canvas, reach the BASIC `READY.` prompt, type, and run a `.prg` loaded from a URL.

**Architecture:** `C64` owns the core `MOS6502` and ticks CIA1, CIA2 and a simple per-cycle VIC-II from the CPU's `onCycle` hook; `C64Bus` decodes addresses through a 256-entry page table rebuilt when the 6510 port changes. The browser layer is a thin `Player` (rAF loop, canvas, keyboard mapping, fetch) over the headless machine.

**Tech Stack:** TypeScript (strict), tsup, Vitest, ESLint, Prettier, Node LTS, npm. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-10-c64-machine-skeleton-design.md`

## Global Constraints

- TypeScript strict, ESM source, **no runtime dependencies**. `src/core/` and `src/machine/` use no DOM types (`lib: ["ES2022"]`); only `src/browser/` and `src/index.ts` may.
- Dependencies point one way: `browser` -> `machine` -> `core`. ESLint forbids `core/` importing `machine/` or `browser/`, and `machine/` importing `browser/`.
- PAL only: 985,248 Hz, 63 cycles/line, 312 lines, **19,656 cycles/frame**.
- Framebuffer `384 x 272`, `Uint32Array`, RGBA (little-endian `0xAABBGGRR`), Pepto palette.
- ROM images must be exactly **8192** (kernal), **8192** (basic), **4096** (chargen) bytes, else `RomError` naming image, expected and actual size.
- ROMs are never bundled; test ROMs are fetched from a pinned commit into git-ignored `.testdata/`.
- Bundles: `dist/index.js` (ESM) and `dist/f6502.min.js` (IIFE, global `F6502`) export `C64` and `start`.
- Out of scope: sound/SID (stub only), joystick, bitmap/multicolour/ECM/sprites, badline CPU stalls, disk/tape/IEC, cartridges, NTSC, GitHub Actions CI, the Pages site.
- Every commit message ends with the trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Report verification with real command output; never claim a suite passes without running it.

## Review Focus

Input classes the spec implies but that are easy to get wrong. Each has a test in the owning task:

1. **Writes under ROM and to `$00/$01`**: a write to `$A000`/`$E000`/chargen space lands in RAM, and a CPU write to `$00/$01` never changes the RAM underneath; DDR=0 power-on banking reads as all-ones (Task 2).
2. **CIA edge cases**: timer with latch 0 and a one-shot stop; an ICR read clears flags **and** the IRQ line; a masked flag does not raise IRQ (Task 3).
3. **Shift handling on key release**: releasing a symbol key that forced shift on or off restores the physical Shift state; two held keys; blur releases everything (Task 8).
4. **PRG edge cases**: 2-byte file, load address `$FFFF` with data (overflow), BASIC program that ends above `$9FFF` (Task 6).
5. **Typing and timeouts**: more than 10 characters (queue chunking against the 10-byte buffer), and `runUntilReady` timing out without hanging (Tasks 5 and 9).
6. **Frame clock after a hidden tab**: a huge elapsed time must be clamped, never run hundreds of frames (Task 9).

---

## File Structure

```
tsconfig.json              no-DOM project: core, machine, test, configs
tsconfig.browser.json      DOM project: browser, index, browser tests; used by tsup
src/machine/memory.ts      RomSet, RomError, validateRoms, powerOnRam
src/machine/cpu-port.ts    CpuPort ($00/$01)
src/machine/io.ts          IoChip interface
src/machine/bus.ts         C64Bus
src/machine/cia.ts         Cia (6526)
src/machine/keyboard.ts    C64Key, Keyboard matrix
src/machine/palette.ts     PALETTE
src/machine/vic.ts         VicII
src/machine/prg.ts         PrgError, parsePrg
src/machine/c64.ts         C64
src/machine/index.ts
src/browser/keymap.ts      KeyMapper
src/browser/loader.ts      Source, LoadError, toBytes
src/browser/clock.ts       FrameClock
src/browser/player.ts      Player, start, ReadyTimeoutError
src/browser/index.ts
examples/basic.html        development demo page
scripts/serve.mjs          static file server
test/machine/*.test.ts, test/browser/*.test.ts, test/conformance/c64.test.ts
```

---

### Task 1: Project structure, DOM/no-DOM typecheck split, boundary rule

**Files:**
- Modify: `tsconfig.json`, `tsup.config.ts`, `eslint.config.js`, `package.json`, `src/index.ts`
- Create: `tsconfig.browser.json`, `src/machine/index.ts`, `src/browser/index.ts`, `test/machine/.gitkeep`, `test/browser/.gitkeep`

**Interfaces:**
- Produces: the `machine/` and `browser/` directories with empty `index.ts` barrels; `npm run typecheck` runs both projects.

- [ ] **Step 1: Write `tsconfig.json`** (no DOM; browser sources excluded)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "ignoreDeprecations": "6.0"
  },
  "include": ["src/core", "src/machine", "test/core", "test/machine", "test/conformance", "tsup.config.ts", "vitest.config.ts"]
}
```

`tsconfig.browser.json`:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "lib": ["ES2022", "DOM"] },
  "include": ["src", "test/browser"]
}
```

- [ ] **Step 2: Point tsup at the DOM project** — in `tsup.config.ts` add `tsconfig: 'tsconfig.browser.json',` to **both** config objects.

- [ ] **Step 3: Update scripts in `package.json`**

```json
"test": "vitest run test/core test/machine test/browser",
"typecheck": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.browser.json",
"example": "node scripts/serve.mjs"
```

- [ ] **Step 4: Extend the ESLint boundary rule** — in `eslint.config.js` add a second block after the `src/core/**` block:

```js
  {
    files: ['src/machine/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/browser', '**/browser/*'],
              message: 'machine/ must not import from browser/',
            },
          ],
        },
      ],
    },
  },
```

- [ ] **Step 5: Create the barrels**

`src/machine/index.ts`: `export {};`
`src/browser/index.ts`: `export {};`
`src/index.ts`:
```ts
export * from './core';
export * from './machine';
export * from './browser';
```

- [ ] **Step 6: Verify**

Run: `npm run typecheck && npm run lint && npm test && npm run build`
Expected: all clean; 84 unit tests still pass.

Boundary rule check (then delete the probe):
```bash
printf "import '../browser/x';\n" > src/machine/_probe.ts && npx eslint src/machine/_probe.ts; rm src/machine/_probe.ts
```
Expected: ESLint reports `machine/ must not import from browser/`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: add machine/ and browser/ layers with DOM-free typecheck split and boundary rule" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Memory, 6510 port and bus (PLA banking)

**Files:**
- Create: `src/machine/memory.ts`, `src/machine/cpu-port.ts`, `src/machine/io.ts`, `src/machine/bus.ts`
- Test: `test/machine/helpers.ts`, `test/machine/bus.test.ts`

**Interfaces:**
- Produces:
  - `RomSet { kernal; basic; chargen: Uint8Array }`, `class RomError extends Error`, `validateRoms(roms)`, `powerOnRam(ram)`.
  - `interface IoChip { read(reg): number; write(reg, value): void; peek(reg): number }`.
  - `class CpuPort { constructor(onBankingChange: () => void); readonly ddr; readonly data; bankBits: number (0..7); readData(): number; write(addr: 0|1, value): void; reset(): void }`.
  - `class C64Bus implements Bus { constructor(roms: RomSet, chips: { vic: IoChip; cia1: IoChip; cia2: IoChip }, port: CpuPort); readonly ram: Uint8Array; readonly colorRam: Uint8Array; vicBank: number; rebuild(): void; powerOn(): void; peek(addr): number; vicRead(addr14): number }`.

- [ ] **Step 1: Write the test helpers**

`test/machine/helpers.ts`:
```ts
import type { RomSet } from '../../src/machine/memory';

export function filled(size: number, value: number): Uint8Array {
  return new Uint8Array(size).fill(value);
}

/** ROMs whose bytes identify the image: kernal 0x4B, basic 0xBA, chargen 0xCC. */
export function markerRoms(): RomSet {
  return { kernal: filled(8192, 0x4b), basic: filled(8192, 0xba), chargen: filled(4096, 0xcc) };
}

export function stubChip(value: number) {
  const writes: Array<[number, number]> = [];
  return {
    writes,
    read: (): number => value,
    peek: (): number => value,
    write: (reg: number, v: number): void => {
      writes.push([reg, v]);
    },
  };
}
```

- [ ] **Step 2: Write the failing tests**

`test/machine/bus.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { C64Bus } from '../../src/machine/bus';
import { CpuPort } from '../../src/machine/cpu-port';
import { RomError, validateRoms } from '../../src/machine/memory';
import { filled, markerRoms, stubChip } from './helpers';

function makeBus() {
  const vic = stubChip(0x77);
  const cia1 = stubChip(0x11);
  const cia2 = stubChip(0x22);
  let bus!: C64Bus;
  const port = new CpuPort(() => bus.rebuild());
  bus = new C64Bus(markerRoms(), { vic, cia1, cia2 }, port);
  return { bus, port, vic, cia1, cia2 };
}

function setBanking(bus: C64Bus, bits: number) {
  bus.write(0x00, 0x07); // DDR: bits 0-2 are outputs
  bus.write(0x01, bits);
}

describe('ROM validation', () => {
  it('rejects wrong sizes naming image, expected and actual', () => {
    const roms = markerRoms();
    expect(() => validateRoms({ ...roms, basic: filled(100, 0) })).toThrow(RomError);
    expect(() => validateRoms({ ...roms, basic: filled(100, 0) })).toThrow(/basic.*8192.*100/);
  });
});

describe('PLA banking', () => {
  // [CHAREN HIRAM LORAM] -> expected byte at $A000, $D000, $E000
  const RAM = 0x11;
  const BASIC = 0xba;
  const KERNAL = 0x4b;
  const CHARGEN = 0xcc;
  const IO = 0x77; // VIC stub
  const cases: Array<[number, number, number, number]> = [
    [0b000, RAM, RAM, RAM],
    [0b001, RAM, RAM, RAM],
    [0b010, RAM, CHARGEN, KERNAL],
    [0b011, BASIC, CHARGEN, KERNAL],
    [0b100, RAM, RAM, RAM],
    [0b101, RAM, IO, RAM],
    [0b110, RAM, IO, KERNAL],
    [0b111, BASIC, IO, KERNAL],
  ];
  it.each(cases)('port bits %i maps $A000/$D000/$E000', (bits, a000, d000, e000) => {
    const { bus } = makeBus();
    bus.ram[0xa000] = RAM;
    bus.ram[0xd000] = RAM;
    bus.ram[0xe000] = RAM;
    setBanking(bus, bits);
    expect(bus.read(0xa000)).toBe(a000);
    expect(bus.read(0xd000)).toBe(d000);
    expect(bus.read(0xe000)).toBe(e000);
  });

  it('power-on (DDR=0) reads as all-ones banking: BASIC, I/O, KERNAL visible', () => {
    const { bus } = makeBus();
    expect(bus.read(0xa000)).toBe(0xba);
    expect(bus.read(0xd000)).toBe(0x77);
    expect(bus.read(0xe000)).toBe(0x4b);
  });

  it('writes under ROM land in RAM', () => {
    const { bus } = makeBus();
    bus.write(0xa000, 0x5a);
    bus.write(0xe000, 0x5b);
    expect(bus.ram[0xa000]).toBe(0x5a);
    expect(bus.ram[0xe000]).toBe(0x5b);
    expect(bus.read(0xa000)).toBe(0xba); // ROM still visible
    setBanking(bus, 0b000); // all RAM
    expect(bus.read(0xa000)).toBe(0x5a);
  });

  it('writes to chargen-shadowed $D000 go to RAM', () => {
    const { bus } = makeBus();
    setBanking(bus, 0b011); // CHAREN=0: chargen visible
    bus.write(0xd123, 0x99);
    expect(bus.ram[0xd123]).toBe(0x99);
    expect(bus.read(0xd123)).toBe(0xcc);
  });
});

describe('6510 port', () => {
  it('CPU writes to $00/$01 do not touch the RAM underneath', () => {
    const { bus } = makeBus();
    bus.ram[0] = 0xaa;
    bus.ram[1] = 0xbb;
    bus.write(0x00, 0x2f);
    bus.write(0x01, 0x37);
    expect(bus.ram[0]).toBe(0xaa);
    expect(bus.ram[1]).toBe(0xbb);
    expect(bus.read(0x00)).toBe(0x2f);
  });

  it('reads back output bits from data and input bits as 1 (bit 4 sense = 1, bits 6-7 = 0)', () => {
    const { bus } = makeBus();
    bus.write(0x00, 0x2f); // bits 0-3,5 outputs; bit 4 input
    bus.write(0x01, 0x00);
    expect(bus.read(0x01)).toBe(0x10); // only the input bit 4 reads 1
  });
});

describe('I/O window', () => {
  it('mirrors VIC every 64 bytes and CIAs every 16 bytes', () => {
    const { bus, vic, cia1, cia2 } = makeBus();
    bus.write(0xd040 + 0x11, 0x1b);
    expect(vic.writes.at(-1)).toEqual([0x11, 0x1b]);
    bus.write(0xdc00 + 0x1e, 0x01);
    expect(cia1.writes.at(-1)).toEqual([0x0e, 0x01]);
    bus.write(0xdd00 + 0x12, 0x03);
    expect(cia2.writes.at(-1)).toEqual([0x02, 0x03]);
  });

  it('SID is a stub (reads $FF), colour RAM upper nibble reads 1s, expansion reads $FF', () => {
    const { bus } = makeBus();
    expect(bus.read(0xd418)).toBe(0xff);
    bus.write(0xd800, 0x05);
    expect(bus.read(0xd800)).toBe(0xf5);
    expect(bus.read(0xde00)).toBe(0xff);
  });
});

describe('VIC memory view', () => {
  it('shows character ROM at $1000-$1FFF in banks 0 and 2 only', () => {
    const { bus } = makeBus();
    bus.ram[0x1000] = 0x11;
    bus.ram[0x5000] = 0x22; // bank 1, offset $1000
    for (const bank of [0, 2]) {
      bus.vicBank = bank;
      expect(bus.vicRead(0x1000)).toBe(0xcc);
    }
    bus.vicBank = 1;
    expect(bus.vicRead(0x1000)).toBe(0x22);
    bus.vicBank = 0;
    expect(bus.vicRead(0x0fff)).toBe(bus.ram[0x0fff]);
  });
});

describe('peek', () => {
  it('returns the CPU-visible byte without side effects', () => {
    const { bus, vic } = makeBus();
    expect(bus.peek(0xd011)).toBe(0x77);
    expect(vic.writes).toHaveLength(0);
    expect(bus.peek(0xa000)).toBe(0xba);
  });
});

describe('power-on RAM', () => {
  it('uses alternating 64-byte blocks of $00 and $FF', () => {
    const { bus } = makeBus();
    bus.powerOn();
    expect(bus.ram[0x0000]).toBe(0x00);
    expect(bus.ram[0x003f]).toBe(0x00);
    expect(bus.ram[0x0040]).toBe(0xff);
    expect(bus.ram[0x007f]).toBe(0xff);
    expect(bus.ram[0x0080]).toBe(0x00);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/machine/bus.test.ts`
Expected: FAIL — cannot resolve `../../src/machine/bus`.

- [ ] **Step 4: Write the implementation**

`src/machine/memory.ts`:
```ts
export interface RomSet {
  kernal: Uint8Array;
  basic: Uint8Array;
  chargen: Uint8Array;
}

export class RomError extends Error {
  constructor(image: string, expected: number, actual: number) {
    super(`${image} ROM must be ${expected} bytes, got ${actual}`);
    this.name = 'RomError';
  }
}

export function validateRoms(roms: RomSet): void {
  const sizes: Array<[keyof RomSet, number]> = [
    ['kernal', 8192],
    ['basic', 8192],
    ['chargen', 4096],
  ];
  for (const [name, expected] of sizes) {
    if (roms[name].length !== expected) throw new RomError(name, expected, roms[name].length);
  }
}

/** Standard C64 power-on pattern: alternating 64-byte blocks of $00 and $FF. */
export function powerOnRam(ram: Uint8Array): void {
  for (let i = 0; i < ram.length; i++) ram[i] = i & 0x40 ? 0xff : 0x00;
}
```

`src/machine/io.ts`:
```ts
/** A memory-mapped chip. `peek` must have no side effects. */
export interface IoChip {
  read(reg: number): number;
  write(reg: number, value: number): void;
  peek(reg: number): number;
}
```

`src/machine/cpu-port.ts`:
```ts
/** The 6510's on-chip I/O port at $00 (DDR) and $01 (data). */
export class CpuPort {
  ddr = 0x00;
  data = 0x3f;

  constructor(private readonly onBankingChange: () => void) {}

  /** Effective LORAM/HIRAM/CHAREN: input bits are pulled up. */
  get bankBits(): number {
    return (this.data | ~this.ddr) & 0x07;
  }

  /** Output bits from the data register, input bits from the pins (bit 4 sense = 1, bits 6-7 = 0). */
  readData(): number {
    const pins = 0x3f;
    return ((this.data & this.ddr) | (pins & ~this.ddr)) & 0xff;
  }

  write(addr: 0 | 1, value: number): void {
    if (addr === 0) this.ddr = value & 0xff;
    else this.data = value & 0xff;
    this.onBankingChange();
  }

  reset(): void {
    this.ddr = 0x00;
    this.data = 0x3f;
    this.onBankingChange();
  }
}
```

`src/machine/bus.ts`:
```ts
import type { Bus } from '../core';
import type { CpuPort } from './cpu-port';
import type { IoChip } from './io';
import { powerOnRam, validateRoms, type RomSet } from './memory';

const RAM = 0;
const BASIC = 1;
const KERNAL = 2;
const CHARGEN = 3;
const IO = 4;

export interface BusChips {
  vic: IoChip;
  cia1: IoChip;
  cia2: IoChip;
}

export class C64Bus implements Bus {
  readonly ram = new Uint8Array(0x10000);
  readonly colorRam = new Uint8Array(0x400);
  /** VIC bank 0-3, set by the machine from CIA2 port A. */
  vicBank = 0;
  private readonly kind = new Uint8Array(256);

  constructor(
    private readonly roms: RomSet,
    private readonly chips: BusChips,
    private readonly port: CpuPort,
  ) {
    validateRoms(roms);
    this.rebuild();
  }

  powerOn(): void {
    powerOnRam(this.ram);
  }

  rebuild(): void {
    const bits = this.port.bankBits;
    const loram = bits & 1;
    const hiram = (bits >> 1) & 1;
    const charen = (bits >> 2) & 1;
    this.kind.fill(RAM);
    if (hiram && loram) this.kind.fill(BASIC, 0xa0, 0xc0);
    if (hiram) this.kind.fill(KERNAL, 0xe0, 0x100);
    let d000 = CHARGEN;
    if (!hiram && !loram) d000 = RAM;
    else if (!hiram && !charen) d000 = RAM;
    else if (charen) d000 = IO;
    this.kind.fill(d000, 0xd0, 0xe0);
  }

  read(addr: number): number {
    addr &= 0xffff;
    if (addr < 2) return addr === 0 ? this.port.ddr : this.port.readData();
    switch (this.kind[addr >> 8]) {
      case RAM:
        return this.ram[addr]!;
      case BASIC:
        return this.roms.basic[addr & 0x1fff]!;
      case KERNAL:
        return this.roms.kernal[addr & 0x1fff]!;
      case CHARGEN:
        return this.roms.chargen[addr & 0x0fff]!;
      default:
        return this.readIo(addr, false);
    }
  }

  write(addr: number, value: number): void {
    addr &= 0xffff;
    value &= 0xff;
    if (addr < 2) {
      this.port.write(addr as 0 | 1, value);
      return;
    }
    if (this.kind[addr >> 8] === IO) this.writeIo(addr, value);
    else this.ram[addr] = value;
  }

  /** CPU-visible byte with no side effects. */
  peek(addr: number): number {
    addr &= 0xffff;
    if (addr < 2) return addr === 0 ? this.port.ddr : this.port.readData();
    switch (this.kind[addr >> 8]) {
      case RAM:
        return this.ram[addr]!;
      case BASIC:
        return this.roms.basic[addr & 0x1fff]!;
      case KERNAL:
        return this.roms.kernal[addr & 0x1fff]!;
      case CHARGEN:
        return this.roms.chargen[addr & 0x0fff]!;
      default:
        return this.readIo(addr, true);
    }
  }

  /** VIC-II memory fetch: 14-bit address within the current bank. */
  vicRead(addr14: number): number {
    const a = addr14 & 0x3fff;
    if ((this.vicBank === 0 || this.vicBank === 2) && a >= 0x1000 && a < 0x2000) {
      return this.roms.chargen[a & 0x0fff]!;
    }
    return this.ram[(this.vicBank << 14) | a]!;
  }

  private readIo(addr: number, peek: boolean): number {
    const page = addr >> 8;
    if (page < 0xd4) {
      const reg = addr & 0x3f;
      return peek ? this.chips.vic.peek(reg) : this.chips.vic.read(reg);
    }
    if (page < 0xd8) return 0xff; // SID stub
    if (page < 0xdc) return this.colorRam[addr & 0x3ff]! | 0xf0;
    if (page === 0xdc) {
      const reg = addr & 0x0f;
      return peek ? this.chips.cia1.peek(reg) : this.chips.cia1.read(reg);
    }
    if (page === 0xdd) {
      const reg = addr & 0x0f;
      return peek ? this.chips.cia2.peek(reg) : this.chips.cia2.read(reg);
    }
    return 0xff; // expansion I/O
  }

  private writeIo(addr: number, value: number): void {
    const page = addr >> 8;
    if (page < 0xd4) this.chips.vic.write(addr & 0x3f, value);
    else if (page < 0xd8) return; // SID stub
    else if (page < 0xdc) this.colorRam[addr & 0x3ff] = value & 0x0f;
    else if (page === 0xdc) this.chips.cia1.write(addr & 0x0f, value);
    else if (page === 0xdd) this.chips.cia2.write(addr & 0x0f, value);
  }
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run test/machine && npm run typecheck && npm run lint`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(machine): memory map, 6510 port and PLA-banked bus" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: CIA (MOS 6526)

**Files:**
- Create: `src/machine/cia.ts`
- Test: `test/machine/cia.test.ts`

**Interfaces:**
- Consumes: `IoChip` from `io.ts`.
- Produces: `class Cia implements IoChip { constructor(inputs: { inputA: () => number; inputB: () => number }); tick(): void; reset(): void; readonly irq: boolean; outputA(): number; outputB(): number }` where `outputA()/outputB()` return `(PR | ~DDR) & 0xFF` (the driven pin levels, inputs high).

- [ ] **Step 1: Write the failing tests**

`test/machine/cia.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { Cia } from '../../src/machine/cia';

function cia(inputA = 0xff, inputB = 0xff) {
  return new Cia({ inputA: () => inputA, inputB: () => inputB });
}
function ticks(c: Cia, n: number) {
  for (let i = 0; i < n; i++) c.tick();
}
function startTimerA(c: Cia, latch: number, cra = 0x01) {
  c.write(0x04, latch & 0xff);
  c.write(0x05, latch >> 8);
  c.write(0x0e, cra);
}

describe('Timer A', () => {
  it('underflows after latch+1 cycles of counting (plus the start delay) and reloads', () => {
    const c = cia();
    startTimerA(c, 3);
    ticks(c, 5);
    expect(c.read(0x0d)).toBe(0x00); // underflow happened this tick; flag visible next tick
    const d = cia();
    startTimerA(d, 3);
    ticks(d, 6);
    expect(d.read(0x0d)).toBe(0x01);
  });

  it('has period latch+1', () => {
    const c = cia();
    startTimerA(c, 3);
    ticks(c, 6);
    c.read(0x0d); // clear
    ticks(c, 4);
    expect(c.read(0x0d)).toBe(0x01);
  });

  it('one-shot stops after one underflow', () => {
    const c = cia();
    startTimerA(c, 3, 0x09);
    ticks(c, 6);
    expect(c.read(0x0d)).toBe(0x01);
    ticks(c, 50);
    expect(c.read(0x0d)).toBe(0x00);
    expect(c.read(0x0e) & 1).toBe(0); // start bit cleared
  });

  it('latch 0 underflows every cycle after the start delay', () => {
    const c = cia();
    startTimerA(c, 0);
    ticks(c, 3); // tick 1: start delay, tick 2: underflow, tick 3: flag visible
    expect(c.read(0x0d) & 1).toBe(1);
  });

  it('writing the high latch byte while stopped loads the counter', () => {
    const c = cia();
    c.write(0x04, 0x34);
    c.write(0x05, 0x12);
    expect(c.read(0x04)).toBe(0x34);
    expect(c.read(0x05)).toBe(0x12);
  });

  it('force-load copies the latch into the counter', () => {
    const c = cia();
    startTimerA(c, 100);
    ticks(c, 10);
    c.write(0x0e, 0x11); // start + force load
    expect(c.read(0x04)).toBe(100);
  });
});

describe('ICR and IRQ', () => {
  it('a masked flag does not raise IRQ; unmasking afterwards does', () => {
    const c = cia();
    startTimerA(c, 1);
    ticks(c, 10);
    expect(c.irq).toBe(false);
    c.write(0x0d, 0x81); // enable TA
    expect(c.irq).toBe(true);
  });

  it('reading ICR returns bit 7 with the flag, then clears flags and the IRQ line', () => {
    const c = cia();
    c.write(0x0d, 0x81);
    startTimerA(c, 1);
    ticks(c, 10);
    expect(c.irq).toBe(true);
    expect(c.read(0x0d)).toBe(0x81);
    expect(c.irq).toBe(false);
    expect(c.read(0x0d)).toBe(0x00);
  });

  it('writing ICR with bit 7 clear removes mask bits', () => {
    const c = cia();
    c.write(0x0d, 0x83);
    c.write(0x0d, 0x01);
    startTimerA(c, 1);
    ticks(c, 10);
    expect(c.irq).toBe(false);
  });
});

describe('Timer B', () => {
  it('counts Timer A underflows when CRB selects it (cascade)', () => {
    const c = cia();
    startTimerA(c, 1);
    c.write(0x06, 0x02);
    c.write(0x07, 0x00);
    c.write(0x0f, 0x41); // start, count TA underflows
    ticks(c, 40);
    expect(c.read(0x0d) & 0x03).toBe(0x03);
  });
});

describe('ports', () => {
  it('output bits drive the pin, input bits read the external value', () => {
    const c = cia(0b10101010, 0xff);
    c.write(0x02, 0x0f); // DDRA: low nibble outputs
    c.write(0x00, 0x05);
    expect(c.read(0x00)).toBe(0xa5); // external high nibble 0xA, driven low nibble 0x5
    expect(c.outputA()).toBe(0xf5); // inputs read high on the driven side
  });
});

describe('TOD', () => {
  it('advances one tenth every ~98,525 cycles', () => {
    const c = cia();
    ticks(c, 98_524);
    expect(c.read(0x08)).toBe(0x00);
    ticks(c, 1);
    expect(c.read(0x08)).toBe(0x01);
  });

  it('rolls BCD seconds/minutes/hours and flips AM/PM at 12; hour read latches', () => {
    const c = cia();
    c.write(0x0b, 0x11); // hour 11 AM (stops the clock)
    c.write(0x0a, 0x59);
    c.write(0x09, 0x59);
    c.write(0x08, 0x09); // tenths 9: restarts the clock
    ticks(c, 98_525);
    expect(c.read(0x0b)).toBe(0x92); // 12 PM, latched
    expect(c.read(0x0a)).toBe(0x00);
    expect(c.read(0x09)).toBe(0x00);
    expect(c.read(0x08)).toBe(0x00); // reading tenths unlatches
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/machine/cia.test.ts`
Expected: FAIL — cannot resolve `../../src/machine/cia`.

- [ ] **Step 3: Write `src/machine/cia.ts`**

```ts
import type { IoChip } from './io';

export interface CiaInputs {
  /** External pin levels for port A / B (bits that are inputs are taken from here). */
  inputA: () => number;
  inputB: () => number;
}

const TENTH_ACC = 985_248; // PAL cycles per second; +10 per cycle gives one tenth per 98,524.8

function incBcd(v: number): number {
  return (v & 0x0f) === 9 ? (v + 7) & 0xff : v + 1;
}

export class Cia implements IoChip {
  irq = false;

  private pra = 0;
  private prb = 0;
  private ddra = 0;
  private ddrb = 0;
  private ta = 0xffff;
  private tb = 0xffff;
  private taLatch = 0xffff;
  private tbLatch = 0xffff;
  private cra = 0;
  private crb = 0;
  private taDelay = 0;
  private tbDelay = 0;
  private flags = 0;
  private pendingFlags = 0;
  private mask = 0;
  private sdr = 0;

  private tod = [0, 0, 0, 0x01]; // tenths, sec, min, hour (BCD)
  private alarm = [0, 0, 0, 0];
  private todLatch = [0, 0, 0, 0];
  private todLatched = false;
  private todRunning = true;
  private todAcc = 0;

  constructor(private readonly inputs: CiaInputs) {}

  reset(): void {
    this.pra = this.prb = this.ddra = this.ddrb = 0;
    this.ta = this.tb = this.taLatch = this.tbLatch = 0xffff;
    this.cra = this.crb = 0;
    this.taDelay = this.tbDelay = 0;
    this.flags = this.pendingFlags = this.mask = 0;
    this.irq = false;
    this.sdr = 0;
    this.tod = [0, 0, 0, 0x01];
    this.alarm = [0, 0, 0, 0];
    this.todLatched = false;
    this.todRunning = true;
    this.todAcc = 0;
  }

  /** Driven pin levels: output bits from the port register, input bits high. */
  outputA(): number {
    return (this.pra | ~this.ddra) & 0xff;
  }

  outputB(): number {
    return (this.prb | ~this.ddrb) & 0xff;
  }

  tick(): void {
    if (this.pendingFlags !== 0) {
      this.flags |= this.pendingFlags;
      this.pendingFlags = 0;
      this.updateIrq();
    }

    let taUnderflow = false;
    if (this.cra & 0x01) {
      if (this.taDelay > 0) this.taDelay--;
      else if ((this.cra & 0x20) === 0) {
        if (this.ta === 0) {
          taUnderflow = true;
          this.ta = this.taLatch;
          if (this.cra & 0x08) this.cra &= ~0x01;
        } else this.ta--;
      }
    }
    if (taUnderflow) this.pendingFlags |= 0x01;

    if (this.crb & 0x01) {
      if (this.tbDelay > 0) this.tbDelay--;
      else {
        const mode = (this.crb >> 5) & 3;
        const clock = mode === 0 ? true : mode >= 2 ? taUnderflow : false;
        if (clock) {
          if (this.tb === 0) {
            this.pendingFlags |= 0x02;
            this.tb = this.tbLatch;
            if (this.crb & 0x08) this.crb &= ~0x01;
          } else this.tb--;
        }
      }
    }

    if (this.todRunning) {
      this.todAcc += 10;
      if (this.todAcc >= TENTH_ACC) {
        this.todAcc -= TENTH_ACC;
        this.todTenth();
      }
    }
  }

  read(reg: number): number {
    switch (reg & 0x0f) {
      case 0x0d: {
        const value = this.flags | (this.irq ? 0x80 : 0);
        this.flags = 0;
        this.updateIrq();
        return value;
      }
      case 0x08: {
        const value = (this.todLatched ? this.todLatch : this.tod)[0]!;
        this.todLatched = false; // reading tenths releases the hour-read latch
        return value;
      }
      case 0x0b:
        this.todLatch = [...this.tod];
        this.todLatched = true;
        return this.todLatch[3]!;
      default:
        return this.peek(reg);
    }
  }

  peek(reg: number): number {
    switch (reg & 0x0f) {
      case 0x00:
        return ((this.pra & this.ddra) | (this.inputs.inputA() & ~this.ddra)) & 0xff;
      case 0x01:
        return ((this.prb & this.ddrb) | (this.inputs.inputB() & ~this.ddrb)) & 0xff;
      case 0x02:
        return this.ddra;
      case 0x03:
        return this.ddrb;
      case 0x04:
        return this.ta & 0xff;
      case 0x05:
        return this.ta >> 8;
      case 0x06:
        return this.tb & 0xff;
      case 0x07:
        return this.tb >> 8;
      case 0x08:
        return (this.todLatched ? this.todLatch : this.tod)[0]!;
      case 0x09:
        return (this.todLatched ? this.todLatch : this.tod)[1]!;
      case 0x0a:
        return (this.todLatched ? this.todLatch : this.tod)[2]!;
      case 0x0b:
        return (this.todLatched ? this.todLatch : this.tod)[3]!;
      case 0x0c:
        return this.sdr;
      case 0x0d:
        return this.flags | (this.irq ? 0x80 : 0);
      case 0x0e:
        return this.cra & ~0x10;
      default:
        return this.crb & ~0x10;
    }
  }

  write(reg: number, value: number): void {
    value &= 0xff;
    switch (reg & 0x0f) {
      case 0x00:
        this.pra = value;
        break;
      case 0x01:
        this.prb = value;
        break;
      case 0x02:
        this.ddra = value;
        break;
      case 0x03:
        this.ddrb = value;
        break;
      case 0x04:
        this.taLatch = (this.taLatch & 0xff00) | value;
        break;
      case 0x05:
        this.taLatch = (this.taLatch & 0x00ff) | (value << 8);
        if (!(this.cra & 0x01)) this.ta = this.taLatch;
        break;
      case 0x06:
        this.tbLatch = (this.tbLatch & 0xff00) | value;
        break;
      case 0x07:
        this.tbLatch = (this.tbLatch & 0x00ff) | (value << 8);
        if (!(this.crb & 0x01)) this.tb = this.tbLatch;
        break;
      case 0x08:
      case 0x09:
      case 0x0a:
      case 0x0b:
        this.writeTod(reg & 0x0f, value);
        break;
      case 0x0c:
        this.sdr = value;
        break;
      case 0x0d:
        if (value & 0x80) this.mask |= value & 0x1f;
        else this.mask &= ~(value & 0x1f);
        this.updateIrq();
        break;
      case 0x0e:
        if (!(this.cra & 0x01) && value & 0x01) this.taDelay = 1;
        if (value & 0x10) this.ta = this.taLatch;
        this.cra = value & ~0x10;
        break;
      default:
        if (!(this.crb & 0x01) && value & 0x01) this.tbDelay = 1;
        if (value & 0x10) this.tb = this.tbLatch;
        this.crb = value & ~0x10;
        break;
    }
  }

  private updateIrq(): void {
    this.irq = (this.flags & this.mask) !== 0;
  }

  private writeTod(reg: number, value: number): void {
    const index = reg - 0x08;
    if (this.crb & 0x80) {
      this.alarm[index] = value;
      return;
    }
    if (index === 3) this.todRunning = false; // writing hours stops the clock
    this.tod[index] = value;
    if (index === 0) {
      this.todRunning = true; // writing tenths restarts it
      this.todAcc = 0;
    }
  }

  private todTenth(): void {
    const t = this.tod;
    if (t[0] !== 9) t[0] = t[0]! + 1;
    else {
      t[0] = 0;
      if (t[1] !== 0x59) t[1] = incBcd(t[1]!);
      else {
        t[1] = 0;
        if (t[2] !== 0x59) t[2] = incBcd(t[2]!);
        else {
          t[2] = 0;
          let h = t[3]! & 0x1f;
          let pm = t[3]! & 0x80;
          if (h === 0x12) h = 0x01;
          else {
            h = incBcd(h);
            if (h === 0x12) pm ^= 0x80;
          }
          t[3] = h | pm;
        }
      }
    }
    if (t[0] === this.alarm[0] && t[1] === this.alarm[1] && t[2] === this.alarm[2] && t[3] === this.alarm[3]) {
      this.pendingFlags |= 0x04;
    }
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/machine/cia.test.ts && npm run typecheck && npm run lint`
Expected: PASS, clean. If a timer-count expectation is off by one, fix `tick()` ordering (start delay, decrement, then pending flags); do not weaken the tests: they encode the spec's "1-cycle start delay, flag visible one cycle after underflow".

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(machine): CIA 6526 with timers A/B, ICR, TOD and port DDRs" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Keyboard matrix and palette

**Files:**
- Create: `src/machine/keyboard.ts`, `src/machine/palette.ts`
- Test: `test/machine/keyboard.test.ts`

**Interfaces:**
- Produces:
  - `type C64Key` (string union of the 64 matrix key names below) and `const KEY_POSITION: Record<C64Key, { col: number; row: number }>`.
  - `class Keyboard { press(key); release(key); scanColumns(colOut: number): number; scanRows(rowOut: number): number; releaseAll() }` — `scanColumns` takes the driven column levels (0 = selected) and returns the row levels (0 = pressed); `scanRows` is the reverse.
  - `PALETTE: Uint32Array` (16 RGBA entries).

- [ ] **Step 1: Write the failing tests**

`test/machine/keyboard.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { KEY_POSITION, Keyboard } from '../../src/machine/keyboard';
import { PALETTE } from '../../src/machine/palette';

describe('Keyboard matrix', () => {
  it('maps A to column PA1 / row PB2 and RUN_STOP to PA7 / PB7', () => {
    expect(KEY_POSITION.A).toEqual({ col: 1, row: 2 });
    expect(KEY_POSITION.RUN_STOP).toEqual({ col: 7, row: 7 });
    expect(KEY_POSITION.LSHIFT).toEqual({ col: 1, row: 7 });
    expect(KEY_POSITION.RETURN).toEqual({ col: 0, row: 1 });
    expect(KEY_POSITION.SPACE).toEqual({ col: 7, row: 4 });
  });

  it('scans columns -> rows and rows -> columns', () => {
    const k = new Keyboard();
    k.press('A');
    expect(k.scanColumns(0b1111_1101)).toBe(0b1111_1011); // select col 1, row 2 pulled low
    expect(k.scanColumns(0b1111_1110)).toBe(0xff); // col 0 selected: nothing
    expect(k.scanRows(0b1111_1011)).toBe(0b1111_1101); // select row 2, col 1 pulled low
    expect(k.scanRows(0xff)).toBe(0xff);
  });

  it('two keys in different columns both show when both columns are selected', () => {
    const k = new Keyboard();
    k.press('A');
    k.press('RETURN');
    expect(k.scanColumns(0x00)).toBe(0xff & ~(1 << 2) & ~(1 << 1));
  });

  it('is reference counted: two presses need two releases', () => {
    const k = new Keyboard();
    k.press('A');
    k.press('A');
    k.release('A');
    expect(k.scanColumns(0b1111_1101)).toBe(0b1111_1011);
    k.release('A');
    expect(k.scanColumns(0b1111_1101)).toBe(0xff);
  });

  it('extra releases do not go negative', () => {
    const k = new Keyboard();
    k.release('A');
    k.press('A');
    expect(k.scanColumns(0b1111_1101)).toBe(0b1111_1011);
  });
});

describe('palette', () => {
  it('has 16 opaque RGBA entries; white and black are exact', () => {
    expect(PALETTE).toHaveLength(16);
    expect(PALETTE[0]).toBe(0xff000000);
    expect(PALETTE[1]).toBe(0xffffffff);
    for (const c of PALETTE) expect(c >>> 24).toBe(0xff);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/machine/keyboard.test.ts`
Expected: FAIL — cannot resolve `keyboard`.

- [ ] **Step 3: Write the implementation**

`src/machine/palette.ts`:
```ts
// Pepto's C64 colours, 0xRRGGBB.
const RGB = [
  0x000000, 0xffffff, 0x68372b, 0x70a4b2, 0x6f3d86, 0x588d43, 0x352879, 0xb8c76f, 0x6f4f25,
  0x433900, 0x9a6759, 0x444444, 0x6c6c6c, 0x9ad284, 0x6c5eb5, 0x959595,
];

/** RGBA as a little-endian Uint32: 0xAABBGGRR. */
export const PALETTE: Uint32Array = Uint32Array.from(
  RGB,
  (c) => (0xff000000 | ((c & 0xff) << 16) | (c & 0xff00) | ((c >> 16) & 0xff)) >>> 0,
);
```

`src/machine/keyboard.ts`:
```ts
export type C64Key =
  | 'DEL' | 'RETURN' | 'CRSR_RIGHT' | 'F7' | 'F1' | 'F3' | 'F5' | 'CRSR_DOWN'
  | '3' | 'W' | 'A' | '4' | 'Z' | 'S' | 'E' | 'LSHIFT'
  | '5' | 'R' | 'D' | '6' | 'C' | 'F' | 'T' | 'X'
  | '7' | 'Y' | 'G' | '8' | 'B' | 'H' | 'U' | 'V'
  | '9' | 'I' | 'J' | '0' | 'M' | 'K' | 'O' | 'N'
  | 'PLUS' | 'P' | 'L' | 'MINUS' | 'PERIOD' | 'COLON' | 'AT' | 'COMMA'
  | 'POUND' | 'ASTERISK' | 'SEMICOLON' | 'HOME' | 'RSHIFT' | 'EQUALS' | 'UP_ARROW' | 'SLASH'
  | '1' | 'LEFT_ARROW' | 'CTRL' | '2' | 'SPACE' | 'COMMODORE' | 'Q' | 'RUN_STOP';

// MATRIX[col][row]: col = PA bit, row = PB bit.
// prettier-ignore
const MATRIX: readonly (readonly C64Key[])[] = [
  ['DEL', 'RETURN', 'CRSR_RIGHT', 'F7', 'F1', 'F3', 'F5', 'CRSR_DOWN'],
  ['3', 'W', 'A', '4', 'Z', 'S', 'E', 'LSHIFT'],
  ['5', 'R', 'D', '6', 'C', 'F', 'T', 'X'],
  ['7', 'Y', 'G', '8', 'B', 'H', 'U', 'V'],
  ['9', 'I', 'J', '0', 'M', 'K', 'O', 'N'],
  ['PLUS', 'P', 'L', 'MINUS', 'PERIOD', 'COLON', 'AT', 'COMMA'],
  ['POUND', 'ASTERISK', 'SEMICOLON', 'HOME', 'RSHIFT', 'EQUALS', 'UP_ARROW', 'SLASH'],
  ['1', 'LEFT_ARROW', 'CTRL', '2', 'SPACE', 'COMMODORE', 'Q', 'RUN_STOP'],
];

export const KEY_POSITION: Record<C64Key, { col: number; row: number }> = (() => {
  const out = {} as Record<C64Key, { col: number; row: number }>;
  MATRIX.forEach((rows, col) => rows.forEach((key, row) => (out[key] = { col, row })));
  return out;
})();

export class Keyboard {
  private readonly counts = new Uint8Array(64);
  /** Per column: bitmask of pressed rows. */
  private readonly rows = new Uint8Array(8);

  press(key: C64Key): void {
    const { col, row } = KEY_POSITION[key];
    const i = col * 8 + row;
    this.counts[i] = Math.min(255, this.counts[i]! + 1);
    this.rows[col]! |= 1 << row;
  }

  release(key: C64Key): void {
    const { col, row } = KEY_POSITION[key];
    const i = col * 8 + row;
    if (this.counts[i] === 0) return;
    this.counts[i]!--;
    if (this.counts[i] === 0) this.rows[col]! &= ~(1 << row);
  }

  releaseAll(): void {
    this.counts.fill(0);
    this.rows.fill(0);
  }

  /** `colOut`: driven column levels (0 = selected). Returns row levels (0 = a selected column has that row pressed). */
  scanColumns(colOut: number): number {
    let result = 0xff;
    for (let col = 0; col < 8; col++) {
      if (((colOut >> col) & 1) === 0) result &= ~this.rows[col]!;
    }
    return result & 0xff;
  }

  /** `rowOut`: driven row levels (0 = selected). Returns column levels (0 = a selected row is pressed in that column). */
  scanRows(rowOut: number): number {
    let result = 0xff;
    for (let col = 0; col < 8; col++) {
      if ((this.rows[col]! & ~rowOut & 0xff) !== 0) result &= ~(1 << col);
    }
    return result & 0xff;
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/machine && npm run typecheck && npm run lint`
Expected: PASS, clean (run `npx prettier --write src test` first if the long union fails the format check).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(machine): 8x8 keyboard matrix and Pepto palette" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: VIC-II (registers, raster, IRQ, standard text mode)

**Files:**
- Create: `src/machine/vic.ts`
- Test: `test/machine/vic.test.ts`

**Interfaces:**
- Consumes: `IoChip`, `PALETTE`.
- Produces: `class VicII implements IoChip { constructor(mem: { readMem(addr14: number): number; readColor(index: number): number }); tick(): void; reset(): void; readonly irq: boolean; readonly frame: Uint32Array; frameCount: number; raster: number; readonly debug: { vcBase; vc; rc; displayState } }`; constants `FRAME_WIDTH=384`, `FRAME_HEIGHT=272`, `CYCLES_PER_LINE=63`, `LINES=312`.

- [ ] **Step 1: Write the failing tests**

`test/machine/vic.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { PALETTE } from '../../src/machine/palette';
import { FRAME_WIDTH, VicII } from '../../src/machine/vic';

interface World {
  vic: VicII;
  vm: Uint8Array; // video matrix, 1000 bytes
  color: Uint8Array;
  glyphs: Map<number, number[]>; // screen code -> 8 rows
}

function world(): World {
  const vm = new Uint8Array(1000);
  const color = new Uint8Array(1000);
  const glyphs = new Map<number, number[]>();
  const vic = new VicII({
    // video matrix at $0400 (VM base 1 << 10), character base at $0800 (CB 1 << 11)
    readMem: (a) => {
      if (a >= 0x0400 && a < 0x0400 + 1000) return vm[a - 0x0400]!;
      if (a >= 0x0800 && a < 0x1000) {
        const code = (a - 0x0800) >> 3;
        return glyphs.get(code)?.[(a - 0x0800) & 7] ?? 0;
      }
      return a === 0x3fff ? 0x00 : 0;
    },
    readColor: (i) => color[i]!,
  });
  return { vic, vm, color, glyphs };
}

function setup(w: World) {
  w.vic.write(0x11, 0x1b); // DEN, RSEL, YSCROLL=3
  w.vic.write(0x16, 0x08); // CSEL
  w.vic.write(0x18, 0x12); // VM = 1 << 10 = $0400, CB = 1 << 11 = $0800
  w.vic.write(0x20, 0x0e); // border light blue
  w.vic.write(0x21, 0x06); // background blue
}

function runCycles(vic: VicII, n: number) {
  for (let i = 0; i < n; i++) vic.tick();
}
function runFrame(vic: VicII) {
  const f = vic.frameCount;
  while (vic.frameCount === f) vic.tick();
}
const px = (vic: VicII, x: number, y: number) => vic.frame[y * FRAME_WIDTH + x]!;

describe('registers', () => {
  it('unused bits read as 1 and colour registers read | $F0', () => {
    const { vic } = world();
    vic.write(0x20, 0x03);
    expect(vic.read(0x20)).toBe(0xf3);
    vic.write(0x16, 0x08);
    expect(vic.read(0x16)).toBe(0xc8);
    expect(vic.read(0x2f)).toBe(0xff);
    expect(vic.read(0x3f)).toBe(0xff);
  });

  it('$D011 bit 7 and $D012 reflect the live raster', () => {
    const { vic } = world();
    runCycles(vic, 63 * 300);
    expect(vic.raster).toBe(300);
    expect(vic.read(0x12)).toBe(300 & 0xff);
    expect(vic.read(0x11) & 0x80).toBe(0x80);
  });
});

describe('raster', () => {
  it('a frame is 312 lines of 63 cycles = 19,656 cycles', () => {
    const { vic } = world();
    let cycles = 0;
    const f = vic.frameCount;
    while (vic.frameCount === f) {
      vic.tick();
      cycles++;
    }
    expect(cycles).toBe(19_656);
    expect(vic.raster).toBe(0);
  });
});

describe('raster IRQ', () => {
  it('fires once at the compare line, clears via $D019 and does not retrigger on a same-value write', () => {
    const w = world();
    const { vic } = w;
    vic.write(0x12, 100);
    vic.write(0x1a, 0x01);
    runCycles(vic, 63 * 99);
    expect(vic.irq).toBe(false);
    runCycles(vic, 63);
    expect(vic.raster).toBe(100);
    expect(vic.irq).toBe(true);
    expect(vic.read(0x19) & 0x81).toBe(0x81);
    vic.write(0x19, 0x01);
    expect(vic.irq).toBe(false);
    vic.write(0x12, 100); // same value: no retrigger
    expect(vic.irq).toBe(false);
    runCycles(vic, 10);
    expect(vic.irq).toBe(false);
  });

  it('a disabled raster IRQ sets the status flag but not the line', () => {
    const { vic } = world();
    vic.write(0x12, 10);
    runCycles(vic, 63 * 10);
    expect(vic.irq).toBe(false);
    expect(vic.read(0x19) & 0x01).toBe(1);
  });
});

describe('text mode rendering', () => {
  // Display window top-left in framebuffer coordinates: x=32, y=51-15=36.
  it('draws border, background and a glyph at the right place', () => {
    const w = world();
    setup(w);
    w.vm[0] = 1; // screen code 1 in the top-left cell
    w.color[0] = 1; // white
    w.glyphs.set(1, [0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0]);
    runFrame(w.vic); // settle
    runFrame(w.vic);
    expect(px(w.vic, 0, 0)).toBe(PALETTE[14]); // border
    expect(px(w.vic, 32, 36)).toBe(PALETTE[1]); // glyph foreground
    expect(px(w.vic, 35, 36)).toBe(PALETTE[1]);
    expect(px(w.vic, 36, 36)).toBe(PALETTE[6]); // glyph background
    expect(px(w.vic, 40, 36)).toBe(PALETTE[6]); // next cell: code 0, no glyph bits -> bg
    expect(px(w.vic, 32, 35)).toBe(PALETTE[14]); // row above the window
    expect(px(w.vic, 351, 235)).toBe(PALETTE[6]); // last display pixel
    expect(px(w.vic, 352, 235)).toBe(PALETTE[14]); // right border
  });

  it('38 columns and 24 rows shrink the window', () => {
    const w = world();
    setup(w);
    w.vic.write(0x16, 0x00); // CSEL=0
    w.vic.write(0x11, 0x13); // RSEL=0
    runFrame(w.vic);
    runFrame(w.vic);
    expect(px(w.vic, 38, 100)).toBe(PALETTE[14]);
    expect(px(w.vic, 39, 100)).toBe(PALETTE[6]);
    expect(px(w.vic, 342, 100)).toBe(PALETTE[6]);
    expect(px(w.vic, 343, 100)).toBe(PALETTE[14]);
    expect(px(w.vic, 100, 36 + 3)).toBe(PALETTE[14]); // raster 54 < 55
    expect(px(w.vic, 100, 36 + 4)).toBe(PALETTE[6]); // raster 55
  });

  it('XSCROLL delays the picture by the scroll amount', () => {
    const w = world();
    setup(w);
    w.vm[0] = 1;
    w.color[0] = 1;
    w.glyphs.set(1, new Array(8).fill(0x80)); // only the leftmost pixel set
    w.vic.write(0x16, 0x08 | 3);
    runFrame(w.vic);
    runFrame(w.vic);
    expect(px(w.vic, 32, 36)).toBe(PALETTE[6]);
    expect(px(w.vic, 35, 36)).toBe(PALETTE[1]);
  });

  it('DEN=0 makes the whole frame border', () => {
    const w = world();
    setup(w);
    w.vic.write(0x11, 0x0b); // DEN off
    runFrame(w.vic);
    runFrame(w.vic);
    expect(px(w.vic, 100, 100)).toBe(PALETTE[14]);
  });

  it('counters: VCBASE reaches 1000 after the last text row and resets at line 0', () => {
    const w = world();
    setup(w);
    runFrame(w.vic);
    runFrame(w.vic);
    while (w.vic.raster !== 260) w.vic.tick();
    expect(w.vic.debug.vcBase).toBe(1000);
    while (w.vic.raster !== 1) w.vic.tick();
    expect(w.vic.debug.vcBase).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/machine/vic.test.ts`
Expected: FAIL — cannot resolve `vic`.

- [ ] **Step 3: Write `src/machine/vic.ts`**

```ts
import type { IoChip } from './io';
import { PALETTE } from './palette';

export const FRAME_WIDTH = 384;
export const FRAME_HEIGHT = 272;
export const CYCLES_PER_LINE = 63;
export const LINES = 312;

const FIRST_VISIBLE_CYCLE = 12;
const LAST_VISIBLE_CYCLE = 59;
const FIRST_G_CYCLE = 16;
const LAST_G_CYCLE = 55;
const FIRST_VISIBLE_RASTER = 15;
const LAST_VISIBLE_RASTER = 286;

export interface VicMemory {
  readMem(addr14: number): number;
  readColor(index: number): number;
}

export class VicII implements IoChip {
  readonly frame = new Uint32Array(FRAME_WIDTH * FRAME_HEIGHT);
  frameCount = 0;
  raster = 0;

  private cycle = 1;
  private readonly regs = new Uint8Array(0x40);
  private status = 0;
  private enable = 0;
  private matched = false;
  private denLatch = false;
  private badline = false;
  private displayState = false;
  private vcBase = 0;
  private vc = 0;
  private rc = 0;
  private vmli = 0;
  private readonly chars = new Uint8Array(40);
  private readonly colors = new Uint8Array(40);
  private prev = new Uint8Array(8);
  private readonly cur = new Uint8Array(8);
  private readonly shifted = new Uint8Array(8);

  constructor(private readonly mem: VicMemory) {
    this.reset();
  }

  get irq(): boolean {
    return (this.status & this.enable & 0x0f) !== 0;
  }

  get debug() {
    return { vcBase: this.vcBase, vc: this.vc, rc: this.rc, displayState: this.displayState };
  }

  reset(): void {
    this.regs.fill(0);
    this.status = 0;
    this.enable = 0;
    this.matched = false;
    this.denLatch = false;
    this.badline = false;
    this.displayState = false;
    this.vcBase = this.vc = this.rc = this.vmli = 0;
    this.raster = 0;
    this.cycle = 1;
    this.prev.fill(0);
    this.startLine();
  }

  // ---- registers --------------------------------------------------------

  read(reg: number): number {
    return this.peek(reg);
  }

  peek(reg: number): number {
    reg &= 0x3f;
    switch (reg) {
      case 0x11:
        return (this.regs[0x11]! & 0x7f) | ((this.raster & 0x100) >> 1);
      case 0x12:
        return this.raster & 0xff;
      case 0x16:
        return this.regs[0x16]! | 0xc0;
      case 0x18:
        return this.regs[0x18]! | 0x01;
      case 0x19:
        return (this.status & 0x0f) | 0x70 | (this.irq ? 0x80 : 0);
      case 0x1a:
        return this.enable | 0xf0;
      case 0x1e:
      case 0x1f:
        return 0;
      default:
        if (reg >= 0x20 && reg <= 0x2e) return this.regs[reg]! | 0xf0;
        if (reg >= 0x2f) return 0xff;
        return this.regs[reg]!;
    }
  }

  write(reg: number, value: number): void {
    reg &= 0x3f;
    value &= 0xff;
    switch (reg) {
      case 0x19:
        this.status &= ~(value & 0x0f);
        return;
      case 0x1a:
        this.enable = value & 0x0f;
        return;
      case 0x11:
      case 0x12:
        this.regs[reg] = value;
        this.checkRasterCompare();
        return;
      default:
        if (reg < 0x2f) this.regs[reg] = value;
    }
  }

  // ---- per-cycle machine --------------------------------------------------

  tick(): void {
    const c = this.cycle;
    if (c === 14) this.beginDisplayLine();
    if (c >= FIRST_VISIBLE_CYCLE && c <= LAST_VISIBLE_CYCLE) this.outputCycle(c);
    if (c === 58) this.endDisplayLine();
    if (c === CYCLES_PER_LINE) {
      this.cycle = 1;
      this.nextLine();
    } else {
      this.cycle = c + 1;
    }
  }

  private nextLine(): void {
    this.raster++;
    if (this.raster >= LINES) {
      this.raster = 0;
      this.vcBase = 0;
      this.frameCount++;
    }
    this.startLine();
  }

  private startLine(): void {
    if (this.raster === 0x30) this.denLatch = (this.regs[0x11]! & 0x10) !== 0;
    this.checkRasterCompare();
  }

  private checkRasterCompare(): void {
    const compare = ((this.regs[0x11]! & 0x80) << 1) | this.regs[0x12]!;
    const match = this.raster === compare;
    if (match && !this.matched) this.status |= 0x01;
    this.matched = match;
  }

  private beginDisplayLine(): void {
    this.vc = this.vcBase;
    this.vmli = 0;
    const yscroll = this.regs[0x11]! & 7;
    this.badline =
      this.denLatch && this.raster >= 0x30 && this.raster <= 0xf7 && (this.raster & 7) === yscroll;
    if (this.badline) {
      this.displayState = true;
      this.rc = 0;
    }
  }

  private endDisplayLine(): void {
    if (this.rc === 7) {
      this.displayState = false;
      this.vcBase = this.vc;
    }
    if (this.displayState) this.rc = (this.rc + 1) & 7;
  }

  private outputCycle(c: number): void {
    const regs = this.regs;
    const bg = regs[0x21]! & 0x0f;
    let glyph = 0;
    let fg = 0;

    if (c >= FIRST_G_CYCLE && c <= LAST_G_CYCLE) {
      if (this.displayState) {
        const vm = ((regs[0x18]! >> 4) & 0x0f) << 10;
        const cb = ((regs[0x18]! >> 1) & 0x07) << 11;
        if (this.badline) {
          this.chars[this.vmli] = this.mem.readMem(vm + this.vc);
          this.colors[this.vmli] = this.mem.readColor(this.vc & 0x3ff) & 0x0f;
        }
        const code = this.chars[this.vmli]!;
        fg = this.colors[this.vmli]!;
        glyph = this.mem.readMem(cb + code * 8 + this.rc);
        this.vc = (this.vc + 1) & 0x3ff;
        this.vmli = (this.vmli + 1) % 40;
      } else {
        glyph = this.mem.readMem(0x3fff);
      }
    }

    for (let i = 0; i < 8; i++) this.cur[i] = (glyph >> (7 - i)) & 1 ? fg : bg;

    const xs = regs[0x16]! & 7;
    for (let i = 0; i < 8; i++) {
      this.shifted[i] = i >= xs ? this.cur[i - xs]! : this.prev[8 + i - xs]!;
    }
    this.prev.set(this.cur);

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
      const colour = verticalOpen && fx >= left && fx < right ? this.shifted[i]! : border;
      this.frame[rowBase + fx] = PALETTE[colour]!;
    }
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/machine/vic.test.ts && npm run typecheck && npm run lint`
Expected: PASS. If the `VCBASE` test fails, re-check the order in `endDisplayLine` (RC==7 check first, then the display-state increment) against Bauer section 3.7.2; if a pixel coordinate is off by one, the cycle-12 to framebuffer-x mapping (`fx0 = (c - 12) * 8`) and the window constants are the places to look.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(machine): VIC-II registers, raster IRQ and standard text-mode rendering" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: PRG parser

**Files:**
- Create: `src/machine/prg.ts`
- Test: `test/machine/prg.test.ts`

**Interfaces:**
- Produces: `class PrgError extends Error`; `interface Prg { address: number; data: Uint8Array; end: number }` (`end` exclusive); `parsePrg(bytes: Uint8Array): Prg`; `rawProgram(bytes: Uint8Array, address: number): Prg`.

- [ ] **Step 1: Write the failing tests**

`test/machine/prg.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parsePrg, PrgError, rawProgram } from '../../src/machine/prg';

describe('parsePrg', () => {
  it('reads the little-endian load address and data', () => {
    const prg = parsePrg(Uint8Array.from([0x01, 0x08, 0xaa, 0xbb]));
    expect(prg.address).toBe(0x0801);
    expect([...prg.data]).toEqual([0xaa, 0xbb]);
    expect(prg.end).toBe(0x0803);
  });

  it('rejects files with no data bytes (2-byte and empty files)', () => {
    expect(() => parsePrg(Uint8Array.from([0x01, 0x08]))).toThrow(PrgError);
    expect(() => parsePrg(new Uint8Array(0))).toThrow(PrgError);
  });

  it('rejects data that runs past $FFFF', () => {
    expect(() => parsePrg(Uint8Array.from([0xff, 0xff, 0x01, 0x02]))).toThrow(/\$FFFF/);
  });

  it('does not restrict a $0801 program to the BASIC area (end above $9FFF is accepted)', () => {
    const bytes = new Uint8Array(2 + 0xa000);
    bytes[0] = 0x01;
    bytes[1] = 0x08;
    expect(parsePrg(bytes).end).toBe(0x0801 + 0xa000);
  });

  it('accepts data that ends exactly at $FFFF', () => {
    const prg = parsePrg(Uint8Array.from([0xff, 0xff, 0x01]));
    expect(prg.end).toBe(0x10000);
  });
});

describe('rawProgram', () => {
  it('wraps a headerless binary at an explicit address', () => {
    const prg = rawProgram(Uint8Array.from([1, 2, 3]), 0xc000);
    expect(prg.address).toBe(0xc000);
    expect(prg.end).toBe(0xc003);
  });

  it('rejects an address outside 0..$FFFF or an overrun', () => {
    expect(() => rawProgram(Uint8Array.from([1]), -1)).toThrow(PrgError);
    expect(() => rawProgram(Uint8Array.from([1, 2]), 0xffff)).toThrow(PrgError);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/machine/prg.test.ts` → FAIL (cannot resolve `prg`).

- [ ] **Step 3: Write `src/machine/prg.ts`**

```ts
export class PrgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrgError';
  }
}

export interface Prg {
  address: number;
  data: Uint8Array;
  /** Exclusive end address. */
  end: number;
}

export function rawProgram(bytes: Uint8Array, address: number): Prg {
  if (!Number.isInteger(address) || address < 0 || address > 0xffff) {
    throw new PrgError(`load address ${address} is outside $0000-$FFFF`);
  }
  if (bytes.length === 0) throw new PrgError('program has no data');
  const end = address + bytes.length;
  if (end > 0x10000) {
    throw new PrgError(`program of ${bytes.length} bytes at $${address.toString(16).toUpperCase()} runs past $FFFF`);
  }
  return { address, data: bytes, end };
}

export function parsePrg(bytes: Uint8Array): Prg {
  if (bytes.length < 3) {
    throw new PrgError(`a PRG needs a 2-byte load address and at least 1 data byte, got ${bytes.length} bytes`);
  }
  const address = bytes[0]! | (bytes[1]! << 8);
  return rawProgram(bytes.subarray(2), address);
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run test/machine && npm run typecheck && npm run lint` → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(machine): PRG parser and raw-binary placement" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `C64` machine (wiring, frame loop, typing, loadPrg)

**Files:**
- Create: `src/machine/c64.ts`
- Modify: `src/machine/index.ts`
- Test: `test/machine/c64.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2-6, `MOS6502`.
- Produces: `class C64` per the spec's section 4.1, plus `screenText(): string[]` (25 lines, screen codes converted to characters) and `isReady(): boolean`; `C64Options { video?: 'pal' }`; exports from `src/machine/index.ts`: `C64`, `C64Options`, `RomSet`, `RomError`, `C64Key`, `PrgError`, `FRAME_WIDTH`, `FRAME_HEIGHT`.

- [ ] **Step 1: Write the failing tests**

`test/machine/c64.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { C64 } from '../../src/machine/c64';
import { PALETTE } from '../../src/machine/palette';
import { PrgError } from '../../src/machine/prg';
import { FRAME_WIDTH } from '../../src/machine/vic';
import { filled } from './helpers';

/**
 * A synthetic KERNAL: sets up the VIC, writes screen code 1 / colour 1 to the first cell, loops.
 * Glyph for screen code 1 is $F0 on every row.
 */
/** A machine whose keyboard buffer state is initialised as the KERNAL would leave it. */
function newMachine(): C64 {
  const c64 = new C64(syntheticRoms());
  c64.pokeRam(0xc6, 0); // NDX: no characters queued (power-on RAM holds $FF there)
  c64.pokeRam(0x0289, 10); // XMAX: keyboard buffer length
  return c64;
}

function syntheticRoms() {
  const kernal = filled(8192, 0xea);
  const code = [
    0x78, //             SEI
    0xa9, 0x1b, 0x8d, 0x11, 0xd0, // LDA #$1B ; STA $D011
    0xa9, 0x08, 0x8d, 0x16, 0xd0, // LDA #$08 ; STA $D016
    0xa9, 0x14, 0x8d, 0x18, 0xd0, // LDA #$14 ; STA $D018  (VM $0400, CB $1000 = chargen ROM)
    0xa9, 0x0e, 0x8d, 0x20, 0xd0, // border light blue
    0xa9, 0x06, 0x8d, 0x21, 0xd0, // background blue
    0xa9, 0x01, 0x8d, 0x00, 0x04, // LDA #1 ; STA $0400
    0xa9, 0x01, 0x8d, 0x00, 0xd8, // LDA #1 ; STA $D800 (white)
    0x4c, 0x1e, 0xe0, //   JMP * (address computed below)
  ];
  kernal.set(code, 0);
  // fix the JMP target: offset of the JMP instruction itself
  const jmpAt = code.length - 3;
  kernal[jmpAt + 1] = (0xe000 + jmpAt) & 0xff;
  kernal[jmpAt + 2] = (0xe000 + jmpAt) >> 8;
  kernal[0x1ffc] = 0x00; // reset vector -> $E000
  kernal[0x1ffd] = 0xe0;
  const chargen = filled(4096, 0);
  for (let row = 0; row < 8; row++) chargen[1 * 8 + row] = 0xf0; // screen code 1
  return { kernal, basic: filled(8192, 0), chargen };
}

describe('C64 integration with a synthetic KERNAL', () => {
  it('renders a glyph, colours and border after a couple of frames', () => {
    const c64 = new C64(syntheticRoms());
    c64.runFrame();
    c64.runFrame();
    const { pixels } = c64.frame;
    expect(pixels[0]).toBe(PALETTE[14]); // border
    expect(pixels[36 * FRAME_WIDTH + 32]).toBe(PALETTE[1]); // glyph foreground
    expect(pixels[36 * FRAME_WIDTH + 36]).toBe(PALETTE[6]); // background
  });

  it('exposes frame geometry', () => {
    const c64 = new C64(syntheticRoms());
    expect(c64.frame.width).toBe(384);
    expect(c64.frame.height).toBe(272);
    expect(c64.frame.pixels).toHaveLength(384 * 272);
  });

  it('runFrame advances exactly one VIC frame (19,656 cycles on average)', () => {
    const c64 = new C64(syntheticRoms());
    c64.runFrame();
    const start = c64.cpu.cycles;
    for (let i = 0; i < 10; i++) c64.runFrame();
    expect(c64.cpu.cycles - start).toBe(19_656 * 10);
  });

  it('screenText converts screen codes (1 -> A) and isReady is false without READY.', () => {
    const c64 = new C64(syntheticRoms());
    c64.runFrame();
    c64.runFrame();
    expect(c64.screenText()[0]!.startsWith('A')).toBe(true);
    expect(c64.isReady()).toBe(false);
  });

  it('runUntilReady times out cleanly (returns false) instead of hanging', () => {
    const c64 = new C64(syntheticRoms());
    expect(c64.runUntilReady(3)).toBe(false);
  });

  it('isReady detects READY. in screen RAM', () => {
    const c64 = new C64(syntheticRoms());
    c64.runFrame();
    const ready = [0x12, 0x05, 0x01, 0x04, 0x19, 0x2e];
    ready.forEach((code, i) => (c64.pokeRam(0x0400 + 40 + i, code)));
    expect(c64.isReady()).toBe(true);
    expect(c64.runUntilReady(1)).toBe(true);
  });
});

describe('typing', () => {
  it('writes into the KERNAL keyboard buffer ($0277, count at $C6) up to its length', () => {
    const c64 = newMachine();
    c64.type('RUN\r');
    c64.runFrame();
    expect(c64.peek(0xc6)).toBe(4);
    expect([0x0277, 0x0278, 0x0279, 0x027a].map((a) => c64.peek(a))).toEqual([0x52, 0x55, 0x4e, 0x0d]);
  });

  it('queues more than the buffer holds and feeds it as it drains', () => {
    const c64 = newMachine();
    c64.type('A'.repeat(25));
    c64.runFrame();
    expect(c64.peek(0xc6)).toBe(10);
    c64.pokeRam(0xc6, 0); // the KERNAL consumed them
    c64.runFrame();
    expect(c64.peek(0xc6)).toBe(10);
    c64.pokeRam(0xc6, 0);
    c64.runFrame();
    expect(c64.peek(0xc6)).toBe(5);
  });
});

describe('loadPrg', () => {
  it('copies a BASIC program, fixes VARTAB/ARYTAB/STREND and types RUN', () => {
    const c64 = newMachine();
    const prg = Uint8Array.from([0x01, 0x08, 0x0b, 0x08, 0x0a, 0x00, 0x99, 0x22, 0x48, 0x49, 0x22, 0x00, 0x00, 0x00]);
    c64.loadPrg(prg);
    c64.runFrame();
    expect(c64.peek(0x0801)).toBe(0x0b);
    const end = 0x0801 + 12;
    for (const lo of [0x2d, 0x2f, 0x31]) {
      expect(c64.peek(lo)).toBe(end & 0xff);
      expect(c64.peek(lo + 1)).toBe(end >> 8);
    }
    expect([0x0277, 0x0278, 0x0279, 0x027a].map((a) => c64.peek(a))).toEqual([0x52, 0x55, 0x4e, 0x0d]);
  });

  it('types SYS <address> for machine code at another address', () => {
    const c64 = newMachine();
    c64.loadPrg(Uint8Array.from([0x00, 0xc0, 0x60]));
    c64.runFrame();
    expect(c64.peek(0xc000)).toBe(0x60);
    const typed = Array.from({ length: c64.peek(0xc6) }, (_, i) => String.fromCharCode(c64.peek(0x0277 + i)));
    expect(typed.join('')).toBe('SYS 49152\r');
  });

  it('explicit address/start places a raw binary and SYSes the start', () => {
    const c64 = newMachine();
    c64.loadPrg(Uint8Array.from([0xea, 0x60]), { address: 0xc000, start: 0xc001 });
    c64.runFrame();
    expect(c64.peek(0xc000)).toBe(0xea);
    const typed = Array.from({ length: c64.peek(0xc6) }, (_, i) => String.fromCharCode(c64.peek(0x0277 + i)));
    expect(typed.join('')).toBe('SYS 49153\r');
  });

  it("run: 'none' only copies", () => {
    const c64 = new C64(syntheticRoms());
    c64.loadPrg(Uint8Array.from([0x01, 0x08, 0x05]), { run: 'none' });
    c64.runFrame();
    expect(c64.peek(0x0801)).toBe(0x05);
    expect(c64.peek(0xc6)).toBe(0);
  });

  it('rejects a truncated PRG without writing anything', () => {
    const c64 = new C64(syntheticRoms());
    c64.pokeRam(0x0801, 0x77);
    expect(() => c64.loadPrg(Uint8Array.from([0x01, 0x08]))).toThrow(PrgError);
    expect(c64.peek(0x0801)).toBe(0x77);
  });
});

describe('keyboard and RESTORE', () => {
  it('RESTORE raises an NMI edge the CPU takes', () => {
    const c64 = new C64(syntheticRoms());
    c64.runFrame();
    const before = c64.cpu.regs.sp;
    c64.restore();
    c64.runCycles(50);
    expect(c64.cpu.regs.sp).not.toBe(before); // interrupt sequence pushed to the stack
  });

  it('keyDown is visible through CIA1 (column select via $DC00, rows via $DC01)', () => {
    const c64 = new C64(syntheticRoms());
    c64.runFrame();
    c64.keyDown('A');
    c64.writeIo(0xdc02, 0xff); // DDRA: all outputs, as the KERNAL sets it
    c64.writeIo(0xdc00, 0b1111_1101); // select column 1
    expect(c64.peek(0xdc01)).toBe(0b1111_1011);
    c64.keyUp('A');
    expect(c64.peek(0xdc01)).toBe(0xff);
  });
});
```

(`pokeRam(addr, value)` and `writeIo(addr, value)` are small test/diagnostic helpers: `pokeRam` writes straight into RAM; `writeIo` performs a CPU-visible bus write. Add both to `C64`.)

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/machine/c64.test.ts` → FAIL (cannot resolve `c64`).

- [ ] **Step 3: Write `src/machine/c64.ts`**

```ts
import { MOS6502 } from '../core';
import { C64Bus } from './bus';
import { Cia } from './cia';
import { CpuPort } from './cpu-port';
import { Keyboard, type C64Key } from './keyboard';
import { validateRoms, type RomSet } from './memory';
import { parsePrg, rawProgram, type Prg } from './prg';
import { FRAME_HEIGHT, FRAME_WIDTH, VicII } from './vic';

export interface C64Options {
  video?: 'pal';
}

export interface LoadPrgOptions {
  run?: 'auto' | 'basic' | 'sys' | 'none';
  /** Treat the bytes as a headerless binary placed at this address. */
  address?: number;
  /** Start address for `SYS` (default: the load address). */
  start?: number;
}

const CYCLES_PER_FRAME = 19_656;
const RESTORE_PULSE_CYCLES = 8;

export class C64 {
  readonly cpu: MOS6502;
  private readonly bus: C64Bus;
  private readonly port: CpuPort;
  private readonly cia1: Cia;
  private readonly cia2: Cia;
  private readonly vic: VicII;
  private readonly keyboard = new Keyboard();
  private restoreCountdown = 0;
  private credit = 0;
  private readonly typeQueue: number[] = [];

  constructor(roms: RomSet, options: C64Options = {}) {
    validateRoms(roms);
    if (options.video !== undefined && options.video !== 'pal') {
      throw new Error(`unsupported video standard '${options.video}': only 'pal' is implemented`);
    }
    this.port = new CpuPort(() => this.bus.rebuild());
    this.cia1 = new Cia({
      inputA: () => this.keyboard.scanRows(this.cia1.outputB()),
      inputB: () => this.keyboard.scanColumns(this.cia1.outputA()),
    });
    this.cia2 = new Cia({ inputA: () => 0xff, inputB: () => 0xff });
    this.vic = new VicII({
      readMem: (a) => this.bus.vicRead(a),
      readColor: (i) => this.bus.colorRam[i & 0x3ff]!,
    });
    this.bus = new C64Bus(roms, { vic: this.vic, cia1: this.cia1, cia2: this.cia2 }, this.port);
    this.cpu = new MOS6502(this.bus, { onCycle: () => this.tickChips() });
    this.bus.powerOn();
    this.reset();
  }

  get frame() {
    return { width: FRAME_WIDTH as 384, height: FRAME_HEIGHT as 272, pixels: this.vic.frame };
  }

  reset(): void {
    this.port.reset();
    this.cia1.reset();
    this.cia2.reset();
    this.vic.reset();
    this.keyboard.releaseAll();
    this.typeQueue.length = 0;
    this.restoreCountdown = 0;
    this.credit = 0;
    this.cpu.reset();
  }

  runCycles(n: number): void {
    this.credit += n;
    while (this.credit > 0) this.credit -= this.cpu.step();
  }

  /** Runs until the VIC completes one frame. */
  runFrame(): void {
    const start = this.vic.frameCount;
    while (this.vic.frameCount === start) this.cpu.step();
    this.pumpTypeQueue();
  }

  /** Runs frames until READY. is on screen; returns false after `maxFrames`. */
  runUntilReady(maxFrames = 600): boolean {
    for (let i = 0; i < maxFrames; i++) {
      if (this.isReady()) return true;
      this.runFrame();
    }
    return this.isReady();
  }

  isReady(): boolean {
    return this.screenText().some((line) => line.includes('READY.'));
  }

  /** The 25 screen lines as text (uppercase charset screen codes). */
  screenText(): string[] {
    const base = ((this.vic.peek(0x18) >> 4) & 0x0f) << 10;
    const lines: string[] = [];
    for (let row = 0; row < 25; row++) {
      let line = '';
      for (let col = 0; col < 40; col++) {
        line += screenCodeToChar(this.bus.vicRead(base + row * 40 + col));
      }
      lines.push(line);
    }
    return lines;
  }

  keyDown(key: C64Key): void {
    this.keyboard.press(key);
  }

  keyUp(key: C64Key): void {
    this.keyboard.release(key);
  }

  restore(): void {
    this.restoreCountdown = RESTORE_PULSE_CYCLES;
  }

  /** Queues text for the KERNAL keyboard buffer (PETSCII: letters upper-case, \n and \r = RETURN). */
  type(text: string): void {
    for (const ch of text) {
      const code = ch === '\n' || ch === '\r' ? 0x0d : ch.toUpperCase().charCodeAt(0) & 0xff;
      this.typeQueue.push(code);
    }
    this.pumpTypeQueue();
  }

  loadPrg(bytes: Uint8Array, options: LoadPrgOptions = {}): void {
    const prg: Prg =
      options.address !== undefined ? rawProgram(bytes, options.address) : parsePrg(bytes);
    this.bus.ram.set(prg.data, prg.address);
    let run = options.run ?? 'auto';
    if (run === 'auto') run = prg.address === 0x0801 && options.start === undefined ? 'basic' : 'sys';
    if (run === 'basic') {
      for (const lo of [0x2d, 0x2f, 0x31]) {
        this.bus.ram[lo] = prg.end & 0xff;
        this.bus.ram[lo + 1] = prg.end >> 8;
      }
      this.type('RUN\r');
    } else if (run === 'sys') {
      this.type(`SYS ${options.start ?? prg.address}\r`);
    }
  }

  peek(addr: number): number {
    return this.bus.peek(addr);
  }

  /** Test/diagnostic helper: write straight into RAM, ignoring banking. */
  pokeRam(addr: number, value: number): void {
    this.bus.ram[addr & 0xffff] = value & 0xff;
  }

  /** Test/diagnostic helper: a CPU-visible bus write. */
  writeIo(addr: number, value: number): void {
    this.bus.write(addr, value);
  }

  // ---- internals -----------------------------------------------------------

  private tickChips(): void {
    this.cia1.tick();
    this.cia2.tick();
    this.vic.tick();
    this.bus.vicBank = ~this.cia2.outputA() & 3;
    let restoreActive = false;
    if (this.restoreCountdown > 0) {
      restoreActive = true;
      this.restoreCountdown--;
    }
    this.cpu.setIrq(this.cia1.irq || this.vic.irq);
    this.cpu.setNmi(this.cia2.irq || restoreActive);
  }

  private pumpTypeQueue(): void {
    const ram = this.bus.ram;
    const max = Math.min(ram[0x0289]! || 10, 10);
    while (this.typeQueue.length > 0 && ram[0xc6]! < max) {
      const n = ram[0xc6]!;
      ram[0x0277 + n] = this.typeQueue.shift()!;
      ram[0xc6] = n + 1;
    }
  }
}

function screenCodeToChar(code: number): string {
  const c = code & 0x7f;
  if (c === 0) return '@';
  if (c <= 26) return String.fromCharCode(0x40 + c);
  if (c === 27) return '[';
  if (c === 28) return '£';
  if (c === 29) return ']';
  if (c === 30) return '^';
  if (c === 31) return '←';
  if (c >= 32 && c < 64) return String.fromCharCode(c);
  return ' ';
}

export { CYCLES_PER_FRAME };
```

`src/machine/index.ts`:
```ts
export { C64, type C64Options, type LoadPrgOptions } from './c64';
export { RomError, type RomSet } from './memory';
export { PrgError } from './prg';
export type { C64Key } from './keyboard';
export { FRAME_HEIGHT, FRAME_WIDTH } from './vic';
```

(Remove the unused `READY` constant if lint flags it.)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/machine && npm run typecheck && npm run lint`
Expected: PASS, clean. If the NMI test fails, check that `tickChips` runs inside `onCycle` for every bus access and that `setNmi` sees a false-to-true edge.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(machine): C64 wiring with frame loop, typing, PRG loading and RESTORE" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Browser keymap

**Files:**
- Create: `src/browser/keymap.ts`
- Test: `test/browser/keymap.test.ts`

**Interfaces:**
- Consumes: `C64Key`.
- Produces: `interface KeyEventLike { key: string; code: string; shiftKey: boolean }`; `interface KeySink { press(k: C64Key): void; release(k: C64Key): void; restore(): void }`; `class KeyMapper { constructor(sink: KeySink); down(e: KeyEventLike): boolean; up(e: KeyEventLike): boolean; releaseAll(): void }` (the boolean = "handled, call preventDefault").

- [ ] **Step 1: Write the failing tests**

`test/browser/keymap.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { KeyMapper, type KeyEventLike } from '../../src/browser/keymap';
import type { C64Key } from '../../src/machine/keyboard';

function rig() {
  const down = new Set<C64Key>();
  let restores = 0;
  const mapper = new KeyMapper({
    press: (k) => void down.add(k),
    release: (k) => void down.delete(k),
    restore: () => void restores++,
  });
  return { mapper, down, restores: () => restores };
}
const ev = (key: string, code: string, shiftKey = false): KeyEventLike => ({ key, code, shiftKey });
const SHIFT_L = ev('Shift', 'ShiftLeft', true);

describe('letters and digits', () => {
  it('maps letters to C64 letter keys regardless of case and passes physical shift through', () => {
    const { mapper, down } = rig();
    mapper.down(ev('a', 'KeyA'));
    expect(down).toEqual(new Set(['A']));
    mapper.up(ev('a', 'KeyA'));
    expect(down.size).toBe(0);
    mapper.down(SHIFT_L);
    mapper.down(ev('A', 'KeyA', true));
    expect(down).toEqual(new Set(['A', 'LSHIFT']));
  });

  it('digits are unshifted: 5 with no shift', () => {
    const { mapper, down } = rig();
    mapper.down(ev('5', 'Digit5'));
    expect(down).toEqual(new Set(['5']));
  });
});

describe('symbols force the virtual shift', () => {
  it('Shift+2 (the character ") presses 2 with C64 shift', () => {
    const { mapper, down } = rig();
    mapper.down(SHIFT_L);
    mapper.down(ev('"', 'Digit2', true));
    expect(down).toEqual(new Set(['2', 'LSHIFT']));
  });

  it('+ pressed with PC shift held (US Shift+=) releases C64 shift', () => {
    const { mapper, down } = rig();
    mapper.down(SHIFT_L);
    mapper.down(ev('+', 'Equal', true));
    expect(down).toEqual(new Set(['PLUS']));
  });

  it('releasing a forced symbol restores the physical shift state', () => {
    const { mapper, down } = rig();
    mapper.down(SHIFT_L);
    mapper.down(ev('+', 'Equal', true));
    expect(down.has('LSHIFT')).toBe(false);
    mapper.up(ev('+', 'Equal', true));
    expect(down).toEqual(new Set(['LSHIFT'])); // physical shift still held
    mapper.up({ key: 'Shift', code: 'ShiftLeft', shiftKey: false });
    expect(down.size).toBe(0);
  });

  it('< and > are shifted comma/period; = is unshifted', () => {
    const { mapper, down } = rig();
    mapper.down(ev('<', 'Comma', true));
    expect(down).toEqual(new Set(['COMMA', 'LSHIFT']));
    mapper.up(ev('<', 'Comma', true));
    mapper.down(ev('=', 'Equal'));
    expect(down).toEqual(new Set(['EQUALS']));
  });
});

describe('special keys', () => {
  it.each([
    [ev('Enter', 'Enter'), ['RETURN']],
    [ev('Backspace', 'Backspace'), ['DEL']],
    [ev('Escape', 'Escape'), ['RUN_STOP']],
    [ev('Tab', 'Tab'), ['CTRL']],
    [ev('Control', 'ControlLeft'), ['COMMODORE']],
    [ev(' ', 'Space'), ['SPACE']],
    [ev('ArrowRight', 'ArrowRight'), ['CRSR_RIGHT']],
    [ev('ArrowLeft', 'ArrowLeft'), ['CRSR_RIGHT', 'LSHIFT']],
    [ev('ArrowDown', 'ArrowDown'), ['CRSR_DOWN']],
    [ev('ArrowUp', 'ArrowUp'), ['CRSR_DOWN', 'LSHIFT']],
    [ev('Home', 'Home'), ['HOME']],
    [ev('F1', 'F1'), ['F1']],
    [ev('F2', 'F2'), ['F1', 'LSHIFT']],
    [ev('F4', 'F4'), ['F3', 'LSHIFT']],
    [ev('F8', 'F8'), ['F7', 'LSHIFT']],
  ])('%j -> %j', (event, keys) => {
    const { mapper, down } = rig();
    expect(mapper.down(event)).toBe(true);
    expect(down).toEqual(new Set(keys as C64Key[]));
  });

  it('Shift+Backspace gives INST (DEL with C64 shift) and Shift+Home gives CLR', () => {
    const { mapper, down } = rig();
    mapper.down(SHIFT_L);
    mapper.down(ev('Backspace', 'Backspace', true));
    expect(down).toEqual(new Set(['DEL', 'LSHIFT']));
  });

  it('PageUp pulses RESTORE and presses no key', () => {
    const { mapper, down, restores } = rig();
    expect(mapper.down(ev('PageUp', 'PageUp'))).toBe(true);
    expect(restores()).toBe(1);
    expect(down.size).toBe(0);
  });

  it('unknown keys are not handled', () => {
    const { mapper, down } = rig();
    expect(mapper.down(ev('F12', 'F12'))).toBe(false);
    expect(mapper.down(ev('~', 'Backquote', true))).toBe(false);
    expect(down.size).toBe(0);
  });
});

describe('multiple keys and blur', () => {
  it('two keys held together; releasing one keeps the other', () => {
    const { mapper, down } = rig();
    mapper.down(ev('a', 'KeyA'));
    mapper.down(ev('s', 'KeyS'));
    expect(down).toEqual(new Set(['A', 'S']));
    mapper.up(ev('a', 'KeyA'));
    expect(down).toEqual(new Set(['S']));
  });

  it('releaseAll releases everything', () => {
    const { mapper, down } = rig();
    mapper.down(SHIFT_L);
    mapper.down(ev('A', 'KeyA', true));
    mapper.releaseAll();
    expect(down.size).toBe(0);
  });

  it('a keyup arriving without a keydown is ignored', () => {
    const { mapper, down } = rig();
    expect(mapper.up(ev('a', 'KeyA'))).toBe(false);
    expect(down.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/browser/keymap.test.ts` → FAIL (cannot resolve `keymap`).

- [ ] **Step 3: Write `src/browser/keymap.ts`**

```ts
import type { C64Key } from '../machine/keyboard';

export interface KeyEventLike {
  key: string;
  code: string;
  shiftKey: boolean;
}

export interface KeySink {
  press(key: C64Key): void;
  release(key: C64Key): void;
  restore(): void;
}

type ShiftMode = 'on' | 'off' | 'pass';
interface Resolved {
  keys: C64Key[];
  shift: ShiftMode;
}

const SYMBOLS: Record<string, Resolved> = {
  '!': { keys: ['1'], shift: 'on' },
  '"': { keys: ['2'], shift: 'on' },
  '#': { keys: ['3'], shift: 'on' },
  $: { keys: ['4'], shift: 'on' },
  '%': { keys: ['5'], shift: 'on' },
  '&': { keys: ['6'], shift: 'on' },
  "'": { keys: ['7'], shift: 'on' },
  '(': { keys: ['8'], shift: 'on' },
  ')': { keys: ['9'], shift: 'on' },
  '@': { keys: ['AT'], shift: 'off' },
  '*': { keys: ['ASTERISK'], shift: 'off' },
  '+': { keys: ['PLUS'], shift: 'off' },
  '-': { keys: ['MINUS'], shift: 'off' },
  '=': { keys: ['EQUALS'], shift: 'off' },
  ':': { keys: ['COLON'], shift: 'off' },
  ';': { keys: ['SEMICOLON'], shift: 'off' },
  ',': { keys: ['COMMA'], shift: 'off' },
  '.': { keys: ['PERIOD'], shift: 'off' },
  '/': { keys: ['SLASH'], shift: 'off' },
  '<': { keys: ['COMMA'], shift: 'on' },
  '>': { keys: ['PERIOD'], shift: 'on' },
  '?': { keys: ['SLASH'], shift: 'on' },
  '[': { keys: ['COLON'], shift: 'on' },
  ']': { keys: ['SEMICOLON'], shift: 'on' },
  '^': { keys: ['UP_ARROW'], shift: 'off' },
  _: { keys: ['LEFT_ARROW'], shift: 'off' },
  '£': { keys: ['POUND'], shift: 'off' },
  ' ': { keys: ['SPACE'], shift: 'pass' },
};

const SPECIALS: Record<string, Resolved> = {
  Enter: { keys: ['RETURN'], shift: 'pass' },
  Backspace: { keys: ['DEL'], shift: 'pass' },
  Escape: { keys: ['RUN_STOP'], shift: 'pass' },
  Tab: { keys: ['CTRL'], shift: 'pass' },
  ArrowRight: { keys: ['CRSR_RIGHT'], shift: 'pass' },
  ArrowLeft: { keys: ['CRSR_RIGHT'], shift: 'on' },
  ArrowDown: { keys: ['CRSR_DOWN'], shift: 'pass' },
  ArrowUp: { keys: ['CRSR_DOWN'], shift: 'on' },
  Home: { keys: ['HOME'], shift: 'pass' },
  F1: { keys: ['F1'], shift: 'off' },
  F2: { keys: ['F1'], shift: 'on' },
  F3: { keys: ['F3'], shift: 'off' },
  F4: { keys: ['F3'], shift: 'on' },
  F5: { keys: ['F5'], shift: 'off' },
  F6: { keys: ['F5'], shift: 'on' },
  F7: { keys: ['F7'], shift: 'off' },
  F8: { keys: ['F7'], shift: 'on' },
};

function resolve(e: KeyEventLike): Resolved | null {
  if (e.key === 'Control') return e.code === 'ControlLeft' ? { keys: ['COMMODORE'], shift: 'pass' } : null;
  if (Object.hasOwn(SPECIALS, e.key)) return SPECIALS[e.key]!;
  if (e.key.length === 1) {
    if (/^[a-z]$/i.test(e.key)) return { keys: [e.key.toUpperCase() as C64Key], shift: 'pass' };
    if (/^[0-9]$/.test(e.key)) return { keys: [e.key as C64Key], shift: 'off' };
    return Object.hasOwn(SYMBOLS, e.key) ? SYMBOLS[e.key]! : null;
  }
  return null;
}

export class KeyMapper {
  private readonly held = new Map<string, Resolved>();
  private physicalShift = false;
  private readonly applied = new Set<C64Key>();

  constructor(private readonly sink: KeySink) {}

  down(e: KeyEventLike): boolean {
    this.physicalShift = e.shiftKey || e.key === 'Shift';
    if (e.key === 'Shift') {
      this.sync();
      return true;
    }
    if (e.key === 'PageUp') {
      this.sink.restore();
      return true;
    }
    const resolved = resolve(e);
    if (!resolved) return false;
    this.held.set(e.code, resolved);
    this.sync();
    return true;
  }

  up(e: KeyEventLike): boolean {
    this.physicalShift = e.key === 'Shift' ? false : e.shiftKey;
    if (e.key === 'Shift') {
      this.sync();
      return true;
    }
    if (e.key === 'PageUp') return true;
    if (!this.held.delete(e.code)) return false;
    this.sync();
    return true;
  }

  releaseAll(): void {
    this.held.clear();
    this.physicalShift = false;
    this.sync();
  }

  private sync(): void {
    const desired = new Set<C64Key>();
    let forceOn = false;
    let forceOff = false;
    for (const r of this.held.values()) {
      for (const k of r.keys) desired.add(k);
      if (r.shift === 'on') forceOn = true;
      if (r.shift === 'off') forceOff = true;
    }
    const shift = forceOn ? true : forceOff ? false : this.physicalShift;
    if (shift) desired.add('LSHIFT');
    for (const k of this.applied) {
      if (!desired.has(k)) {
        this.sink.release(k);
        this.applied.delete(k);
      }
    }
    for (const k of desired) {
      if (!this.applied.has(k)) {
        this.sink.press(k);
        this.applied.add(k);
      }
    }
  }
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run test/browser && npm run typecheck && npm run lint` → PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(browser): symbolic keyboard mapping with virtual shift" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Browser loader, frame clock and player

**Files:**
- Create: `src/browser/loader.ts`, `src/browser/clock.ts`, `src/browser/player.ts`
- Modify: `src/browser/index.ts`
- Test: `test/browser/loader.test.ts`, `test/browser/clock.test.ts`, `test/browser/player.test.ts`

**Interfaces:**
- Consumes: `C64`, `KeyMapper`, `KeyEventLike`.
- Produces:
  - `type Source`, `class LoadError extends Error { url; status }`, `toBytes(src: Source): Promise<Uint8Array>`.
  - `class FrameClock { advance(nowMs: number): number; reset(): void; static readonly FRAME_RATE }`.
  - `class ReadyTimeoutError extends Error`.
  - `interface PlayerEnv { present(pixels: Uint32Array): void; requestFrame(cb: (nowMs: number) => void): number; cancelFrame(id: number): void; listen(type: 'keydown' | 'keyup' | 'blur', handler: (e: PlayerKeyEvent) => void): () => void }`, `interface PlayerKeyEvent extends KeyEventLike { preventDefault?(): void }`.
  - `class Player { constructor(c64: C64, env: PlayerEnv); readonly c64; running: boolean; pause(); resume(); reset(); load(source: Source, opts?: LoadOptions): Promise<void>; type(text); destroy() }`.
  - `start(options: StartOptions): Promise<Player>`.

- [ ] **Step 1: Write the failing tests**

`test/browser/loader.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoadError, toBytes } from '../../src/browser/loader';

afterEach(() => vi.unstubAllGlobals());

describe('toBytes', () => {
  it('passes Uint8Array through, wraps ArrayBuffer, reads Blob', async () => {
    const u8 = Uint8Array.from([1, 2, 3]);
    expect(await toBytes(u8)).toBe(u8);
    expect([...(await toBytes(u8.buffer))]).toEqual([1, 2, 3]);
    expect([...(await toBytes(new Blob([u8])))]).toEqual([1, 2, 3]);
  });

  it('fetches URLs', async () => {
    vi.stubGlobal('fetch', async () => new Response(Uint8Array.from([9, 8]), { status: 200 }));
    expect([...(await toBytes('http://x/y.prg'))]).toEqual([9, 8]);
  });

  it('rejects non-2xx with LoadError carrying URL and status', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 404 }));
    await expect(toBytes('http://x/missing.prg')).rejects.toMatchObject({
      name: 'LoadError',
      status: 404,
      url: 'http://x/missing.prg',
    });
    await expect(toBytes('http://x/missing.prg')).rejects.toBeInstanceOf(LoadError);
  });

  it('wraps network failures as LoadError with status 0', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('network down');
    });
    await expect(toBytes('http://x/y')).rejects.toMatchObject({ name: 'LoadError', status: 0 });
  });
});
```

`test/browser/clock.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { FrameClock } from '../../src/browser/clock';

describe('FrameClock', () => {
  it('first call primes and returns 0', () => {
    expect(new FrameClock().advance(1000)).toBe(0);
  });

  it('runs about one frame per 19.95 ms and carries the fraction', () => {
    const clock = new FrameClock();
    clock.advance(0);
    let frames = 0;
    for (let t = 16.667; t < 1000; t += 16.667) frames += clock.advance(t);
    expect(frames).toBeGreaterThanOrEqual(49);
    expect(frames).toBeLessThanOrEqual(51);
  });

  it('clamps a huge gap (hidden tab) to at most 5 frames', () => {
    const clock = new FrameClock();
    clock.advance(0);
    expect(clock.advance(60_000)).toBeLessThanOrEqual(5);
  });

  it('negative or zero elapsed time yields 0 frames', () => {
    const clock = new FrameClock();
    clock.advance(100);
    expect(clock.advance(90)).toBe(0);
  });

  it('reset re-primes (used on resume)', () => {
    const clock = new FrameClock();
    clock.advance(0);
    clock.reset();
    expect(clock.advance(500)).toBe(0);
  });
});
```

`test/browser/player.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { Player, ReadyTimeoutError, type PlayerEnv, type PlayerKeyEvent } from '../../src/browser/player';
import { C64 } from '../../src/machine/c64';
import { filled } from '../machine/helpers';

function loopRoms() {
  const kernal = filled(8192, 0xea);
  kernal.set([0x4c, 0x00, 0xe0], 0); // JMP $E000
  kernal[0x1ffc] = 0x00;
  kernal[0x1ffd] = 0xe0;
  return { kernal, basic: filled(8192, 0), chargen: filled(4096, 0) };
}

function fakeEnv() {
  let nextId = 1;
  const callbacks = new Map<number, (now: number) => void>();
  const listeners = new Map<string, (e: PlayerKeyEvent) => void>();
  const presented: Uint32Array[] = [];
  const env: PlayerEnv = {
    present: (p) => void presented.push(p),
    requestFrame: (cb) => {
      const id = nextId++;
      callbacks.set(id, cb);
      return id;
    },
    cancelFrame: (id) => void callbacks.delete(id),
    listen: (type, handler) => {
      listeners.set(type, handler);
      return () => void listeners.delete(type);
    },
  };
  const fire = (now: number) => {
    const pending = [...callbacks.entries()];
    callbacks.clear();
    for (const [, cb] of pending) cb(now);
  };
  return { env, presented, listeners, fire, pending: () => callbacks.size };
}

describe('Player', () => {
  it('runs frames and presents them from the animation callback', () => {
    const f = fakeEnv();
    const player = new Player(new C64(loopRoms()), f.env);
    player.resume();
    f.fire(0);
    f.fire(40);
    expect(f.presented.length).toBeGreaterThanOrEqual(1);
    expect(f.presented[0]).toBe(player.c64.frame.pixels);
  });

  it('pause stops scheduling; resume restarts; destroy cancels and removes listeners', () => {
    const f = fakeEnv();
    const player = new Player(new C64(loopRoms()), f.env);
    player.resume();
    expect(f.pending()).toBe(1);
    player.pause();
    expect(f.pending()).toBe(0);
    player.resume();
    player.destroy();
    expect(f.pending()).toBe(0);
    expect(f.listeners.size).toBe(0);
  });

  it('routes key events to the C64 and prevents default on handled keys', () => {
    const f = fakeEnv();
    const player = new Player(new C64(loopRoms()), f.env);
    let prevented = 0;
    f.listeners.get('keydown')!({ key: 'a', code: 'KeyA', shiftKey: false, preventDefault: () => void prevented++ });
    expect(prevented).toBe(1);
    player.c64.writeIo(0xdc02, 0xff);
    player.c64.writeIo(0xdc00, 0b1111_1101);
    expect(player.c64.peek(0xdc01)).toBe(0b1111_1011);
    f.listeners.get('blur')!({ key: '', code: '', shiftKey: false });
    expect(player.c64.peek(0xdc01)).toBe(0xff);
  });

  it('load rejects with ReadyTimeoutError when READY. never appears, but still copies the program', async () => {
    const f = fakeEnv();
    const player = new Player(new C64(loopRoms()), f.env, { readyFrames: 2 });
    await expect(player.load(Uint8Array.from([0x00, 0xc0, 0x60]))).rejects.toBeInstanceOf(ReadyTimeoutError);
    expect(player.c64.peek(0xc000)).toBe(0x60);
  });

  it('load with READY. on screen copies and starts', async () => {
    const f = fakeEnv();
    const c64 = new C64(loopRoms());
    c64.runFrame();
    [0x12, 0x05, 0x01, 0x04, 0x19, 0x2e].forEach((c, i) => c64.pokeRam(0x0400 + i, c));
    // video matrix defaults to $0000 until the (synthetic) KERNAL sets $D018, so point it at $0400
    c64.writeIo(0xd018, 0x14);
    const player = new Player(c64, f.env);
    await player.load(Uint8Array.from([0x01, 0x08, 0x05]), { run: 'none' });
    expect(c64.peek(0x0801)).toBe(0x05);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/browser` → FAIL (cannot resolve modules).

- [ ] **Step 3: Write the implementations**

`src/browser/loader.ts`:
```ts
export type Source = string | ArrayBuffer | Uint8Array | Blob;

export class LoadError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    message?: string,
  ) {
    super(message ?? `failed to load ${url}: HTTP ${status}`);
    this.name = 'LoadError';
  }
}

export async function toBytes(src: Source): Promise<Uint8Array> {
  if (typeof src === 'string') {
    let res: Response;
    try {
      res = await fetch(src);
    } catch (error) {
      throw new LoadError(src, 0, `failed to load ${src}: ${(error as Error).message}`);
    }
    if (!res.ok) throw new LoadError(src, res.status);
    return new Uint8Array(await res.arrayBuffer());
  }
  if (src instanceof Uint8Array) return src;
  if (src instanceof ArrayBuffer) return new Uint8Array(src);
  return new Uint8Array(await src.arrayBuffer());
}
```

`src/browser/clock.ts`:
```ts
const CYCLES_PER_SECOND = 985_248;
const CYCLES_PER_FRAME = 19_656;
const MAX_FRAMES_PER_TICK = 5;
const MAX_ELAPSED_MS = 100;

export class FrameClock {
  static readonly FRAME_RATE = CYCLES_PER_SECOND / CYCLES_PER_FRAME; // 50.1245 Hz
  private last = -1;
  private acc = 0;

  advance(nowMs: number): number {
    if (this.last < 0) {
      this.last = nowMs;
      return 0;
    }
    let elapsed = nowMs - this.last;
    this.last = nowMs;
    if (elapsed < 0) elapsed = 0;
    if (elapsed > MAX_ELAPSED_MS) elapsed = MAX_ELAPSED_MS;
    this.acc += (elapsed * FrameClock.FRAME_RATE) / 1000;
    const whole = Math.floor(this.acc);
    this.acc -= whole;
    return Math.min(whole, MAX_FRAMES_PER_TICK);
  }

  reset(): void {
    this.last = -1;
    this.acc = 0;
  }
}
```

`src/browser/player.ts`:
```ts
import { C64, type LoadPrgOptions } from '../machine/c64';
import { FrameClock } from './clock';
import { KeyMapper, type KeyEventLike } from './keymap';
import { toBytes, type Source } from './loader';

export class ReadyTimeoutError extends Error {
  constructor(frames: number) {
    super(`the BASIC READY. prompt did not appear within ${frames} frames`);
    this.name = 'ReadyTimeoutError';
  }
}

export interface PlayerKeyEvent extends KeyEventLike {
  preventDefault?(): void;
}

export interface PlayerEnv {
  present(pixels: Uint32Array): void;
  requestFrame(cb: (nowMs: number) => void): number;
  cancelFrame(id: number): void;
  listen(type: 'keydown' | 'keyup' | 'blur', handler: (e: PlayerKeyEvent) => void): () => void;
}

export type LoadOptions = LoadPrgOptions;

export interface PlayerOptions {
  /** Frames to wait for READY. before loading a program (default 600 = 12 s emulated). */
  readyFrames?: number;
}

export class Player {
  running = false;
  private rafId = 0;
  private readonly clock = new FrameClock();
  private readonly mapper: KeyMapper;
  private readonly unlisten: Array<() => void> = [];
  private readonly readyFrames: number;

  constructor(
    readonly c64: C64,
    private readonly env: PlayerEnv,
    options: PlayerOptions = {},
  ) {
    this.readyFrames = options.readyFrames ?? 600;
    this.mapper = new KeyMapper({
      press: (k) => c64.keyDown(k),
      release: (k) => c64.keyUp(k),
      restore: () => c64.restore(),
    });
    this.unlisten.push(
      env.listen('keydown', (e) => {
        if (this.mapper.down(e)) e.preventDefault?.();
      }),
      env.listen('keyup', (e) => {
        if (this.mapper.up(e)) e.preventDefault?.();
      }),
      env.listen('blur', () => this.mapper.releaseAll()),
    );
  }

  resume(): void {
    if (this.running) return;
    this.running = true;
    this.clock.reset();
    this.schedule();
  }

  pause(): void {
    this.running = false;
    if (this.rafId !== 0) this.env.cancelFrame(this.rafId);
    this.rafId = 0;
  }

  reset(): void {
    this.c64.reset();
  }

  type(text: string): void {
    this.c64.type(text);
  }

  async load(source: Source, options: LoadOptions = {}): Promise<void> {
    const bytes = await toBytes(source);
    const ready = this.c64.runUntilReady(this.readyFrames);
    this.c64.loadPrg(bytes, options);
    if (!ready) throw new ReadyTimeoutError(this.readyFrames);
  }

  destroy(): void {
    this.pause();
    this.mapper.releaseAll();
    for (const off of this.unlisten) off();
    this.unlisten.length = 0;
  }

  private schedule(): void {
    this.rafId = this.env.requestFrame((now) => {
      if (!this.running) return;
      const frames = this.clock.advance(now);
      for (let i = 0; i < frames; i++) this.c64.runFrame();
      if (frames > 0) this.env.present(this.c64.frame.pixels);
      this.schedule();
    });
  }
}

export interface StartOptions {
  canvas: string | HTMLCanvasElement;
  roms: { kernal: Source; basic: Source; chargen: Source };
  program?: Source | { source: Source; address?: number; start?: number };
  scale?: number | 'fit';
  keyboardTarget?: 'canvas' | 'document';
}

function isProgramObject(p: NonNullable<StartOptions['program']>): p is {
  source: Source;
  address?: number;
  start?: number;
} {
  return typeof p === 'object' && !(p instanceof Uint8Array) && !(p instanceof ArrayBuffer) && !(p instanceof Blob);
}

export async function start(options: StartOptions): Promise<Player> {
  const canvas =
    typeof options.canvas === 'string'
      ? (document.querySelector(options.canvas) as HTMLCanvasElement | null)
      : options.canvas;
  if (!canvas || typeof canvas.getContext !== 'function') {
    throw new Error(`canvas not found: ${String(options.canvas)}`);
  }
  const [kernal, basic, chargen] = await Promise.all([
    toBytes(options.roms.kernal),
    toBytes(options.roms.basic),
    toBytes(options.roms.chargen),
  ]);
  const c64 = new C64({ kernal, basic, chargen });

  canvas.width = 384;
  canvas.height = 272;
  canvas.style.imageRendering = 'pixelated';
  const scale = options.scale ?? 'fit';
  if (typeof scale === 'number') {
    canvas.style.width = `${384 * scale}px`;
    canvas.style.height = `${272 * scale}px`;
  }
  canvas.tabIndex = 0;
  canvas.addEventListener('click', () => canvas.focus());
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  const image = new ImageData(new Uint8ClampedArray(c64.frame.pixels.buffer), 384, 272);

  const target: EventTarget = options.keyboardTarget === 'document' ? document : canvas;
  const env: PlayerEnv = {
    present: () => ctx.putImageData(image, 0, 0),
    requestFrame: (cb) => requestAnimationFrame(cb),
    cancelFrame: (id) => cancelAnimationFrame(id),
    listen: (type, handler) => {
      const source = type === 'blur' ? canvas : target;
      const fn = handler as unknown as EventListener;
      source.addEventListener(type, fn);
      return () => source.removeEventListener(type, fn);
    },
  };

  const player = new Player(c64, env);
  player.resume();
  if (options.program !== undefined) {
    if (isProgramObject(options.program)) {
      const { source, address, start: startAddress } = options.program;
      const opts: LoadOptions = {};
      if (address !== undefined) opts.address = address;
      if (startAddress !== undefined) opts.start = startAddress;
      await player.load(source, opts);
    } else {
      await player.load(options.program);
    }
  }
  return player;
}
```

`src/browser/index.ts`:
```ts
export { start, Player, ReadyTimeoutError, type StartOptions, type PlayerEnv, type LoadOptions } from './player';
export { LoadError, toBytes, type Source } from './loader';
export { KeyMapper, type KeyEventLike, type KeySink } from './keymap';
export { FrameClock } from './clock';
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/browser && npm run typecheck && npm run lint`
Expected: PASS, clean (the DOM project typechecks `src/browser`).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(browser): loader, frame clock and player with start()" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: OpenROMs test data and the OpenROMs boot conformance tests

**Files:**
- Modify: `scripts/fetch-test-data.mjs`, `scripts/test-data.json` (regenerated for `openroms` only), `docs/test-data-notes.md`
- Create: `test/conformance/c64.test.ts`

**Interfaces:**
- Consumes: `C64`; produces `.testdata/openroms/bin/{kernal_generic,basic_generic,chargen_openroms}.rom`.

- [ ] **Step 1: Teach the fetch script to pin selected sources only**

In `scripts/fetch-test-data.mjs`:
1. Add to `SOURCES`:
```js
  openroms: {
    repo: 'MEGA65/open-roms',
    dest: 'openroms',
    files: [
      'bin/kernal_generic.rom',
      'bin/basic_generic.rom',
      'bin/chargen_openroms.rom',
      'LICENSE',
      'COPYING',
    ],
  },
```
2. Replace the argument handling and main loop so `--pin` accepts optional source names and keeps the other manifest entries:
```js
const args = process.argv.slice(2);
const pin = args.includes('--pin');
const names = args.filter((a) => !a.startsWith('--'));
const selected = names.length > 0 ? names : Object.keys(SOURCES);
for (const n of selected) {
  if (!SOURCES[n]) throw new Error(`unknown source '${n}' (known: ${Object.keys(SOURCES).join(', ')})`);
}

let manifest = {};
try {
  manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
} catch {
  if (!pin) throw new Error(`${MANIFEST} missing: run with --pin first`);
}

for (const name of selected) {
  const source = SOURCES[name];
  const entry = manifest[name];
  if (!pin && !entry) throw new Error(`source '${name}' is not pinned: run with --pin ${name}`);
  const sha = pin ? await headSha(source.repo) : entry.sha;
  console.log(`${name}: ${source.repo}@${sha}`);
  const sums = await fetchSource(source, sha, pin ? null : entry.files);
  if (pin) manifest[name] = { repo: source.repo, sha, files: sums };
}

if (pin) {
  await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`wrote ${MANIFEST}`);
}
console.log('test data ready in .testdata/');
```
(Remove the old `const pin = ...`, `const manifest = {}` and loop.)

- [ ] **Step 2: Pin only `openroms` and verify the others are untouched**

Run:
```bash
cp scripts/test-data.json /tmp/claude-1000/test-data.before.json
node scripts/fetch-test-data.mjs --pin openroms
node -e "const a=require('/tmp/claude-1000/test-data.before.json'),b=require('./scripts/test-data.json');console.log('klaus same:',JSON.stringify(a.klaus)===JSON.stringify(b.klaus),'singlestep same:',JSON.stringify(a.singlestep)===JSON.stringify(b.singlestep));console.log(Object.keys(b))"
node scripts/fetch-test-data.mjs openroms | tail -2
ls -la .testdata/openroms/bin
```
Expected: `klaus same: true singlestep same: true`, keys `klaus, singlestep, openroms`; the three ROMs have sizes 8192, 8192, 4096. If a file name 404s (upstream layout changed), correct it in `SOURCES` and record the change in the commit message.

- [ ] **Step 3: Record the licence**

Read `.testdata/openroms/LICENSE` and `COPYING` and append a section to `docs/test-data-notes.md` naming the licence, whether binary redistribution is permitted, and the consequence for the demo site (this gates only the later Pages phase).

- [ ] **Step 4: Write the failing conformance test**

`test/conformance/c64.test.ts`:
```ts
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { C64 } from '../../src/machine/c64';

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

function runFrames(c64: C64, n: number) {
  for (let i = 0; i < n; i++) c64.runFrame();
}

describe('OpenROMs boot', () => {
  it('reaches the READY. prompt within 600 frames', () => {
    const c64 = new C64(roms());
    expect(c64.runUntilReady(600)).toBe(true);
  });

  it('accepts typed input: PRINT 2+2 prints 4', () => {
    const c64 = new C64(roms());
    expect(c64.runUntilReady(600)).toBe(true);
    c64.type('PRINT 2+2\r');
    runFrames(c64, 60);
    expect(c64.screenText().some((line) => /^\s*4\s*$/.test(line))).toBe(true);
  });

  it('runs a BASIC .prg: 10 PRINT "HI"', () => {
    const c64 = new C64(roms());
    expect(c64.runUntilReady(600)).toBe(true);
    const prg = Uint8Array.from([0x01, 0x08, 0x0b, 0x08, 0x0a, 0x00, 0x99, 0x22, 0x48, 0x49, 0x22, 0x00, 0x00, 0x00]);
    c64.loadPrg(prg);
    runFrames(c64, 120);
    expect(c64.screenText().some((line) => line.trim() === 'HI')).toBe(true);
  });

  it('runs a machine-code .prg via SYS and returns to READY.', () => {
    const c64 = new C64(roms());
    expect(c64.runUntilReady(600)).toBe(true);
    // $C000: LDA #$08 ; STA $0400 ; RTS  (screen code 8 = 'H' in the top-left cell)
    c64.loadPrg(Uint8Array.from([0x00, 0xc0, 0xa9, 0x08, 0x8d, 0x00, 0x04, 0x60]));
    runFrames(c64, 120);
    expect(c64.peek(0x0400)).toBe(0x08);
    const readyCount = c64.screenText().filter((l) => l.includes('READY.')).length;
    expect(readyCount).toBeGreaterThanOrEqual(1);
    expect(c64.cpu.halted).toBe(false);
  });
});
```

- [ ] **Step 5: Run it and fix the machine until it passes**

Run: `npm run test:conformance -- c64`
Expected on first run: the boot test may FAIL (timeout waiting for `READY.`). This is the documented risk: OpenROMs may use chip behaviour not yet modelled. Debug with `systematic-debugging`: dump `c64.screenText()`, `c64.cpu.regs.pc` and the last few PCs; check what the KERNAL polls (raster register, CIA flags, SID, IEC lines, `$D012` loops, TOD). Fix in the machine layer (`vic.ts`, `cia.ts`, `bus.ts`), adding a unit test for each real behaviour you discover. Do **not** loosen the conformance assertions.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "test(conformance): boot OpenROMs to READY., type input and run PRGs" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Example page, static server, README, bundles and browser acceptance

**Files:**
- Create: `examples/basic.html`, `scripts/serve.mjs`
- Modify: `README.md`, `docs/test-data-notes.md` (if needed)

**Interfaces:**
- Consumes: built `dist/f6502.min.js`, `.testdata/openroms/bin/*.rom`.

- [ ] **Step 1: Write the static server**

`scripts/serve.mjs`:
```js
// Dependency-free static file server for local development: `npm run example`.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(process.cwd());
const port = Number(process.env.PORT ?? 8080);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.rom': 'application/octet-stream',
  '.prg': 'application/octet-stream',
  '.css': 'text/css; charset=utf-8',
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let path = normalize(decodeURIComponent(url.pathname));
    if (path.endsWith('/')) path += 'index.html';
    const file = resolve(join(root, path));
    if (!file.startsWith(root + '/') && file !== root) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`serving ${root} at http://127.0.0.1:${port}/ (try /examples/basic.html)`);
});
```

- [ ] **Step 2: Write the example page**

`examples/basic.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>f6502 - C64 in the browser</title>
    <style>
      body { background: #222; color: #ddd; font-family: sans-serif; text-align: center; }
      canvas { background: #000; margin-top: 1rem; outline: none; }
      #status { min-height: 1.5rem; }
    </style>
  </head>
  <body>
    <h1>f6502</h1>
    <canvas id="screen"></canvas>
    <p id="status">loading...</p>
    <p>
      Click the screen to focus it, then type. Load a program:
      <input id="prg" type="file" accept=".prg" />
    </p>
    <script src="../dist/f6502.min.js"></script>
    <script>
      const status = document.getElementById('status');
      const roms = {
        kernal: '../.testdata/openroms/bin/kernal_generic.rom',
        basic: '../.testdata/openroms/bin/basic_generic.rom',
        chargen: '../.testdata/openroms/bin/chargen_openroms.rom',
      };
      const prg = new URLSearchParams(location.search).get('prg');
      F6502.start({ canvas: '#screen', roms, scale: 2, ...(prg ? { program: prg } : {}) })
        .then((player) => {
          status.textContent = 'running';
          window.player = player;
          document.getElementById('prg').addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (file) await player.load(file);
          });
        })
        .catch((error) => {
          status.textContent = error.name + ': ' + error.message;
        });
    </script>
  </body>
</html>
```

- [ ] **Step 3: Update `README.md`**

Replace the status paragraph and add a "Browser usage" section:

````markdown
Status: the cycle-accurate 6502 core, a C64 machine skeleton (memory map, CIAs, keyboard, VIC-II
text mode) and the browser layer are implemented. Bitmap/sprite graphics, sound, disk and the demo
site are planned (see `docs/superpowers/specs/`).

## Browser usage

```html
<canvas id="screen"></canvas>
<script src="f6502.min.js"></script>
<script>
  F6502.start({
    canvas: '#screen',
    roms: { kernal: 'kernal.rom', basic: 'basic.rom', chargen: 'chargen.rom' },
    program: 'game.prg', // optional
  });
</script>
```

ROMs are never bundled: supply your own or the free [OpenROMs](https://github.com/MEGA65/open-roms)
(`npm run fetch-test-data` downloads them to `.testdata/openroms/`). Cross-origin URLs need CORS
headers. Try it locally with `npm run build && npm run example`, then open
`http://127.0.0.1:8080/examples/basic.html`.
````

Add a row to the scripts table: `npm run example` | serves the repo for `examples/basic.html`.

- [ ] **Step 4: Full verification gate**

First format the new files (`npx prettier --write examples scripts README.md docs`), then run, in order, with a shell that word-splits (use `bash -c`):
```bash
bash -c 'for c in "npm run -s lint" "npm run -s typecheck" "npm test" "npm run -s test:conformance" "npm run -s build" "npm run -s bench"; do echo "=== $c"; out=$($c 2>&1); code=$?; echo "$out" | grep -E "Tests |Test Files|rror|Prettier|success|MHz" | head -6; echo "exit: $code"; done'
node --input-type=module -e "import('./dist/index.js').then(m=>console.log('exports:', ['C64','start','MOS6502'].map(k=>k+':'+typeof m[k]).join(' ')))"
node -e "const vm=require('node:vm'),fs=require('node:fs');const ctx={};vm.createContext(ctx);vm.runInContext(fs.readFileSync('dist/f6502.min.js','utf8')+';this.out=[typeof F6502.C64,typeof F6502.start].join()',ctx);console.log('iife:',ctx.out)"
```
Expected: every command exits 0; ESM exports `C64:function start:function MOS6502:function`; IIFE prints `iife: function,function`.

- [ ] **Step 5: Headless throughput guard**

Run:
```bash
node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { C64 } from './dist/index.js';
const d='.testdata/openroms/bin/';
const c=new C64({kernal:readFileSync(d+'kernal_generic.rom'),basic:readFileSync(d+'basic_generic.rom'),chargen:readFileSync(d+'chargen_openroms.rom')});
const t=performance.now(); for(let i=0;i<500;i++) c.runFrame(); const s=(performance.now()-t)/1000;
console.log('500 frames in',s.toFixed(2),'s =',(500/50.1245/s).toFixed(0),'x real time');"
```
Expected: at least 10x real time (guard, reported not gated).

- [ ] **Step 6: Browser acceptance (real browser, screenshots)**

1. Start the server in the background: `npm run build && npm run example` (port 8080).
2. With the Playwright (or Claude-in-Chrome) browser tools: open `http://127.0.0.1:8080/examples/basic.html`; wait about 3 s; take a screenshot (expect the C64 boot screen with `READY.`).
3. Click the canvas, type `PRINT "HELLO"` + Enter, screenshot (expect `HELLO` printed and a new `READY.`).
4. Write a throwaway BASIC program next to the page and load it by URL:
   `node -e "require('fs').writeFileSync('examples/hello.prg', Buffer.from([0x01,0x08,0x14,0x08,0x0a,0x00,0x99,0x22,0x48,0x49,0x20,0x46,0x52,0x4f,0x4d,0x20,0x50,0x52,0x47,0x22,0x00,0x00,0x00]))"`
   (`10 PRINT "HI FROM PRG"`), open `http://127.0.0.1:8080/examples/basic.html?prg=hello.prg`, wait about 3 s, screenshot (expect `HI FROM PRG` and `READY.`). Delete `examples/hello.prg` afterwards; it is not committed.
5. Attach the three screenshots to the PR description. If a step fails, capture the browser console (`read_console_messages`) and fix before proceeding; do not hand-wave a failed acceptance.
6. Stop the server.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: example page, static server, README and verified bundles for the C64 machine" -m "Gates: lint, typecheck, unit, conformance, build, bench, browser acceptance." -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Spec coverage check

| Spec requirement | Task |
|---|---|
| Layering, boundary rule (`machine/` may not import `browser/`) | 1 |
| Memory map, PLA banking, 6510 port, ROM validation, power-on RAM, peek, VIC memory view | 2 |
| CIA timers, ICR, TOD, port DDRs, IRQ/NMI wiring | 3, 7 |
| Keyboard matrix (both scan directions, reference counted), palette | 4 |
| VIC registers, raster/IRQ, text mode, border/windows, XSCROLL, counters, framebuffer | 5 |
| PRG parsing and raw binaries | 6 |
| `C64` API: frame loop, `runUntilReady`, `type`, `loadPrg` (BASIC pointers / typed SYS), RESTORE | 7 |
| Symbolic keymap with virtual shift, special keys | 8 |
| Loader/LoadError, frame clock, Player, `start()`, `ReadyTimeoutError` | 9 |
| OpenROMs pinned test data, licence note, boot/type/PRG conformance | 10 |
| Example page, static server, README, bundles, browser acceptance, throughput guard | 11 |
| SID stub, joystick inputs read 1, IEC idle | 2, 7 |
| CI and Pages excluded | explicitly excluded |

Additions beyond the spec's listed API (diagnostic only): `C64.screenText()`, `C64.isReady()`, `C64.pokeRam()`, `C64.writeIo()`.
