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
  it('shows a multicolour bitmap, two overlapping sprites and the collision indicator', () => {
    const c64 = new C64(roms());
    expect(c64.runUntilReady(600)).toBe(true);
    c64.loadPrg(buildGraphicsPrg());
    for (let i = 0; i < 200; i++) c64.runFrame();
    const at = (x: number, y: number) => c64.frame.pixels[y * FRAME_WIDTH + x]!;

    // collision indicator: the program switched the border to light blue
    expect(at(0, 0)).toBe(P(14));
    // multicolour bitmap row (no sprite there): 00 -> $D021 (6), 01 -> hi nibble (1),
    // 10 -> lo nibble (12), 11 -> colour RAM (5)
    const row = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => at(32 + i, 100));
    expect(row).toEqual([P(6), P(6), P(1), P(1), P(12), P(12), P(5), P(5)]);
    // sprite 0 (colour 1) at X=40,Y=60 -> framebuffer (48, 46)
    expect(at(48, 46)).toBe(P(1));
    // overlap of sprites 0 and 1 shows the lower-numbered sprite 0
    expect(at(56, 50)).toBe(P(1));
    // sprite 1 only (colour 2): X=48,Y=64 -> x 56..79, rows from 50; right of sprite 0 (x<72)
    expect(at(75, 52)).toBe(P(2));
  });
});
