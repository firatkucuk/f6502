// Generates legally-clean stub ROM files for the f6502 showcases and playground.
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
//     0. Zero $00C6 so a reset never replays the previous program
//     a. Show the classic C64 boot screen: light-blue border, blue background, cleared
//        screen, light-blue text. "READY." goes at row 5 col 0 = $04C8 (screen codes:
//        R=18 E=5 A=1 D=4 Y=25 .=46), matching screenCodeToChar() in c64.ts. This is
//        what "Reboot" in the playground shows.
//     b. Poll $00C6 (keyboard buffer count) until non-zero
//     c. Hand the program a clean screen (spaces, black text, black border and
//        background), then JMP $0810 — by this point the PRG has been written to RAM
//
// $E000: RTI         — NMI/IRQ handler
// $E001-: init + READY + wait loop + clean-up + JMP
// $FFFA-$FFFF: hardware vectors
{
  const kernal = new Uint8Array(8192).fill(0xEA); // NOP fill
  let p = 0;

  /** Emits raw bytes at the current position. */
  const put = (...bytes) => { for (const b of bytes) kernal[p++] = b; };

  /**
   * Fills a 1000-byte block with `value`. `firstPage` is the high byte of the block's base
   * ($04 for screen RAM, $D8 for colour RAM). Three full pages go through STA page,X; the
   * remaining 232 bytes use STA base-1,X with X = 232..1 and BNE (BPL would stop at X > 127).
   */
  const fill = (value, firstPage) => {
    put(0xA9, value);                          // LDA #value
    put(0xA2, 0x00);                           // LDX #0
    const top = p;
    for (let i = 0; i < 3; i++) put(0x9D, 0x00, firstPage + i); // STA page,X
    put(0xE8);                                 // INX
    put(0xD0, (top - (p + 2)) & 0xFF);         // BNE top
    put(0xA2, 232);                            // LDX #232
    const top2 = p;
    put(0x9D, 0xFF, firstPage + 2);            // STA $xxFF,X  (covers the last 232 bytes)
    put(0xCA);                                 // DEX
    put(0xD0, (top2 - (p + 2)) & 0xFF);        // BNE top2
  };

  // $E000: RTI (NMI/IRQ handler — just return)
  put(0x40);

  // $E001: init
  put(0xA9, 0x2F, 0x85, 0x00);                 // LDA #$2F ; STA $00  (6510 port direction)
  put(0xA9, 0x37, 0x85, 0x01);                 // LDA #$37 ; STA $01  (KERNAL+BASIC+IO enabled)
  put(0xA9, 0x1B, 0x8D, 0x11, 0xD0);           // LDA #$1B ; STA $D011 (screen on)
  put(0xA9, 0x15, 0x8D, 0x18, 0xD0);           // LDA #$15 ; STA $D018 (screen at $0400)
  // 40-column mode, as the real KERNAL sets it. The VIC resets to 38 columns, which hides
  // most of the first character of every row.
  put(0xA9, 0xC8, 0x8D, 0x16, 0xD0);           // LDA #$C8 ; STA $D016

  // Empty the keyboard buffer. RAM survives a reset, so a stale non-zero $C6 would make the
  // wait loop below fall straight through into whatever program the previous run left.
  put(0xA9, 0x00, 0x85, 0xC6);                 // LDA #0 ; STA $C6

  // Classic C64 boot screen.
  put(0xA9, 14, 0x8D, 0x20, 0xD0);             // LDA #14 ; STA $D020 (border: light blue)
  put(0xA9, 6,  0x8D, 0x21, 0xD0);             // LDA #6  ; STA $D021 (background: blue)
  fill(0x20, 0x04);                            // screen RAM: spaces
  fill(14, 0xD8);                              // colour RAM: light blue

  // "READY." at screen RAM $04C8 (row 5, col 0). Screen codes: R=18 E=5 A=1 D=4 Y=25 .=46
  const ready = [18, 5, 1, 4, 25, 46];
  ready.forEach((code, i) => put(0xA9, code, 0x8D, 0xC8 + i, 0x04)); // LDA #code ; STA $04C8+i

  // Poll $00C6 (keyboard buffer count) — non-zero means applyPrg() has run and the PRG bytes
  // are already at $0810.
  put(0xA5, 0xC6);                             // LDA $C6
  put(0xF0, 0xFC);                             // BEQ back to LDA $C6

  // Hand the program a clean slate: blank screen, black text, black border and background.
  fill(0x20, 0x04);
  fill(0, 0xD8);
  put(0xA9, 0x00, 0x8D, 0x20, 0xD0);           // LDA #0 ; STA $D020
  put(0x8D, 0x21, 0xD0);                       // STA $D021

  // PRG is loaded — jump into it
  put(0x4C, 0x10, 0x08);                       // JMP $0810

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
