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
      return 0;
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
    // The counter wraps in cycle 2 of line 0, so measure from one wrap to the next.
    let f = vic.frameCount;
    while (vic.frameCount === f) vic.tick();
    f = vic.frameCount;
    let cycles = 0;
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
    expect(vic.read(0x19) & 0x81).toBe(0x81); // flag and bit 7 are visible at once
    expect(vic.irq).toBe(false); // the line reaches the CPU one cycle later
    runCycles(vic, 1);
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
    w.glyphs.set(1, new Array<number>(8).fill(0x80)); // only the leftmost pixel set
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
    const raster = () => w.vic.raster;
    while (raster() !== 260) w.vic.tick();
    expect(w.vic.debug.vcBase).toBe(1000);
    while (raster() !== 1) w.vic.tick();
    expect(w.vic.debug.vcBase).toBe(0);
  });
});

describe('light pen', () => {
  function until(vic: VicII, raster: number, nextCycle: number) {
    while (!(vic.raster === raster && vic.debug.cycle === nextCycle)) vic.tick();
  }

  it('latches X and Y one cycle after the pin goes low and raises IRQ flag 3', () => {
    const { vic } = world();
    vic.write(0x1a, 0x08);
    until(vic, 100, 21); // cycle 20 has been processed
    vic.setLightPen(true);
    expect(vic.irq).toBe(false);
    vic.tick(); // cycle 21 latches
    // X of cycle 21 is 400 + 20 * 8 = 560 - 504 = 56 pixels, halved, plus the 6569R3 offset of 2
    expect(vic.read(0x13)).toBe(56 / 2 + 2);
    expect(vic.read(0x14)).toBe(100);
    expect(vic.read(0x19) & 0x08).toBe(0x08);
    vic.tick();
    expect(vic.irq).toBe(true);
  });

  it('latches only once per frame', () => {
    const { vic } = world();
    until(vic, 100, 21);
    vic.setLightPen(true);
    vic.tick();
    vic.setLightPen(false);
    until(vic, 120, 30);
    vic.setLightPen(true);
    vic.tick();
    expect(vic.read(0x14)).toBe(100);
  });

  it('a pen still held low latches again at the start of the next frame, at X $D1, Y 0', () => {
    const { vic } = world();
    until(vic, 100, 21);
    vic.setLightPen(true);
    vic.tick();
    const frame = vic.frameCount;
    while (vic.frameCount === frame) vic.tick();
    expect(vic.read(0x13)).toBe(0xd1);
    expect(vic.read(0x14)).toBe(0);
  });
});
