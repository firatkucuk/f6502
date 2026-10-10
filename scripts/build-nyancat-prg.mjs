// Builds website/demos/nyancat.prg — the Nyan Cat showcase for f6502.
// Pure Node.js; no npm dependencies.  Run: node scripts/build-nyancat-prg.mjs
//
// Corresponds to examples/nyancat.c64s (the C64Script source equivalent).
// Load address: $0810.  Sprite data at $0D00 (pointer value 52 = $0D00/64).
//
// Program structure
//   [ZP init]          initialize zero-page variables
//   program_start:     CLD, splash screen, animation loop
//   delay subroutine   256×256 busy-wait (~0.33 s at 1 MHz)
//   [pad to $0D00]     zero-fill to align sprite data
//   [sprite data]      Nyan Cat 24×21 monochrome, 63 bytes
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LOAD = 0x0810;

export function buildNyanCatPrg() {
  const code = [];
  const labels = new Map();
  const fixups  = [];

  const lo = (v) => v & 0xFF;
  const hi = (v) => (v >> 8) & 0xFF;
  const b  = (...bytes) => code.push(...bytes);

  // ── addressing helpers ───────────────────────────────────────────────────
  const lda    = (v)  => b(0xA9, v);
  const ldx    = (v)  => b(0xA2, v);
  const ldy    = (v)  => b(0xA0, v);
  const ldaZp  = (z)  => b(0xA5, z);
  const staZp  = (z)  => b(0x85, z);
  const staAbs = (a)  => b(0x8D, lo(a), hi(a));
  const clcOp  = ()   => b(0x18);
  const secOp  = ()   => b(0x38);
  const inx    = ()   => b(0xE8);
  const dex    = ()   => b(0xCA);
  const dey    = ()   => b(0x88);
  const rts    = ()   => b(0x60);
  const cld    = ()   => b(0xD8);

  const label  = (n)  => labels.set(n, code.length);
  const jmp    = (n)  => { b(0x4C, 0, 0); fixups.push({ at: code.length - 2, name: n, kind: 'abs' }); };
  const jsr    = (n)  => { b(0x20, 0, 0); fixups.push({ at: code.length - 2, name: n, kind: 'abs' }); };
  const bne    = (n)  => { b(0xD0, 0);    fixups.push({ at: code.length - 1, name: n, kind: 'rel' }); };
  const beq    = (n)  => { b(0xF0, 0);    fixups.push({ at: code.length - 1, name: n, kind: 'rel' }); };
  const bpl    = (n)  => { b(0x10, 0);    fixups.push({ at: code.length - 1, name: n, kind: 'rel' }); };

  // smart poke: uses ZP store (2-byte) for low-page addresses, abs (3-byte) otherwise
  const poke = (addr, val) => {
    lda(val);
    if (addr < 0x100) { staZp(addr); } else { staAbs(addr); }
  };

  // screen / colour RAM helpers
  const scr = (row, col) => 0x0400 + row * 40 + col;
  const clr = (row, col) => 0xD800 + row * 40 + col;

  // PETSCII → C64 screen code for printable characters
  const sc = (c) => {
    if (c === ' ')                   return 0x20;
    if (c >= '0' && c <= '9')        return 0x30 + (c.charCodeAt(0) - 48);
    if (c >= 'A' && c <= 'Z')        return c.charCodeAt(0) - 64;   // A=1 … Z=26
    if (c === '.')                   return 0x2E;
    if (c === '*')                   return 0x2A;
    return 0x20;
  };
  const str = (s) => [...s].map(sc);

  // C64 colours
  const BLACK      = 0;
  const WHITE      = 1;
  const RED        = 2;
  const BLUE       = 6;
  const YELLOW     = 7;
  const LIGHT_BLUE = 14;
  const LIGHT_GREY = 15;

  // VIC-II registers
  const VIC_SPR0X  = 0xD000;
  const VIC_SPR0Y  = 0xD001;
  const VIC_RASTER = 0xD012;
  const VIC_SPREN  = 0xD015;
  const VIC_CTRL2  = 0xD016;
  const VIC_BORDER = 0xD020;
  const VIC_BG0    = 0xD021;
  const VIC_SPR0C  = 0xD027;
  const SPR_PTR0   = 0x07F8;

  // Sprite data at $0D00  (pointer = $0D00 / 64 = 52)
  const SPRITE_ADDR = 0x0D00;
  const SPRITE_PTR  = SPRITE_ADDR / 64;   // 52

  // ZP variables
  const ZP_CATX    = 0x02;
  const ZP_RAINBOW = 0x03;
  const ZP_FRAME   = 0x04;

  // ── ZP initialisation (executes at load time, before program_start) ──────
  poke(ZP_CATX,    220);   // catX starting X position
  poke(ZP_RAINBOW, RED);   // border colour cycle starts at RED
  poke(ZP_FRAME,   0);     // frame counter

  // ════════════════════════════════════════════════════════════════════════════
  //  program_start — re-entered on emulator reset
  // ════════════════════════════════════════════════════════════════════════════
  label('program_start');
  cld();                              // clear decimal mode

  poke(SPR_PTR0, SPRITE_PTR);        // sprite 0 data → $0D00

  // ── clrscr: fill screen RAM $0400-$07E7 with spaces ─────────────────────
  lda(0x20);  ldx(0);                // LDA #' ', LDX #0
  label('scr_loop1');
  b(0x9D, 0x00, 0x04);               // STA $0400,X
  b(0x9D, 0x00, 0x05);               // STA $0500,X
  b(0x9D, 0x00, 0x06);               // STA $0600,X
  inx();
  bne('scr_loop1');
  ldx(231);                          // last 232 bytes ($0700-$07E7), skip sprite ptrs
  label('scr_loop2');
  b(0x9D, 0x00, 0x07);               // STA $0700,X
  dex();
  bpl('scr_loop2');

  // ── clrscr: fill colour RAM $D800-$DBFF with black ──────────────────────
  lda(0x00);  ldx(0);
  label('col_loop1');
  b(0x9D, 0x00, 0xD8);               // STA $D800,X
  b(0x9D, 0x00, 0xD9);               // STA $D900,X
  b(0x9D, 0x00, 0xDA);               // STA $DA00,X
  inx();
  bne('col_loop1');
  ldx(231);
  label('col_loop2');
  b(0x9D, 0x00, 0xDB);               // STA $DB00,X
  dex();
  bpl('col_loop2');

  // ── VIC-II splash config ─────────────────────────────────────────────────
  poke(VIC_BG0,    BLACK);
  poke(VIC_BORDER, BLACK);
  poke(VIC_SPREN,  0);               // sprites off during splash

  // ── "F6502" centred on row 10  (5 chars → col 17)  addr $05A1 ────────────
  const F6502     = str('F6502');
  const F6502_SCR = scr(10, 17);
  const F6502_CLR = clr(10, 17);
  for (let i = 0; i < F6502.length; i++) poke(F6502_SCR + i, F6502[i]);
  for (let i = 0; i < F6502.length; i++) poke(F6502_CLR + i, LIGHT_BLUE);

  // ── "APACHE 2.0 LICENCE" centred on row 12 (18 chars → col 11) ───────────
  const APACHE     = str('APACHE 2.0 LICENCE');
  const APACHE_SCR = scr(12, 11);
  const APACHE_CLR = clr(12, 11);
  for (let i = 0; i < APACHE.length; i++) poke(APACHE_SCR + i, APACHE[i]);
  for (let i = 0; i < APACHE.length; i++) poke(APACHE_CLR + i, LIGHT_BLUE);

  // ── "BUILT BY FIRAT KUCUK" centred on row 14 (20 chars → col 10) ─────────
  const BUILT     = str('BUILT BY FIRAT KUCUK');
  const BUILT_SCR = scr(14, 10);
  const BUILT_CLR = clr(14, 10);
  for (let i = 0; i < BUILT.length; i++) poke(BUILT_SCR + i, BUILT[i]);
  for (let i = 0; i < BUILT.length; i++) poke(BUILT_CLR + i, YELLOW);

  // ── Hold splash ~1.6 s (5 × delay ≈ 5 × 0.33 s) ─────────────────────────
  for (let i = 0; i < 5; i++) jsr('delay');

  // ── Fade out: reset all splash colours to black ───────────────────────────
  for (let i = 0; i < F6502.length; i++)  poke(F6502_CLR + i,  BLACK);
  for (let i = 0; i < APACHE.length; i++) poke(APACHE_CLR + i, BLACK);
  for (let i = 0; i < BUILT.length; i++)  poke(BUILT_CLR + i,  BLACK);
  jsr('delay');                      // brief pause after fade

  // ════════════════════════════════════════════════════════════════════════════
  //  Nyan Cat animation
  // ════════════════════════════════════════════════════════════════════════════

  poke(VIC_BG0,    BLUE);            // sky blue background
  poke(VIC_BORDER, RED);             // border = red (rainbow start)
  poke(VIC_SPREN,  1);               // enable sprite 0
  poke(VIC_CTRL2,  0x08);            // 38-col, no multicolour
  poke(VIC_SPR0C,  LIGHT_GREY);      // sprite colour
  poke(VIC_SPR0Y,  100);             // sprite Y (pixel)
  poke(ZP_CATX,    220);             // reset catX
  poke(ZP_RAINBOW, RED);             // restart rainbow at red
  poke(ZP_FRAME,   0);               // frame counter

  // ── Starfield: scattered '*' characters (colour = WHITE) ─────────────────
  const STAR = 0x2A;                 // '*' screen code
  const starPositions = [
    [0, 3], [0, 25],
    [2, 12], [2, 36],
    [3, 7],  [3, 28],
    [4, 18], [4, 32],
    // rows 5-9 avoided (sprite sits there at Y=100)
    [10, 2],  [10, 38],
    [12, 15],
    [15, 6],  [15, 28],
    [18, 10], [18, 35],
    [20, 22],
    [22, 8],
    [24, 17],
  ];
  for (const [r, c] of starPositions) {
    poke(scr(r, c), STAR);
    poke(clr(r, c), WHITE);
  }

  // ── Main animation loop ───────────────────────────────────────────────────
  label('anim_loop');

  // Raster sync: wait for line 200 (below visible sprites), then wait past it
  label('wait1');
  b(0xAD, 0x12, 0xD0);               // LDA $D012
  b(0xC9, 200);                      // CMP #200
  bne('wait1');
  label('wait2');
  b(0xAD, 0x12, 0xD0);
  b(0xC9, 200);
  beq('wait2');

  // Update sprite X from ZP variable
  ldaZp(ZP_CATX);
  staAbs(VIC_SPR0X);

  // catX -= 2  (wraps 0→254, sprite rolls right-to-left continuously)
  ldaZp(ZP_CATX);
  secOp();
  b(0xE9, 2);                        // SBC #2
  staZp(ZP_CATX);

  // Every 2 frames: advance rainbow border colour
  ldaZp(ZP_FRAME);
  clcOp();
  b(0x69, 1);                        // ADC #1
  staZp(ZP_FRAME);
  b(0xC9, 2);                        // CMP #2
  bne('skip_rainbow');

  lda(0);
  staZp(ZP_FRAME);                   // reset frame counter

  ldaZp(ZP_RAINBOW);
  staAbs(VIC_BORDER);                // borderColor = rainbow
  clcOp();
  b(0x69, 1);                        // rainbow++
  staZp(ZP_RAINBOW);
  b(0xC9, 16);                       // CMP #16
  bne('skip_rainbow');
  lda(0);
  staZp(ZP_RAINBOW);                 // wrap rainbow 15→0

  label('skip_rainbow');
  jmp('anim_loop');

  // ── Delay subroutine: 256×256 inner iterations ≈ 0.33 s at 1 MHz ─────────
  label('delay');
  ldx(0);                            // 256 outer iterations
  label('delay_outer');
  ldy(0);                            // 256 inner iterations
  label('delay_inner');
  dey();
  bne('delay_inner');
  dex();
  bne('delay_outer');
  rts();

  // ── Pad to sprite data address $0D00 ─────────────────────────────────────
  const codeEnd = LOAD + code.length;
  if (codeEnd > SPRITE_ADDR) {
    throw new Error(`Code overflow: code ends at $${codeEnd.toString(16).toUpperCase()}, sprite at $${SPRITE_ADDR.toString(16).toUpperCase()}`);
  }
  while (LOAD + code.length < SPRITE_ADDR) b(0x00);

  // ── Nyan Cat sprite: 24×21 px monochrome, 63 bytes ───────────────────────
  //   Each row = 3 bytes.  Rows 15-20 are blank (tail trailing space).
  b(
    0x0C, 0x60, 0x00,  // row  0: ears
    0x0C, 0x60, 0x00,  // row  1: ears
    0x1F, 0xFC, 0x00,  // row  2: head
    0x3F, 0xFE, 0x00,  // row  3
    0x7F, 0xFF, 0x00,  // row  4: full width
    0x67, 0x9F, 0x00,  // row  5: eye hollows
    0x7F, 0xFF, 0x00,  // row  6
    0x7F, 0xFF, 0x00,  // row  7
    0x7F, 0xFF, 0x00,  // row  8
    0x3F, 0xFE, 0x00,  // row  9
    0x3F, 0xFE, 0x00,  // row 10
    0x33, 0x32, 0x00,  // row 11: legs
    0x33, 0x32, 0x00,  // row 12
    0x33, 0x32, 0x00,  // row 13
    0x30, 0x02, 0x00,  // row 14: paws
    0x00, 0x00, 0x00,  // rows 15-20: blank
    0x00, 0x00, 0x00,
    0x00, 0x00, 0x00,
    0x00, 0x00, 0x00,
    0x00, 0x00, 0x00,
    0x00, 0x00, 0x00,
  );

  // ── Resolve fixups ────────────────────────────────────────────────────────
  for (const f of fixups) {
    const target = labels.get(f.name);
    if (target === undefined) throw new Error(`undefined label: '${f.name}'`);
    if (f.kind === 'rel') {
      const rel = target - (f.at + 1);
      if (rel < -128 || rel > 127) throw new Error(`branch to '${f.name}' out of range (offset ${rel})`);
      code[f.at] = rel & 0xFF;
    } else {
      code[f.at]     = lo(LOAD + target);
      code[f.at + 1] = hi(LOAD + target);
    }
  }

  return Uint8Array.from([lo(LOAD), hi(LOAD), ...code]);
}

// Run as a script: node scripts/build-nyancat-prg.mjs
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const out  = join(root, 'website', 'demos', 'nyancat.prg');
  mkdirSync(join(root, 'website', 'demos'), { recursive: true });
  const prg  = buildNyanCatPrg();
  writeFileSync(out, prg);
  console.log(`wrote ${out} (${prg.length} bytes, load addr $${LOAD.toString(16).toUpperCase()})`);
}
