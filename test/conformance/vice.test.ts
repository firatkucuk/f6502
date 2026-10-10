import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { C64 } from '../../src/machine/c64';
import { decodePng } from './png';

interface Entry {
  name: string;
  prg: string; // relative to .testdata/vicetests
  reference: string;
  frames?: number;
  /** Number of differing pixels tolerated (default 0). */
  tolerance?: number;
  /**
   * Rectangles [x0, y0, x1, y1] (reference pixels, inclusive) excluded from the comparison: the
   * test's text label, whose glyph shapes come from the stock character ROM we do not have.
   */
  ignore?: [number, number, number, number][];
  /** Known-fail only: the exact number of differing pixels; any change (better or worse) fails. */
  mismatches?: number;
  /** 'pass' or 'known-fail:<reason>' */
  expect: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '.testdata');
const ROMS = join(ROOT, 'openroms', 'bin');
const VICE = join(ROOT, 'vicetests');
const manifest = JSON.parse(readFileSync(join(HERE, 'vice-tests.json'), 'utf8')) as Entry[];
const REPORT = process.env.VICE_REPORT === '1';

function roms() {
  const read = (name: string) => {
    const file = join(ROMS, name);
    if (!existsSync(file)) throw new Error(`${file} missing: run "npm run fetch-test-data"`);
    return new Uint8Array(readFileSync(file));
  };
  const kernal = read('kernal_generic.rom');
  // OpenROMs' IRQ entry ($EA53) takes 36 cycles to reach the $0314 handler, the stock KERNAL's
  // ($FF48) 29. Cycle-exact programs install handlers via $0314, so use the stock sequence.
  kernal.set(
    [
      0x48, 0x8a, 0x48, 0x98, 0x48, 0xba, 0xbd, 0x04, 0x01, 0x29, 0x10, 0xf0, 0x03, 0x6c, 0x16,
      0x03, 0x6c, 0x14, 0x03,
    ],
    0xea53 - 0xe000,
  );
  return {
    kernal,
    basic: read('basic_generic.rom'),
    chargen: read('chargen_openroms.rom'),
  };
}

/**
 * The VICE test programs assume the start-up state the stock KERNAL leaves behind: its VIC-II
 * initialisation table (light blue border, sprite colours 1..7), the upper-case character set
 * and a light blue cursor colour. OpenROMs leaves different values; restore the stock ones.
 */
function stockKernalState(c64: C64): void {
  // The bus is private: the harness pokes I/O registers the way a program would.
  const { bus } = c64 as unknown as { bus: { write(addr: number, value: number): void } };
  const write = (addr: number, value: number) => bus.write(addr, value);
  write(0xd018, 0x14);
  write(0xd020, 0x0e);
  write(0xd021, 0x06);
  [0x01, 0x02, 0x03, 0x04, 0x00].forEach((v, i) => write(0xd022 + i, v));
  for (let n = 0; n < 8; n++) write(0xd027 + n, n + 1);
  write(0x0286, 0x0e);
  for (let i = 0; i < 1000; i++) write(0xd800 + i, 0x0e);
}

/** Number of differing pixels between our frame and the reference (RGB must match exactly). */
function diff(c64: C64, referencePath: string, ignore: Entry['ignore'] = []): number {
  const ref = decodePng(new Uint8Array(readFileSync(referencePath)));
  if (ref.width !== 384 || ref.height !== 272) {
    throw new Error(`reference ${referencePath} is ${ref.width}x${ref.height}, expected 384x272`);
  }
  const pixels = c64.frame.pixels;
  // The VICE screenshots start at raster line 16, ours at 15: ours row y+1 is the reference row y.
  let different = 0;
  for (let y = 0; y < 271; y++) {
    for (let x = 0; x < 384; x++) {
      const v = pixels[(y + 1) * 384 + x]!;
      const i = y * 384 + x;
      if (ignore.some(([x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1)) continue;
      const r = v & 0xff;
      const g = (v >> 8) & 0xff;
      const b = (v >> 16) & 0xff;
      if (r !== ref.data[i * 4] || g !== ref.data[i * 4 + 1] || b !== ref.data[i * 4 + 2]) {
        different++;
      }
    }
  }
  return different;
}

describe('VICE VIC-II reference screenshots', () => {
  it('has a manifest', () => {
    expect(Array.isArray(manifest)).toBe(true);
  });

  for (const entry of manifest) {
    it(`${entry.name} (${entry.expect})`, () => {
      const prg = join(VICE, entry.prg);
      const reference = join(VICE, entry.reference);
      if (!existsSync(prg) || !existsSync(reference)) {
        throw new Error(`${entry.name}: files missing, run "npm run fetch-test-data"`);
      }
      const c64 = new C64(roms());
      expect(c64.runUntilReady(600)).toBe(true);
      stockKernalState(c64);
      c64.loadPrg(new Uint8Array(readFileSync(prg)));
      for (let i = 0; i < (entry.frames ?? 200); i++) c64.runFrame();
      const mismatches = diff(c64, reference, entry.ignore);
      if (REPORT) console.log(`VICE ${entry.name}: ${mismatches} differing pixels`);
      const tolerance = entry.tolerance ?? 0;
      if (entry.expect === 'pass') {
        expect(mismatches, `${entry.name}: differing pixels`).toBeLessThanOrEqual(tolerance);
      } else {
        expect(
          entry.expect.startsWith('known-fail:'),
          'expect must be pass or known-fail:<reason>',
        ).toBe(true);
        expect(
          mismatches,
          `${entry.name} is marked known-fail but now matches: remove the known-fail`,
        ).toBeGreaterThan(tolerance);
        expect(
          mismatches,
          `${entry.name}: differing pixels changed (was ${entry.mismatches}); re-measure with VICE_REPORT=1 and update the manifest`,
        ).toBe(entry.mismatches);
      }
    });
  }
});
