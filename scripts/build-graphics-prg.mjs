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
  fillBytes(0x0c00, 63, 0xff); // sprite data 0: solid 24x21
  fillBytes(0x0c40, 63, 0x1b); // sprite data 1: multicolour pairs 00 01 10 11 on every byte

  for (let n = 0; n < 8; n++) poke(0x07f8 + n, n === 2 || n === 6 ? 0x31 : 0x30);

  // [X low byte, Y] per sprite; sprite 5 also needs X bit 8 ($D010) for X = 296.
  const positions = [
    [40, 60], // 0: hi-res, overlaps sprite 1
    [48, 64], // 1: hi-res
    [120, 60], // 2: multicolour
    [180, 60], // 3: X-expanded
    [250, 60], // 4: Y-expanded
    [296 & 0xff, 100], // 5: 9th X bit, behind foreground
    [200, 140], // 6: multicolour, X-expanded
    [100, 180], // 7: plain
  ];
  positions.forEach(([x, y], n) => {
    poke(0xd000 + 2 * n, x);
    poke(0xd001 + 2 * n, y);
  });
  [1, 2, 5, 4, 8, 2, 13, 7].forEach((colour, n) => poke(0xd027 + n, colour));
  poke(0xd025, 7); // multicolour 0
  poke(0xd026, 3); // multicolour 1
  poke(0xd010, 0x20); // X bit 8 of sprite 5
  poke(0xd01b, 0x20); // sprite 5 behind foreground
  poke(0xd01c, 0x44); // sprites 2 and 6 multicolour
  poke(0xd01d, 0x48); // sprites 3 and 6 X-expanded
  poke(0xd017, 0x10); // sprite 4 Y-expanded
  poke(0xd015, 0xff); // enable all eight

  poke(0xd020, 0x00); // border black
  poke(0xd021, 0x06); // background blue
  poke(0xd011, 0x3b); // bitmap mode, DEN, RSEL, YSCROLL 3
  poke(0xd016, 0x18); // multicolour, 40 columns
  poke(0xd018, 0x18); // matrix $0400, bitmap $2000

  label('wait');
  b(0xad, 0x1e, 0xd0); // LDA $D01E (reading clears it)
  beq('wait');
  sta(0x0341); // keep the first sprite-sprite collision value (A still holds it)

  label('late');
  b(0xad, 0x12, 0xd0); // LDA $D012
  b(0xc9, 0xd0); // CMP #$D0
  b(0x90, 0); // BCC late (patched below)
  fixups.push({ at: code.length - 1, name: 'late', kind: 'rel' });
  b(0xad, 0x1f, 0xd0); // LDA $D01F: every sprite has overlapped the bitmap by now
  sta(0x0340);
  poke(0xd020, 0x0e); // done: border light blue
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
