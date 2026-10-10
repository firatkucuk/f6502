import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { C64 } from '../../src/machine/c64';

type Check =
  | { type: 'mem'; addr: number; bytes: number[] }
  | { type: 'screen'; contains: string }
  | { type: 'border'; colour: number };

interface Entry {
  name: string;
  prg: string; // relative to .testdata/sidtests
  model: '6581' | '8580';
  frames?: number;
  /** Where the expected values come from (readme, datasheet). Required: no self-referential oracles. */
  source: string;
  checks: Check[];
  /** 'pass' or 'known-fail:<reason>' */
  expect: string;
  /** Known-fail only: the exact number of failing checks. */
  failing?: number;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '.testdata');
const ROMS = join(ROOT, 'openroms', 'bin');
const SID = join(ROOT, 'sidtests');
const manifest = JSON.parse(readFileSync(join(HERE, 'sid-tests.json'), 'utf8')) as Entry[];
const REPORT = process.env.SID_REPORT === '1';

function roms() {
  const read = (name: string) => new Uint8Array(readFileSync(join(ROMS, name)));
  return {
    kernal: read('kernal_generic.rom'),
    basic: read('basic_generic.rom'),
    chargen: read('chargen_openroms.rom'),
  };
}

/** Screen RAM ($0400) as text: screen codes 1-26 -> A-Z, $20-$3F as ASCII, others '.'. */
function screenText(c64: C64): string {
  let out = '';
  for (let row = 0; row < 25; row++) {
    let line = '';
    for (let col = 0; col < 40; col++) {
      const code = c64.peek(0x0400 + row * 40 + col) & 0x7f;
      if (code >= 1 && code <= 26) line += String.fromCharCode(64 + code);
      else if (code >= 0x20 && code <= 0x3f) line += String.fromCharCode(code);
      else line += code === 0 ? '@' : '.';
    }
    out += line.trimEnd() + '\n';
  }
  return out;
}

function runChecks(c64: C64, entry: Entry): string[] {
  const failures: string[] = [];
  const text = screenText(c64);
  for (const check of entry.checks) {
    if (check.type === 'mem') {
      const got = check.bytes.map((_, i) => c64.peek(check.addr + i));
      if (got.some((v, i) => v !== check.bytes[i])) {
        failures.push(
          `mem $${check.addr.toString(16)}: expected ${check.bytes.join(',')} got ${got.join(',')}`,
        );
      }
    } else if (check.type === 'screen') {
      if (!text.includes(check.contains)) failures.push(`screen lacks "${check.contains}"`);
    } else if ((c64.peek(0xd020) & 0x0f) !== check.colour) {
      failures.push(`border != ${check.colour}`);
    }
  }
  return failures;
}

describe('VICE SID reference programs', () => {
  it('has a manifest', () => {
    expect(Array.isArray(manifest)).toBe(true);
  });

  for (const entry of manifest) {
    it(`${entry.name} (${entry.expect})`, () => {
      const prg = join(SID, entry.prg);
      if (!existsSync(prg)) throw new Error(`${prg} missing: run "npm run fetch-test-data"`);
      expect(
        entry.source.length,
        'entry needs an independent source for its expected values',
      ).toBeGreaterThan(0);
      const c64 = new C64(roms(), { sid: { model: entry.model } });
      expect(c64.runUntilReady(600)).toBe(true);
      c64.loadPrg(new Uint8Array(readFileSync(prg)));
      for (let i = 0; i < (entry.frames ?? 200); i++) c64.runFrame();
      const failures = runChecks(c64, entry);
      if (REPORT)
        console.log(`SID ${entry.name}: ${failures.length} failing checks ${failures.join(' | ')}`);
      if (entry.expect === 'pass') {
        expect(failures, entry.name).toEqual([]);
      } else {
        expect(entry.expect.startsWith('known-fail:')).toBe(true);
        expect(failures.length, `${entry.name} now passes: remove the known-fail`).toBeGreaterThan(
          0,
        );
        expect(failures.length, `${entry.name}: failing checks changed`).toBe(entry.failing);
      }
    });
  }
});
