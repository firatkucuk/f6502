// Prints the hash table used by test/c64script/regression-bytes.test.ts.
// Run: npx tsx scripts/hash-programs.mjs > test/c64script/fixtures/program-hashes.json
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { compile } from '../src/c64script/index.ts';
import { EXAMPLES } from '../website/js/playground-examples.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const out = {};
for (const e of EXAMPLES) out[`example:${e.id}`] = sha(compile(e.source));
for (const f of readdirSync('website/showcases').filter((n) => n.endsWith('.c64s'))) {
  out[`showcase:${f}`] = sha(compile(readFileSync(`website/showcases/${f}`, 'utf8')));
}
console.log(JSON.stringify(out, null, 2));
