// Builds examples/demo.d64: a blank disk with one tokenised BASIC program, HELLO.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { D64, petscii } from '../dist/index.js';

export function buildDemoD64() {
  const text = 'HELLO FROM DISK';
  const body = [0x99, 0x22, ...petscii(text), 0x22, 0x00]; // PRINT"..."
  const next = 0x0801 + 4 + body.length;
  const prg = Uint8Array.from([
    0x01,
    0x08,
    next & 0xff,
    next >> 8,
    0x0a,
    0x00,
    ...body,
    0x00,
    0x00,
  ]);
  const d = D64.format('F6502 DEMO', '01');
  d.writeFile(petscii('HELLO'), 2, prg);
  return d.export();
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'demo.d64');
  const img = buildDemoD64();
  writeFileSync(out, img);
  console.log(`wrote ${out} (${img.length} bytes)`);
}
