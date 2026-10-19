import { describe, expect, it } from 'vitest';
import { VicII } from '../../src/machine/vic';

/** A VIC that records every g-access address; character ROM is $1000-$1fff (bank 0). */
function world() {
  const ram = new Uint8Array(0x4000);
  const reads: { addr: number; raster: number; cycle: number }[] = [];
  let vic!: VicII;
  vic = new VicII({
    readMem: (a) => {
      reads.push({ addr: a, raster: vic.raster, cycle: vic.debug.cycle });
      return ram[a & 0x3fff]!;
    },
    readColor: () => 0,
    isCharRom: (a) => a >= 0x1000 && a < 0x2000,
  });
  return { vic, ram, reads };
}

/** Ticks until the next tick will process `cycle` of `raster`. */
function runTo(vic: VicII, raster: number, cycle: number): void {
  while (!(vic.raster === raster && vic.debug.cycle === cycle)) vic.tick();
}

/** g-access address in `cycle` of raster 51 (first badline), $D011 write `d011` before `at`. */
function gAddress(start: number, d011: number, at: number, cycle: number): number {
  const { vic, ram, reads } = world();
  ram.fill(0x41, 0x0400, 0x0800); // screen code $41 everywhere
  vic.write(0x18, 0x14); // video matrix $0400, character base $1000 (ROM), bitmap base $0000
  vic.write(0x11, start);
  vic.write(0x16, 0x08);
  runTo(vic, 51, at);
  vic.write(0x11, d011);
  reads.length = 0;
  runTo(vic, 51, cycle + 1);
  return reads.find((r) => r.raster === 51 && r.cycle === cycle)!.addr;
}

describe('g-access address and the video mode', () => {
  it('text fetches use the character set, bitmap fetches the bitmap base ($0000 here)', () => {
    // cell 4 is fetched in cycle 20: vc = 4, rc = 0
    expect(gAddress(0x1b, 0x1b, 10, 20)).toBe(0x1000 + (0x41 << 3));
    expect(gAddress(0x3b, 0x3b, 10, 20)).toBe(4 << 3);
  });

  it('BMM written just before the fetch is seen by it as the OR of the new and the old value', () => {
    // BMM set before cycle 20: fetched as bitmap straight away
    expect(gAddress(0x1b, 0x3b, 20, 20)).toBe(4 << 3);
    // BMM cleared before cycle 20: the fetch still uses the bitmap, but the change from RAM to
    // character ROM latches the low byte from the bitmap address and the high bits from the text
    expect(gAddress(0x3b, 0x1b, 20, 20)).toBe(
      ((4 << 3) & 0xff) | ((0x1000 + (0x41 << 3)) & 0x3f00),
    );
  });

  it('one cycle later the old mode is gone', () => {
    expect(gAddress(0x3b, 0x1b, 20, 21)).toBe(0x1000 + (0x41 << 3) + 0);
  });
});
