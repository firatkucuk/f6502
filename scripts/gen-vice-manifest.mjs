// Lists every fetched PAL test that has a reference screenshot and writes a candidate manifest
// (expect: "pass") to test/conformance/vice-tests.json for classification.
import { readdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VICE = join(ROOT, '.testdata', 'vicetests');
const entries = [];
for (const dir of readdirSync(join(VICE, 'VICII'), { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const refs = join(VICE, 'VICII', dir.name, 'references');
  if (!existsSync(refs)) continue;
  for (const ref of readdirSync(refs).filter((f) => f.endsWith('.prg.png'))) {
    const prg = ref.slice(0, -'.png'.length);
    if (!existsSync(join(VICE, 'VICII', dir.name, prg))) continue;
    entries.push({
      name: `${dir.name}/${prg}`,
      prg: `VICII/${dir.name}/${prg}`,
      reference: `VICII/${dir.name}/references/${ref}`,
      expect: 'pass',
    });
  }
}
writeFileSync(
  join(ROOT, 'test', 'conformance', 'vice-tests.json'),
  JSON.stringify(entries, null, 2) + '\n',
);
console.log(`wrote ${entries.length} candidates`);
