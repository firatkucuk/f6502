// Builds examples/sid-test.prg: a tiny machine-code program (load $C000, start with
// SYS 49152) that plays a 440 Hz triangle tone on voice 1 at full volume and then idles.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LOAD = 0xc000;
const SID = 0xd400;

export function buildSidPrg() {
  const code = [];
  const lda = (v) => code.push(0xa9, v);
  const sta = (a) => code.push(0x8d, a & 0xff, a >> 8);
  const freq = Math.round((440 * 16777216) / 985248); // $1D44
  lda(0x0f);
  sta(SID + 0x18); // volume 15
  lda(freq & 0xff);
  sta(SID + 0x00);
  lda(freq >> 8);
  sta(SID + 0x01);
  lda(0x00);
  sta(SID + 0x02);
  lda(0x08);
  sta(SID + 0x03); // pulse width (unused by the triangle)
  lda(0x09);
  sta(SID + 0x05); // attack 0, decay 9
  lda(0xf0);
  sta(SID + 0x06); // sustain 15, release 0
  lda(0x11);
  sta(SID + 0x04); // triangle + gate
  const loop = LOAD + code.length;
  code.push(0x4c, loop & 0xff, loop >> 8); // JMP *
  return Uint8Array.from([LOAD & 0xff, LOAD >> 8, ...code]);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'sid-test.prg');
  const prg = buildSidPrg();
  writeFileSync(out, prg);
  console.log(`wrote ${out} (${prg.length} bytes)`);
}
