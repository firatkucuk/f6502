import { describe, expect, it } from 'vitest';
import { PALETTE } from '../../src/machine/palette';
import { px, runFrames, vicWorld } from './vic-helpers';

const P = (i: number) => PALETTE[i]!;

type World = ReturnType<typeof vicWorld>;

function setup(w: World) {
  w.vic.write(0x11, 0x1b);
  w.vic.write(0x16, 0x08);
  w.vic.write(0x18, 0x12); // matrix $0400, char base $0800
  w.vic.write(0x20, 0x0e); // border light blue
  w.vic.write(0x21, 0x06); // background blue
}

function sprite(
  w: World,
  n: number,
  o: { x: number; y: number; colour: number; ptr?: number; rows?: number[] },
) {
  const ptr = o.ptr ?? 0x40 + n;
  w.ram[0x07f8 + n] = ptr;
  const rows = o.rows ?? new Array(63).fill(0xff);
  rows.forEach((b, i) => (w.ram[ptr * 64 + i] = b));
  w.vic.write(2 * n, o.x & 0xff);
  w.vic.write(1 + 2 * n, o.y);
  w.vic.write(0x10, (w.vic.peek(0x10) & ~(1 << n)) | (o.x & 0x100 ? 1 << n : 0));
  w.vic.write(0x27 + n, o.colour);
  w.vic.write(0x15, w.vic.peek(0x15) | (1 << n));
}

// Sprite X=24, Y=50 lines up with the first text cell: framebuffer (32, 36).
const FX = 32;
const FY = 36;

describe('sprite rendering', () => {
  it('draws a solid sprite over the background at the right place and size', () => {
    const w = vicWorld();
    setup(w);
    sprite(w, 0, { x: 24, y: 50, colour: 1 });
    runFrames(w.vic, 2);
    expect(px(w.vic, FX, FY)).toBe(P(1));
    expect(px(w.vic, FX + 23, FY + 20)).toBe(P(1));
    expect(px(w.vic, FX + 24, FY)).toBe(P(6));
    expect(px(w.vic, FX, FY + 21)).toBe(P(6));
    expect(px(w.vic, FX, FY - 1)).toBe(P(14)); // border row above the window
  });

  it('the border hides sprites', () => {
    const w = vicWorld();
    setup(w);
    sprite(w, 0, { x: 10, y: 50, colour: 1 }); // left of the display window
    runFrames(w.vic, 2);
    expect(px(w.vic, 18, FY)).toBe(P(14));
  });
});

describe('priority', () => {
  it('a lower-numbered sprite is drawn over a higher-numbered one', () => {
    const w = vicWorld();
    setup(w);
    sprite(w, 1, { x: 24, y: 50, colour: 2 });
    sprite(w, 0, { x: 24, y: 50, colour: 1 });
    runFrames(w.vic, 2);
    expect(px(w.vic, FX + 5, FY + 5)).toBe(P(1));
  });

  it('a behind-foreground sprite is hidden by set glyph pixels but not by background', () => {
    const w = vicWorld();
    setup(w);
    w.ram[0x0400] = 1;
    w.color[0] = 5;
    w.ram[0x0808] = 0xf0; // left 4 pixels foreground on row 0
    sprite(w, 0, { x: 24, y: 50, colour: 2 });
    w.vic.write(0x1b, 0x01); // behind foreground
    runFrames(w.vic, 2);
    expect(px(w.vic, FX, FY)).toBe(P(5)); // glyph wins
    expect(px(w.vic, FX + 4, FY)).toBe(P(2)); // sprite over background
  });
});

describe('collisions and IRQ', () => {
  it('sprite-sprite: both bits set, flag raised, read clears, peek does not', () => {
    const w = vicWorld();
    setup(w);
    w.vic.write(0x1a, 0x04);
    sprite(w, 0, { x: 24, y: 50, colour: 1 });
    sprite(w, 1, { x: 30, y: 54, colour: 2 });
    runFrames(w.vic, 2);
    expect(w.vic.peek(0x1e)).toBe(0b11);
    expect(w.vic.peek(0x1e)).toBe(0b11); // peek does not clear
    expect(w.vic.read(0x19) & 0x04).toBe(0x04);
    expect(w.vic.irq).toBe(true);
    expect(w.vic.read(0x1e)).toBe(0b11);
    expect(w.vic.read(0x1e)).toBe(0);
  });

  it('the flag is raised on the zero-to-non-zero transition only', () => {
    const w = vicWorld();
    setup(w);
    sprite(w, 0, { x: 24, y: 50, colour: 1 });
    sprite(w, 1, { x: 30, y: 54, colour: 2 });
    runFrames(w.vic, 2);
    w.vic.write(0x19, 0x04); // acknowledge the flag but leave $D01E non-zero
    runFrames(w.vic, 2); // collisions again while the register is non-zero
    expect(w.vic.peek(0x19) & 0x04).toBe(0);
    w.vic.read(0x1e); // now the register is cleared
    runFrames(w.vic, 2);
    expect(w.vic.peek(0x19) & 0x04).toBe(0x04);
  });

  it('three overlapping sprites set three bits', () => {
    const w = vicWorld();
    setup(w);
    for (const n of [0, 1, 2]) sprite(w, n, { x: 24 + n, y: 50, colour: 1 + n });
    runFrames(w.vic, 2);
    expect(w.vic.read(0x1e)).toBe(0b111);
  });

  it('sprite-background: set only over foreground pixels, even for a behind-foreground sprite', () => {
    const w = vicWorld();
    setup(w);
    w.ram[0x0400] = 1;
    w.color[0] = 5;
    w.ram[0x0808] = 0xf0;
    sprite(w, 0, { x: 24, y: 50, colour: 2, rows: [0xff, 0xff, 0xff, ...new Array(60).fill(0)] });
    w.vic.write(0x1b, 0x01);
    w.vic.write(0x1a, 0x02);
    runFrames(w.vic, 2);
    expect(w.vic.read(0x1f)).toBe(0x01);
    expect(w.vic.peek(0x19) & 0x02).toBe(0x02);
  });

  it('no sprite-background collision over pure background', () => {
    const w = vicWorld();
    setup(w);
    sprite(w, 0, { x: 24, y: 50, colour: 2 });
    runFrames(w.vic, 2);
    expect(w.vic.peek(0x1f)).toBe(0);
  });

  it('collisions are detected under the border while the pixels stay hidden', () => {
    const w = vicWorld();
    setup(w);
    sprite(w, 0, { x: 10, y: 50, colour: 1 });
    sprite(w, 1, { x: 12, y: 50, colour: 2 });
    runFrames(w.vic, 2);
    expect(w.vic.peek(0x1e)).toBe(0b11);
    expect(px(w.vic, 18, FY)).toBe(P(14));
  });

  it('writes to the collision registers are ignored', () => {
    const w = vicWorld();
    setup(w);
    sprite(w, 0, { x: 24, y: 50, colour: 1 });
    sprite(w, 1, { x: 24, y: 50, colour: 2 });
    runFrames(w.vic, 2);
    w.vic.write(0x1e, 0x00);
    expect(w.vic.peek(0x1e)).toBe(0b11);
  });
});

describe('sprite state in debug', () => {
  it('DMA and display are on during the sprite and off after its 21 rows', () => {
    const w = vicWorld();
    setup(w);
    sprite(w, 0, { x: 24, y: 50, colour: 1 });
    runFrames(w.vic, 1); // ends at raster 0 of the next frame
    const raster = () => w.vic.raster;
    while (raster() !== 60) w.vic.tick();
    expect(w.vic.debug.sprites.dma[0]).toBe(1);
    expect(w.vic.debug.sprites.display[0]).toBe(1);
    expect(w.vic.debug.sprites.mcBase[0]).toBe(27); // 9 increments of 3 (rasters 51-59)
    while (raster() !== 80) w.vic.tick();
    expect(w.vic.debug.sprites.dma[0]).toBe(0);
    expect(w.vic.debug.sprites.display[0]).toBe(0);
    // A sprite restarts when raster & $FF matches Y again (Y + 256 = 306 is inside 312 lines).
  });
});
