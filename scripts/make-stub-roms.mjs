// Generates legally-clean stub ROM files for the f6502 Nyan Cat showcase.
// These are original files — NOT derived from Commodore ROMs — and contain
// only the minimal code needed to boot into our PRG at $0810.
//
// Output (in website/demos/):
//   kernal.bin   8192 bytes  — minimal init + RESET vector → $0810
//   basic.bin    8192 bytes  — all RTS (nothing calls BASIC from our PRG)
//   chargen.bin  4096 bytes  — 8×8 pixel glyphs for A-Z, 0-9, space, solid block
//
// Run: node scripts/make-stub-roms.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'website', 'demos');
mkdirSync(outDir, { recursive: true });

// ── KERNAL (8192 bytes, loaded at $E000-$FFFF) ────────────────────────────────
// Boot sequence compatible with f6502's player.load() mechanism:
//
//   player.load() works in two phases:
//     1. runUntilReady()  — runs CPU frames until "READY." appears on screen
//     2. applyPrg()       — copies PRG bytes to RAM, then types "SYS 2064\r"
//                           into the keyboard buffer ($00C6 / $0277)
//
//   So the KERNAL must:
//     a. Write "READY." to screen (screen codes: R=18 E=5 A=1 D=4 Y=25 .=46)
//        at row 5 col 0 = $04C8, matching screenCodeToChar() in c64.ts
//     b. Poll $00C6 (keyboard buffer count) until non-zero
//     c. JMP $0810 — by this point the PRG has been written to RAM
//
// $E000: RTI         — NMI/IRQ handler
// $E001-$E025: init + READY + wait loop
// $FFFA-$FFFF: hardware vectors
{
  const kernal = new Uint8Array(8192).fill(0xEA); // NOP fill
  let p = 0;

  // $E000: RTI (NMI/IRQ handler — just return)
  kernal[p++] = 0x40;

  // $E001: init
  kernal[p++] = 0xA9; kernal[p++] = 0x2F; // LDA #$2F
  kernal[p++] = 0x85; kernal[p++] = 0x00; // STA $00  (6510 port direction)
  kernal[p++] = 0xA9; kernal[p++] = 0x37; // LDA #$37
  kernal[p++] = 0x85; kernal[p++] = 0x01; // STA $01  (KERNAL+BASIC+IO enabled)
  kernal[p++] = 0xA9; kernal[p++] = 0x1B; // LDA #$1B
  kernal[p++] = 0x8D; kernal[p++] = 0x11; kernal[p++] = 0xD0; // STA $D011 (screen on)
  kernal[p++] = 0xA9; kernal[p++] = 0x15; // LDA #$15
  kernal[p++] = 0x8D; kernal[p++] = 0x18; kernal[p++] = 0xD0; // STA $D018 (screen at $0400)

  // Write "READY." to screen RAM at $04C8 (row 5, col 0)
  // Screen codes: R=18, E=5, A=1, D=4, Y=25, .=46
  kernal[p++] = 0xA9; kernal[p++] = 18;   // LDA #18 (R)
  kernal[p++] = 0x8D; kernal[p++] = 0xC8; kernal[p++] = 0x04; // STA $04C8
  kernal[p++] = 0xA9; kernal[p++] = 5;    // LDA #5  (E)
  kernal[p++] = 0x8D; kernal[p++] = 0xC9; kernal[p++] = 0x04; // STA $04C9
  kernal[p++] = 0xA9; kernal[p++] = 1;    // LDA #1  (A)
  kernal[p++] = 0x8D; kernal[p++] = 0xCA; kernal[p++] = 0x04; // STA $04CA
  kernal[p++] = 0xA9; kernal[p++] = 4;    // LDA #4  (D)
  kernal[p++] = 0x8D; kernal[p++] = 0xCB; kernal[p++] = 0x04; // STA $04CB
  kernal[p++] = 0xA9; kernal[p++] = 25;   // LDA #25 (Y)
  kernal[p++] = 0x8D; kernal[p++] = 0xCC; kernal[p++] = 0x04; // STA $04CC
  kernal[p++] = 0xA9; kernal[p++] = 46;   // LDA #46 (.)
  kernal[p++] = 0x8D; kernal[p++] = 0xCD; kernal[p++] = 0x04; // STA $04CD

  // Poll $00C6 (keyboard buffer count) — non-zero means applyPrg() has run
  // and the PRG bytes are already at $0810.
  const waitAddr = p; // remember loop top (relative to $E000)
  kernal[p++] = 0xA5; kernal[p++] = 0xC6; // LDA $C6 (zero-page keyboard buffer count)
  kernal[p++] = 0xF0; kernal[p++] = 0xFC; // BEQ waitAddr (back 4 bytes = loop)

  // PRG is loaded — jump into it
  kernal[p++] = 0x4C; kernal[p++] = 0x10; kernal[p++] = 0x08; // JMP $0810

  // Hardware vectors at $FFFA-$FFFF (offset 0x1FFA from $E000)
  const VECS = 0x1FFA;
  kernal[VECS + 0] = 0x00; kernal[VECS + 1] = 0xE0; // NMI  → $E000 (RTI)
  kernal[VECS + 2] = 0x01; kernal[VECS + 3] = 0xE0; // RESET → $E001 (init)
  kernal[VECS + 4] = 0x00; kernal[VECS + 5] = 0xE0; // IRQ  → $E000 (RTI)

  writeFileSync(join(outDir, 'kernal.bin'), kernal);
  console.log('wrote kernal.bin  (8192 bytes)');
}

// ── BASIC (8192 bytes, loaded at $A000-$BFFF) ────────────────────────────────
// All RTS ($60). Our PRG never calls any BASIC routine.
{
  const basic = new Uint8Array(8192).fill(0x60);
  writeFileSync(join(outDir, 'basic.bin'), basic);
  console.log('wrote basic.bin   (8192 bytes)');
}

// ── CHARGEN (4096 bytes) ──────────────────────────────────────────────────────
// 256 characters × 8 bytes each.
// Only the characters our program uses need real glyphs:
//   Screen codes 1-26  → A-Z
//   Screen codes 48-57 → 0-9
//   Screen code  32    → space (all zeros)
//   Screen code  42    → * (asterisk / star)
//   Screen code  46    → . (period)
//   Screen code 160    → $A0 solid block (used for rainbow trail)
{
  const chargen = new Uint8Array(4096).fill(0x00);

  // Helper: set glyph for screen code sc
  const glyph = (sc, rows) => {
    const off = sc * 8;
    for (let i = 0; i < 8; i++) chargen[off + i] = rows[i] ?? 0;
  };

  // A (sc=1)
  glyph(1,  [0x18, 0x3C, 0x66, 0x7E, 0x66, 0x66, 0x66, 0x00]);
  // B (sc=2)
  glyph(2,  [0x7C, 0x66, 0x66, 0x7C, 0x66, 0x66, 0x7C, 0x00]);
  // C (sc=3)
  glyph(3,  [0x3C, 0x66, 0x60, 0x60, 0x60, 0x66, 0x3C, 0x00]);
  // D (sc=4)
  glyph(4,  [0x78, 0x6C, 0x66, 0x66, 0x66, 0x6C, 0x78, 0x00]);
  // E (sc=5)
  glyph(5,  [0x7E, 0x60, 0x60, 0x7C, 0x60, 0x60, 0x7E, 0x00]);
  // F (sc=6)
  glyph(6,  [0x7E, 0x60, 0x60, 0x7C, 0x60, 0x60, 0x60, 0x00]);
  // G (sc=7)
  glyph(7,  [0x3C, 0x66, 0x60, 0x6E, 0x66, 0x66, 0x3E, 0x00]);
  // H (sc=8)
  glyph(8,  [0x66, 0x66, 0x66, 0x7E, 0x66, 0x66, 0x66, 0x00]);
  // I (sc=9)
  glyph(9,  [0x3C, 0x18, 0x18, 0x18, 0x18, 0x18, 0x3C, 0x00]);
  // J (sc=10)
  glyph(10, [0x1E, 0x0C, 0x0C, 0x0C, 0x0C, 0x6C, 0x38, 0x00]);
  // K (sc=11)
  glyph(11, [0x66, 0x6C, 0x78, 0x70, 0x78, 0x6C, 0x66, 0x00]);
  // L (sc=12)
  glyph(12, [0x60, 0x60, 0x60, 0x60, 0x60, 0x60, 0x7E, 0x00]);
  // M (sc=13)
  glyph(13, [0x63, 0x77, 0x7F, 0x6B, 0x63, 0x63, 0x63, 0x00]);
  // N (sc=14)
  glyph(14, [0x66, 0x76, 0x7E, 0x7E, 0x6E, 0x66, 0x66, 0x00]);
  // O (sc=15)
  glyph(15, [0x3C, 0x66, 0x66, 0x66, 0x66, 0x66, 0x3C, 0x00]);
  // P (sc=16)
  glyph(16, [0x7C, 0x66, 0x66, 0x7C, 0x60, 0x60, 0x60, 0x00]);
  // Q (sc=17)
  glyph(17, [0x3C, 0x66, 0x66, 0x66, 0x6E, 0x3C, 0x0E, 0x00]);
  // R (sc=18)
  glyph(18, [0x7C, 0x66, 0x66, 0x7C, 0x6C, 0x66, 0x66, 0x00]);
  // S (sc=19)
  glyph(19, [0x3C, 0x66, 0x60, 0x3C, 0x06, 0x66, 0x3C, 0x00]);
  // T (sc=20)
  glyph(20, [0x7E, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x00]);
  // U (sc=21)
  glyph(21, [0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x3C, 0x00]);
  // V (sc=22)
  glyph(22, [0x66, 0x66, 0x66, 0x66, 0x66, 0x3C, 0x18, 0x00]);
  // W (sc=23)
  glyph(23, [0x63, 0x63, 0x63, 0x6B, 0x7F, 0x77, 0x63, 0x00]);
  // X (sc=24)
  glyph(24, [0x66, 0x66, 0x3C, 0x18, 0x3C, 0x66, 0x66, 0x00]);
  // Y (sc=25)
  glyph(25, [0x66, 0x66, 0x66, 0x3C, 0x18, 0x18, 0x18, 0x00]);
  // Z (sc=26)
  glyph(26, [0x7E, 0x06, 0x0C, 0x18, 0x30, 0x60, 0x7E, 0x00]);

  // space (sc=32) — all zeros (already zero-filled)

  // * asterisk (sc=42)
  glyph(42, [0x00, 0x66, 0x3C, 0xFF, 0x3C, 0x66, 0x00, 0x00]);

  // . period (sc=46)
  glyph(46, [0x00, 0x00, 0x00, 0x00, 0x00, 0x18, 0x18, 0x00]);

  // 0 (sc=48)
  glyph(48, [0x3C, 0x66, 0x6E, 0x76, 0x66, 0x66, 0x3C, 0x00]);
  // 1 (sc=49)
  glyph(49, [0x18, 0x38, 0x18, 0x18, 0x18, 0x18, 0x7E, 0x00]);
  // 2 (sc=50)
  glyph(50, [0x3C, 0x66, 0x06, 0x0C, 0x30, 0x60, 0x7E, 0x00]);
  // 3 (sc=51)
  glyph(51, [0x3C, 0x66, 0x06, 0x1C, 0x06, 0x66, 0x3C, 0x00]);
  // 4 (sc=52)
  glyph(52, [0x0C, 0x1C, 0x3C, 0x6C, 0x7E, 0x0C, 0x0C, 0x00]);
  // 5 (sc=53)
  glyph(53, [0x7E, 0x60, 0x7C, 0x06, 0x06, 0x66, 0x3C, 0x00]);
  // 6 (sc=54)
  glyph(54, [0x1C, 0x30, 0x60, 0x7C, 0x66, 0x66, 0x3C, 0x00]);
  // 7 (sc=55)
  glyph(55, [0x7E, 0x06, 0x0C, 0x18, 0x30, 0x30, 0x30, 0x00]);
  // 8 (sc=56)
  glyph(56, [0x3C, 0x66, 0x66, 0x3C, 0x66, 0x66, 0x3C, 0x00]);
  // 9 (sc=57)
  glyph(57, [0x3C, 0x66, 0x66, 0x3E, 0x06, 0x0C, 0x38, 0x00]);

  // $A0 solid block (sc=160) — rainbow trail character
  glyph(160, [0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);

  writeFileSync(join(outDir, 'chargen.bin'), chargen);
  console.log('wrote chargen.bin (4096 bytes)');
}

console.log(`\nAll stub ROMs written to ${outDir}`);
