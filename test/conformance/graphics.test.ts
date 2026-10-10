import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildGraphicsPrg } from '../../scripts/build-graphics-prg.mjs';
import { C64 } from '../../src/machine/c64';
import { PALETTE } from '../../src/machine/palette';
import { FRAME_WIDTH } from '../../src/machine/vic';

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

const P = (i: number) => PALETTE[i]!;

describe('graphics-test.prg on OpenROMs', () => {
  it('shows a multicolour bitmap, eight sprites of every kind and the collision indicator', () => {
    const c64 = new C64(roms());
    expect(c64.runUntilReady(600)).toBe(true);
    c64.loadPrg(buildGraphicsPrg());
    for (let i = 0; i < 300; i++) c64.runFrame();
    const at = (x: number, y: number) => c64.frame.pixels[y * FRAME_WIDTH + x]!;
    // Sprite (X, Y) appears at framebuffer (X + 8, Y - 14); bitmap cells are 8 pixels wide with
    // pairs 00 -> $D021 (6), 01 -> hi nibble (1), 10 -> lo nibble (12), 11 -> colour RAM (5).

    // the program saw the sprite-sprite collision and then changed the border to light blue
    expect(at(0, 0)).toBe(P(14));
    // multicolour bitmap row with no sprite
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((i) => at(32 + i, 100))).toEqual([
      P(6),
      P(6),
      P(1),
      P(1),
      P(12),
      P(12),
      P(5),
      P(5),
    ]);
    // sprites 0 and 1 (hi-res, overlapping): lower number wins in the overlap
    expect(at(48, 46)).toBe(P(1));
    expect(at(56, 50)).toBe(P(1));
    expect(at(75, 52)).toBe(P(2));
    // sprite 2: multicolour (pairs 00 transparent, 01 $D025=7, 10 own=5, 11 $D026=3)
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((i) => at(128 + i, 46))).toEqual([
      P(6),
      P(6),
      P(7),
      P(7),
      P(5),
      P(5),
      P(3),
      P(3),
    ]);
    // sprite 3: X-expanded, 48 pixels wide (x 188..235), colour 4
    expect(at(188, 46)).toBe(P(4));
    expect(at(235, 46)).toBe(P(4));
    expect(at(236, 46)).toBe(P(12)); // bitmap again
    // sprite 4: Y-expanded, 42 rows (y 46..87), colour 8
    expect(at(258, 46)).toBe(P(8));
    expect(at(258, 87)).toBe(P(8));
    expect(at(258, 88)).toBe(P(1)); // bitmap again
    // sprite 5: 9th X bit (X=296) and behind-foreground: hidden over pairs 10/11 only
    expect(at(304, 86)).toBe(P(2));
    expect(at(306, 86)).toBe(P(2));
    expect(at(308, 86)).toBe(P(12));
    expect(at(310, 86)).toBe(P(5));
    // sprite 6: multicolour and X-expanded (pairs 4 pixels wide), own colour 13, $D026 = 3
    expect(at(212, 126)).toBe(P(7));
    expect(at(216, 126)).toBe(P(13));
    expect(at(220, 126)).toBe(P(3));
    // sprite 7: plain, colour 7
    expect(at(108, 166)).toBe(P(7));
    // registers captured by the program: $D01F (sprite-background) at $0340 and the first
    // $D01E (sprite-sprite, only sprites 0 and 1 overlap) at $0341
    expect(c64.peek(0x0340)).toBe(0xff);
    expect(c64.peek(0x0341)).toBe(0x03);
  });
});
