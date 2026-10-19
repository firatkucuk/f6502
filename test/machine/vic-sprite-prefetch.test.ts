import { describe, expect, it } from 'vitest';
import { PALETTE } from '../../src/machine/palette';
import type { VicII } from '../../src/machine/vic';
import { px, runFrames, vicWorld } from './vic-helpers';

/** Ticks until the next tick will process `cycle` of `raster`. */
function runTo(vic: VicII, raster: number, cycle: number): void {
  while (!(vic.raster === raster && vic.debug.cycle === cycle)) vic.tick();
}

/** Sprite 0 (all data bytes $00) at Y=50 is enabled just before `cycle` of line 50. */
function firstRow(cycle: number, busWriteCycle?: number): number {
  const { vic, ram } = vicWorld();
  vic.write(0x11, 0x1b);
  vic.write(0x18, 0x12);
  vic.write(0x20, 0x0e);
  vic.write(0x21, 0x06);
  ram[0x07f8] = 0x40;
  vic.write(0x00, 88);
  vic.write(0x01, 50);
  vic.write(0x27, 1);
  runFrames(vic, 2);
  runTo(vic, 50, cycle);
  vic.write(0x15, 0x01);
  if (busWriteCycle !== undefined) {
    runTo(vic, 50, busWriteCycle);
    vic.write(0x2f, 0x7f); // the CPU leaves $7f on the VIC's bus
  }
  while (vic.raster !== 52) vic.tick();
  return px(vic, 96, 51 - 15); // first pixel of the sprite's first row
}

describe('sprite byte 0 is read from the idle bus while the BA prefetch window is open', () => {
  it('a sprite enabled before cycle 55 has BA low for three cycles and reads its data', () => {
    expect(firstRow(55)).toBe(PALETTE[6]!);
  });

  it('a sprite enabled before cycle 56 gets BA one cycle late, so byte 0 reads $ff', () => {
    expect(firstRow(56)).toBe(PALETTE[1]!);
  });
});

describe('a sprite access that cannot fetch takes the byte the CPU left on the bus', () => {
  it('byte 0 is the value written to a VIC register in the following cycle', () => {
    expect(firstRow(56, 59)).toBe(PALETTE[6]!); // bit 7 of $7f is clear
  });

  it('without a bus write byte 0 is $ff (idle bus)', () => {
    expect(firstRow(56)).toBe(PALETTE[1]!);
  });
});
