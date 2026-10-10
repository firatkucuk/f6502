import { FRAME_WIDTH, VicII } from '../../src/machine/vic';

/** A VIC backed by 16 KB of RAM and 1 KB of colour RAM; video matrix at $0400 once $D018 = $1x. */
export function vicWorld() {
  const ram = new Uint8Array(0x4000);
  const color = new Uint8Array(0x400);
  const vic = new VicII({
    readMem: (a) => ram[a & 0x3fff]!,
    readColor: (i) => color[i & 0x3ff]!,
  });
  return { vic, ram, color };
}

export const px = (vic: VicII, x: number, y: number): number => vic.frame[y * FRAME_WIDTH + x]!;

export function runFrames(vic: VicII, n: number): void {
  for (let i = 0; i < n; i++) {
    const f = vic.frameCount;
    while (vic.frameCount === f) vic.tick();
  }
}

/** Framebuffer coordinate of pixel (px, line) inside text cell (col, row). */
export const cellX = (col: number, p = 0): number => 32 + col * 8 + p;
export const cellY = (row: number, line = 0): number => 36 + row * 8 + line;
