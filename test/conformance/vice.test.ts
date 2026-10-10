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
  return {
    kernal: read('kernal_generic.rom'),
    basic: read('basic_generic.rom'),
    chargen: read('chargen_openroms.rom'),
  };
}

/** Number of differing pixels between our frame and the reference (RGB must match exactly). */
function diff(c64: C64, referencePath: string): number {
  const ref = decodePng(new Uint8Array(readFileSync(referencePath)));
  if (ref.width !== 384 || ref.height !== 272) {
    throw new Error(`reference ${referencePath} is ${ref.width}x${ref.height}, expected 384x272`);
  }
  const pixels = c64.frame.pixels;
  let different = 0;
  for (let i = 0; i < 384 * 272; i++) {
    const v = pixels[i]!;
    const r = v & 0xff;
    const g = (v >> 8) & 0xff;
    const b = (v >> 16) & 0xff;
    if (r !== ref.data[i * 4] || g !== ref.data[i * 4 + 1] || b !== ref.data[i * 4 + 2]) {
      different++;
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
      c64.loadPrg(new Uint8Array(readFileSync(prg)));
      for (let i = 0; i < (entry.frames ?? 200); i++) c64.runFrame();
      const mismatches = diff(c64, reference);
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
      }
    });
  }
});
