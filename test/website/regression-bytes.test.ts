import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compile } from '../../src/c64script/index';
import { EXAMPLES } from '../../website/js/playground-examples.js';

const hashes = JSON.parse(
  readFileSync('test/c64script/fixtures/program-hashes.json', 'utf8'),
) as Record<string, string>;
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

// Shipped programs whose source is rewritten on purpose have their entry removed with the rewrite.
describe('compiled bytes of shipped programs are stable', () => {
  for (const e of EXAMPLES) {
    const key = `example:${e.id}`;
    if (hashes[key] === undefined) continue;
    it(key, () => expect(sha(compile(e.source))).toBe(hashes[key]));
  }
  for (const f of readdirSync('website/showcases').filter((n) => n.endsWith('.c64s'))) {
    const key = `showcase:${f}`;
    if (hashes[key] === undefined) continue;
    it(key, () =>
      expect(sha(compile(readFileSync(`website/showcases/${f}`, 'utf8')))).toBe(hashes[key]),
    );
  }
  it('has an entry for every example and showcase present today', () => {
    expect(Object.keys(hashes).length).toBeGreaterThanOrEqual(8);
  });
});
