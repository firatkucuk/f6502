import { describe, expect, it } from 'vitest';
import { PALETTE } from '../../src/machine/palette';
import { cellX, px, runFrames, vicWorld } from './vic-helpers';

const P = (i: number) => PALETTE[i]!;

type World = ReturnType<typeof vicWorld>;

function setup(w: World, d011 = 0x1b) {
  w.vic.write(0x11, d011);
  w.vic.write(0x16, 0x08);
  w.vic.write(0x18, 0x12); // matrix $0400, char base $0800
  w.vic.write(0x20, 0x0e); // border light blue
  w.vic.write(0x21, 0x06); // background blue
}

/** Sprite `n` with a solid 24x21 shape at (x, y), 9th X bit included. */
function solid(w: World, n: number, x: number, y: number, colour: number) {
  const ptr = 0x40 + n;
  w.ram[0x07f8 + n] = ptr;
  w.ram.fill(0xff, ptr * 64, ptr * 64 + 63);
  w.vic.write(2 * n, x & 0xff);
  w.vic.write(1 + 2 * n, y);
  w.vic.write(0x10, (w.vic.peek(0x10) & ~(1 << n)) | (x & 0x100 ? 1 << n : 0));
  w.vic.write(0x27 + n, colour);
  w.vic.write(0x15, w.vic.peek(0x15) | (1 << n));
}

describe('idle-state foreground flag', () => {
  // YSCROLL = 7: the window top is raster 51 but the first badline is raster 55, so
  // rasters 51-54 are idle lines inside the window (framebuffer rows 36-39).
  it('idle graphics count as foreground: they hide a sprite behind them and collide with it', () => {
    const w = vicWorld();
    setup(w, 0x1f);
    w.ram[0x3fff] = 0xff; // idle access: all pixels set
    solid(w, 0, 24, 50, 1); // first sprite row on raster 51, an idle line
    w.vic.write(0x1b, 0x01); // sprite 0 behind the foreground
    runFrames(w.vic, 2);
    expect(px(w.vic, cellX(0, 0), 36)).toBe(P(0)); // idle pixel (black) wins over the sprite
    expect(w.vic.peek(0x1f) & 1).toBe(1);
  });

  it('idle pixels with the bit clear are not foreground', () => {
    const w = vicWorld();
    setup(w, 0x1f);
    w.ram[0x3fff] = 0x00;
    solid(w, 0, 24, 50, 1);
    w.vic.write(0x1b, 0x01);
    runFrames(w.vic, 2);
    expect(px(w.vic, cellX(0, 0), 36)).toBe(P(1)); // sprite shows through
    expect(w.vic.peek(0x1f) & 1).toBe(0);
  });
});

describe('sprite rows on rasters Y+1 .. Y+21 (pixel level)', () => {
  it('a sprite at Y = 60 starts on framebuffer row 46 and ends on row 66', () => {
    const w = vicWorld();
    setup(w);
    solid(w, 0, 24, 60, 1);
    runFrames(w.vic, 2);
    const x = cellX(0, 0);
    expect(px(w.vic, x, 45)).toBe(P(6)); // raster Y: not yet displayed
    expect(px(w.vic, x, 46)).toBe(P(1)); // raster Y+1: first row
    expect(px(w.vic, x, 66)).toBe(P(1)); // raster Y+21: last row
    expect(px(w.vic, x, 67)).toBe(P(6));
  });
});

describe('collisions in invisible cycles', () => {
  it('two sprites overlapping at X = 400 (outside the visible area) still collide', () => {
    const w = vicWorld();
    setup(w);
    solid(w, 0, 400, 100, 1);
    solid(w, 1, 405, 100, 2);
    runFrames(w.vic, 2);
    expect(w.vic.peek(0x1e)).toBe(0b11);
    expect(w.vic.peek(0x19) & 0x04).toBe(0x04); // sprite-sprite IRQ flag
  });
});

describe('sprite throughput', () => {
  it('eight sprites run faster than real time (guard against a large regression)', () => {
    const w = vicWorld();
    setup(w);
    for (let n = 0; n < 8; n++) solid(w, n, 40 + n * 20, 60 + n * 10, n + 1);
    const frames = 100; // 2 s of PAL time
    const start = performance.now();
    runFrames(w.vic, frames);
    const seconds = (performance.now() - start) / 1000;
    expect(seconds).toBeLessThan(frames / 50);
  });
});
