import { describe, expect, it } from 'vitest';
import { VicII } from '../../src/machine/vic';
import { VicSprites as Sprites } from '../../src/machine/vic-sprites';

function rig() {
  const regs = new Uint8Array(0x40);
  const ram = new Uint8Array(0x4000);
  const sprites = new Sprites(regs, { readMem: (a) => ram[a & 0x3fff]! });
  regs[0x18] = 0x10;
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
  it('is cleared when DMA turns on and counts three bytes per row up to 63', () => {
    const r = rig();
    enable(r, 0, 100, 50);
    r.sprites.mcBase[0] = 17; // stale value from an earlier sprite: DMA start must clear it
    const seen: number[] = [];
    for (let raster = 40; raster <= 80; raster++) {
      line(r, raster);
      seen.push(r.sprites.mcBase[0]);
    }
    expect(seen[seen.indexOf(Math.max(...seen)) - 1]).toBe(60);
    expect(Math.max(...seen)).toBe(63);
    expect(r.sprites.dma[0]).toBe(0); // 63 ends DMA
  });

  it('wraps as a 6-bit counter', () => {
    const r = rig();
    enable(r, 0, 100, 50);
    r.sprites.mcBase[0] = 61;
    r.sprites.dma[0] = 1;
    line(r, 40); // cycle 15: 61 + 2 = 63, cycle 16: + 1 wraps to 0 (63 is only checked after it)
    expect(r.sprites.mcBase[0]).toBe(0);
    expect(r.sprites.dma[0]).toBe(1);
  });
});

describe('sprite crunch', () => {
  /** Y-expanded sprite; returns mcBase after the cycle-16 of the line where expandFF is 0. */
  function mcBaseAfterLine(clearAt: number | null) {
    const r = rig();
    enable(r, 0, 100, 50);
    r.regs[0x17] = 0x01;
    for (let raster = 40; raster <= 52; raster++) line(r, raster);
    // line 53: on a Y-expanded sprite the flip-flop alternates, so find a line with it cleared
    const before = r.sprites.mcBase[0]!;
    line(
      r,
      53,
      clearAt === null
        ? undefined
        : {
            cycle: clearAt,
            fn: () => {
              r.regs[0x17] = 0;
              r.sprites.yExpandWritten(0); // what VicII.write does
            },
          },
    );
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
    const r = rig();
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
    const r = rig();
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

describe('X-expand switched mid-sprite', () => {
  it('continues from the current source pixel instead of rewinding', () => {
    const r = rig();
    r.regs[0x15] = 0x01;
    r.regs[0] = 96;
    r.regs[1] = 50;
    r.ram[0x07f8] = 0x40;
    for (let row = 0; row < 21; row++) {
      r.ram.set([0x92, 0x49, 0x24], 0x40 * 64 + row * 3); // source pixel i set when i % 3 == 0
    }
    for (let raster = 40; raster <= 51; raster++) line(r, raster);
    // Cycle 25 covers X 96..103: switch to X-expand once it has been drawn.
    const masks = line(r, 52, { cycle: 25, fn: () => (r.regs[0x1d] = 0x01) });
    expect(masks.slice(96, 104)).toEqual([1, 0, 0, 1, 0, 0, 1, 0]); // source pixels 0..7
    // Expanded from X=104: source pixel 8, 9, 10, 11, 12 each two pixels wide.
    expect(masks.slice(104, 114)).toEqual([0, 0, 1, 1, 0, 0, 0, 0, 1, 1]);
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
