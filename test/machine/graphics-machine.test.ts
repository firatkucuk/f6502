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
