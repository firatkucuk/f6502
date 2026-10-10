import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { C64 } from '../../src/machine/c64';
import { buildSidPrg } from '../../scripts/build-sid-prg.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROMS = join(HERE, '..', '..', '.testdata', 'openroms', 'bin');
const read = (n: string) => new Uint8Array(readFileSync(join(ROMS, n)));

describe('examples/sid-test.prg on the OpenROMs boot', () => {
  it('plays a 440 Hz tone', () => {
    const c64 = new C64({
      kernal: read('kernal_generic.rom'),
      basic: read('basic_generic.rom'),
      chargen: read('chargen_openroms.rom'),
    });
    expect(c64.runUntilReady(600)).toBe(true);
    c64.loadPrg(buildSidPrg());
    for (let i = 0; i < 50; i++) c64.runFrame(); // the typed SYS runs, the envelope settles
    const out = new Float32Array(c64.sid.sampleRate);
    c64.sid.drainSamples(out); // discard the start-up
    for (let i = 0; i < 50; i++) c64.runFrame();
    const n = c64.sid.drainSamples(out);
    expect(n).toBeGreaterThan(40000);
    let crossings = 0;
    let peak = 0;
    for (let i = 1; i < n; i++) {
      if (out[i - 1]! < 0 && out[i]! >= 0) crossings++;
      peak = Math.max(peak, Math.abs(out[i]!));
    }
    const hz = (crossings * c64.sid.sampleRate) / n;
    expect(hz).toBeGreaterThan(435);
    expect(hz).toBeLessThan(445);
    expect(peak).toBeGreaterThan(0.05);
    expect(peak).toBeLessThanOrEqual(1);
  });
});
