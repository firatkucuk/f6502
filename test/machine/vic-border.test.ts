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
