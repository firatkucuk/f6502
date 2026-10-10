// Builds examples/graphics-test.prg: a tiny machine-code program (load $C000, start with
// SYS 49152) that exercises the VIC-II: multicolour bitmap, two overlapping sprites, and a
// border-colour change when the sprite-sprite collision register becomes non-zero.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LOAD = 0xc000;

export function buildGraphicsPrg() {
  const code = [];
  const labels = new Map();
  const fixups = [];
  let nextLabel = 0;
  const lo = (v) => v & 0xff;
  const hi = (v) => (v >> 8) & 0xff;
  const b = (...bytes) => code.push(...bytes);
  const lda = (v) => b(0xa9, v);
  const ldx = (v) => b(0xa2, v);
  const ldy = (v) => b(0xa0, v);
  const sta = (a) => b(0x8d, lo(a), hi(a));
  const staZp = (z) => b(0x85, z);
  const staIndY = (z) => b(0x91, z);
  const incZp = (z) => b(0xe6, z);
  const iny = () => b(0xc8);
  const dex = () => b(0xca);
  const label = (name) => labels.set(name, code.length);
  const bne = (name) => {
    b(0xd0, 0);
    fixups.push({ at: code.length - 1, name, kind: 'rel' });
  };
  const beq = (name) => {
    b(0xf0, 0);
    fixups.push({ at: code.length - 1, name, kind: 'rel' });
  };
  const jmp = (name) => {
    b(0x4c, 0, 0);
    fixups.push({ at: code.length - 2, name, kind: 'abs' });
  };

  /** Fills `pages` 256-byte pages starting at `start` with `value`, through zero page $FB/$FC. */
  const fillPages = (start, pages, value) => {
    const loop = `fill${nextLabel++}`;
    lda(lo(start));
    staZp(0xfb);
    lda(hi(start));
    staZp(0xfc);
    ldy(0);
    ldx(pages);
    label(loop);
    lda(value);
    staIndY(0xfb);
    iny();
    bne(loop);
    incZp(0xfc);
    dex();
    bne(loop);
  };

  /** Fills `count` (<= 255) bytes at `start` with `value`. */
  const fillBytes = (start, count, value) => {
    const loop = `bytes${nextLabel++}`;
    ldy(0);
    label(loop);
    lda(value);
    b(0x99, lo(start), hi(start)); // STA start,Y
    iny();
    b(0xc0, count); // CPY #count
    bne(loop);
  };

  /** LDA #value / STA addr. */
  const poke = (addr, value) => {
    lda(value);
    sta(addr);
  };

  b(0x78); // SEI: freeze the KERNAL IRQ so the screen stays static

  fillPages(0x2000, 32, 0x1b); // bitmap: pairs 00 01 10 11 on every row
  fillPages(0x0400, 4, 0x1c); // video matrix: hi nibble 1 (white), lo nibble 12 (grey)
  fillPages(0xd800, 4, 0x05); // colour RAM: green
  fillBytes(0x0c00, 63, 0xff); // sprite data: solid 24x21

  for (let n = 0; n < 8; n++) poke(0x07f8 + n, 0x30); // sprite data at $0C00 (pointer 0x30 * 64)

  poke(0xd000, 40); // sprite 0 X
  poke(0xd001, 60); // sprite 0 Y
  poke(0xd002, 48); // sprite 1 X
  poke(0xd003, 64); // sprite 1 Y
  poke(0xd027, 1); // sprite 0 colour: white
  poke(0xd028, 2); // sprite 1 colour: red
  poke(0xd015, 0x03); // enable sprites 0 and 1

  poke(0xd020, 0x00); // border black
  poke(0xd021, 0x06); // background blue
  poke(0xd011, 0x3b); // bitmap mode, DEN, RSEL, YSCROLL 3
  poke(0xd016, 0x18); // multicolour, 40 columns
  poke(0xd018, 0x18); // matrix $0400, bitmap $2000

  label('wait');
  b(0xad, 0x1e, 0xd0); // LDA $D01E (reading clears it)
  beq('wait');
  poke(0xd020, 0x0e); // collision seen: border light blue
  label('spin');
  jmp('spin');

  for (const f of fixups) {
    const target = labels.get(f.name);
    if (target === undefined) throw new Error(`undefined label ${f.name}`);
    if (f.kind === 'rel') {
      const rel = target - (f.at + 1);
      if (rel < -128 || rel > 127) throw new Error(`branch to ${f.name} out of range`);
      code[f.at] = rel & 0xff;
    } else {
      code[f.at] = lo(LOAD + target);
      code[f.at + 1] = hi(LOAD + target);
    }
  }
  return Uint8Array.from([lo(LOAD), hi(LOAD), ...code]);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'graphics-test.prg');
  const prg = buildGraphicsPrg();
  writeFileSync(out, prg);
  console.log(`wrote ${out} (${prg.length} bytes)`);
}
