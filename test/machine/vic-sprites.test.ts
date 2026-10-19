import { describe, expect, it } from 'vitest';
import { VicSprites as Sprites } from '../../src/machine/vic-sprites';

function rig() {
  const regs = new Uint8Array(0x40);
  const ram = new Uint8Array(0x4000);
  const sprites = new Sprites(regs, { readMem: (a) => ram[a & 0x3fff]! });
  sprites.mcBase.fill(0);
  regs[0x18] = 0x10; // video matrix at $0400 -> sprite pointers at $07F8
  return { regs, ram, sprites };
}

interface LineResult {
  masks: number[]; // opaque-sprite mask per raster X
  colors: number[][]; // colours per raster X
  activeAt30: number;
}

/** Runs one whole line in the same order as VicII.tick. */
function runLine(sprites: Sprites, raster: number, regs?: Uint8Array): LineResult {
  const masks = new Array<number>(504).fill(0);
  const colors = new Array<number[]>(504).fill([]);
  let activeAt30 = 0;
  for (let c = 1; c <= 63; c++) {
    sprites.cycle(c, raster);
    if (c === 30) activeAt30 = sprites.active;
    const x0 = ((((c - 12) * 8 + 496) % 504) + 504) % 504;
    sprites.drawCycle(c, x0);
    for (let i = 0; i < 8; i++) {
      const x = (x0 + i) % 504;
      masks[x] = sprites.outMask[i]!;
      // colour of the lowest-numbered sprite with a pixel, stored at its own index
      const cols = new Array<number>(8).fill(0);
      if (sprites.outMask[i] !== 0 && regs) {
        const n = sprites.outLow[i]!;
        const pix = sprites.outPix[i]!;
        cols[n] = regs[pix === 1 ? 0x25 : pix === 3 ? 0x26 : 0x27 + n]! & 0x0f;
      }
      colors[x] = cols;
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
      if (runLine(r.sprites, raster, r.regs).activeAt30 & 1) shown.push(raster);
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
      if (runLine(r.sprites, raster, r.regs).activeAt30 & 1) shown.push(raster);
    }
    expect(shown[0]).toBe(51);
    expect(shown).toHaveLength(42);
  });

  it('a disabled sprite never starts', () => {
    const r = rig();
    setSprite(r, 0, { x: 100, y: 50 });
    r.regs[0x15] = 0;
    for (let raster = 40; raster <= 90; raster++) {
      expect(runLine(r.sprites, raster, r.regs).activeAt30).toBe(0);
    }
  });
});

describe('fetch addresses and rows', () => {
  it('uses the pointer at VM+$3F8+n and data at pointer*64, three bytes per row', () => {
    const r = rig();
    setSprite(r, 0, { x: 100, y: 20, ptr: 0x41, row0: [0xf0, 0x0f, 0x81] });
    r.ram[0x41 * 64 + 3] = 0x80; // row 1, byte 0
    for (let raster = 15; raster <= 20; raster++) runLine(r.sprites, raster, r.regs);
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
    for (let raster = 15; raster <= 20; raster++) runLine(r.sprites, raster, r.regs);
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
    for (let raster = 15; raster <= 20; raster++) runLine(r.sprites, raster, r.regs);
    const line = runLine(r.sprites, 21, r.regs);
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
    for (let raster = 15; raster <= 20; raster++) runLine(r.sprites, raster, r.regs);
    const m = runLine(r.sprites, 21).masks;
    expect([100, 101, 146, 147].map((x) => m[x])).toEqual([1, 1, 1, 1]);
    expect([99, 102, 145, 148].map((x) => m[x])).toEqual([0, 0, 0, 0]);
  });

  it('the 9th X bit places a sprite at X >= 256', () => {
    const r = rig();
    setSprite(r, 0, { x: 300, y: 20, row0: [0x80, 0, 0] });
    for (let raster = 15; raster <= 20; raster++) runLine(r.sprites, raster, r.regs);
    const m = runLine(r.sprites, 21).masks;
    expect(m[300]).toBe(1);
    expect(m[44]).toBe(0);
  });
});

describe('line wrap and invisible X', () => {
  it('a sprite starting at X=490 wraps: its tail shows at X=0..9', () => {
    const r = rig();
    setSprite(r, 0, { x: 490, y: 20 });
    for (let raster = 15; raster <= 20; raster++) runLine(r.sprites, raster, r.regs);
    const m = runLine(r.sprites, 21).masks;
    expect([490, 503, 0, 9].map((x) => m[x])).toEqual([1, 1, 1, 1]);
    expect(m[10]).toBe(0);
    expect(m[489]).toBe(0);
  });

  it('X = 504..511 never matches a PAL raster X', () => {
    const r = rig();
    setSprite(r, 0, { x: 504, y: 20 });
    for (let raster = 15; raster <= 20; raster++) runLine(r.sprites, raster, r.regs);
    expect(runLine(r.sprites, 21).masks.every((m) => m === 0)).toBe(true);
  });
});
