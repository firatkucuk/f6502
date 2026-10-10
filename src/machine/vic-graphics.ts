/**
 * Pure per-cell pixel generator for the VIC-II graphics modes.
 * mode = ECM << 2 | BMM << 1 | MCM.
 */

function hires(color: Uint8Array, fg: Uint8Array, glyph: number, on: number, off: number): void {
  for (let i = 0; i < 8; i++) {
    const bit = (glyph >> (7 - i)) & 1;
    color[i] = bit ? on : off;
    fg[i] = bit;
  }
}

function multi(
  color: Uint8Array,
  fg: Uint8Array,
  glyph: number,
  c0: number,
  c1: number,
  c2: number,
  c3: number,
): void {
  for (let p = 0; p < 4; p++) {
    const v = (glyph >> (6 - 2 * p)) & 3;
    const c = v === 0 ? c0 : v === 1 ? c1 : v === 2 ? c2 : c3;
    const f = v >> 1; // pairs 10 and 11 are foreground
    color[2 * p] = c;
    color[2 * p + 1] = c;
    fg[2 * p] = f;
    fg[2 * p + 1] = f;
  }
}

export function renderGraphics(
  color: Uint8Array,
  fg: Uint8Array,
  mode: number,
  glyph: number,
  code: number,
  nibble: number,
  bg: Uint8Array,
): void {
  switch (mode) {
    case 0: // standard text
      hires(color, fg, glyph, nibble, bg[0]!);
      return;
    case 1: // multicolour text
      if (nibble & 8) multi(color, fg, glyph, bg[0]!, bg[1]!, bg[2]!, nibble & 7);
      else hires(color, fg, glyph, nibble, bg[0]!);
      return;
    case 2: // standard bitmap
      hires(color, fg, glyph, code >> 4, code & 15);
      return;
    case 3: // multicolour bitmap
      multi(color, fg, glyph, bg[0]!, code >> 4, code & 15, nibble);
      return;
    case 4: // extended-colour text
      hires(color, fg, glyph, nibble, bg[(code >> 6) & 3]!);
      return;
    case 5: // ECM + MCM: black, flags like multicolour text
      if (nibble & 8) multi(color, fg, glyph, 0, 0, 0, 0);
      else hires(color, fg, glyph, 0, 0);
      return;
    case 6: // ECM + BMM: black, flags like standard bitmap
      hires(color, fg, glyph, 0, 0);
      return;
    default: // 7: ECM + BMM + MCM: black, flags like multicolour bitmap
      multi(color, fg, glyph, 0, 0, 0, 0);
  }
}
