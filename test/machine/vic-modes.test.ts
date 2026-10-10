import { describe, expect, it } from 'vitest';
import { PALETTE } from '../../src/machine/palette';
import { cellX, cellY, px, runFrames, vicWorld } from './vic-helpers';

const P = (i: number) => PALETTE[i]!;

function common(w: ReturnType<typeof vicWorld>, d011: number, d016 = 0x08, d018 = 0x12) {
  w.vic.write(0x11, d011);
  w.vic.write(0x16, d016);
  w.vic.write(0x18, d018);
  w.vic.write(0x20, 0x0e); // border
  w.vic.write(0x21, 0x06); // $D021
  w.vic.write(0x22, 0x02); // $D022
  w.vic.write(0x23, 0x03); // $D023
  w.vic.write(0x24, 0x04); // $D024
}

describe('multicolour text through the VIC', () => {
  it('draws multicolour and hi-res cells side by side', () => {
    const w = vicWorld();
    common(w, 0x1b, 0x18);
    w.ram[0x0400] = 1;
    w.ram[0x0401] = 2;
    w.color[0] = 0x0d; // multicolour, foreground 5
    w.color[1] = 0x05; // hi-res, foreground 5
    w.ram[0x0808] = 0b00_01_10_11; // code 1 glyph row 0
    w.ram[0x0810] = 0xf0; // code 2 glyph row 0
    runFrames(w.vic, 2);
    const row = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => px(w.vic, cellX(0, i), cellY(0)));
    expect(row).toEqual([P(6), P(6), P(2), P(2), P(3), P(3), P(5), P(5)]);
    const hires = [0, 3, 4, 7].map((i) => px(w.vic, cellX(1, i), cellY(0)));
    expect(hires).toEqual([P(5), P(5), P(6), P(6)]);
  });
});

describe('bitmap modes through the VIC', () => {
  it('standard bitmap: bitmap base from $D018 bit 3, colours from the matrix byte', () => {
    const w = vicWorld();
    common(w, 0x3b, 0x08, 0x18); // BMM, bitmap at $2000, matrix at $0400
    w.ram[0x0400] = 0x1c;
    w.ram[0x2000] = 0xf0; // cell 0, row 0
    runFrames(w.vic, 2);
    expect(px(w.vic, cellX(0, 0), cellY(0))).toBe(P(1));
    expect(px(w.vic, cellX(0, 3), cellY(0))).toBe(P(1));
    expect(px(w.vic, cellX(0, 4), cellY(0))).toBe(P(12));
    expect(px(w.vic, cellX(0, 7), cellY(0))).toBe(P(12));
  });

  it('bitmap addressing advances by cell (VC << 3) and by pixel row (RC)', () => {
    const w = vicWorld();
    common(w, 0x3b, 0x08, 0x18);
    w.ram[0x0401] = 0x2d; // cell 1: hi 2, lo 13
    w.ram[0x2008 + 3] = 0x80; // cell 1, row 3: leftmost pixel set
    runFrames(w.vic, 2);
    expect(px(w.vic, cellX(1, 0), cellY(0, 3))).toBe(P(2));
    expect(px(w.vic, cellX(1, 1), cellY(0, 3))).toBe(P(13));
    expect(px(w.vic, cellX(1, 0), cellY(0, 2))).toBe(P(13));
  });

  it('multicolour bitmap pairs', () => {
    const w = vicWorld();
    common(w, 0x3b, 0x18, 0x18);
    w.ram[0x0400] = 0x1c;
    w.color[0] = 0x05;
    w.ram[0x2000] = 0b00_01_10_11;
    runFrames(w.vic, 2);
    const row = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => px(w.vic, cellX(0, i), cellY(0)));
    expect(row).toEqual([P(6), P(6), P(1), P(1), P(12), P(12), P(5), P(5)]);
  });

  it('an odd XSCROLL moves the pair boundaries and bleeds the last pixel into the next cell', () => {
    const w = vicWorld();
    common(w, 0x3b, 0x18 | 1, 0x18);
    w.ram[0x0400] = 0x1c;
    w.color[0] = 0x05;
    w.ram[0x2000] = 0b00_01_10_11;
    runFrames(w.vic, 2);
    const row = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => px(w.vic, cellX(0, i), cellY(0)));
    expect(row).toEqual([P(6), P(6), P(6), P(1), P(1), P(12), P(12), P(5)]);
    expect(px(w.vic, cellX(1, 0), cellY(0))).toBe(P(5)); // last pixel of cell 0 delayed into cell 1
  });
});

describe('extended-colour text through the VIC', () => {
  it('takes the background from the top two bits of the character code', () => {
    const w = vicWorld();
    common(w, 0x5b);
    w.ram[0x0400] = 0x41; // glyph 1, background $D022
    w.color[0] = 7;
    w.ram[0x0808] = 0xf0;
    runFrames(w.vic, 2);
    expect(px(w.vic, cellX(0, 0), cellY(0))).toBe(P(7));
    expect(px(w.vic, cellX(0, 4), cellY(0))).toBe(P(2));
  });
});

describe('invalid modes through the VIC', () => {
  it('ECM + BMM renders black inside the window', () => {
    const w = vicWorld();
    common(w, 0x7b, 0x08, 0x18);
    w.ram[0x0400] = 0x1c;
    w.ram[0x2000] = 0xff;
    runFrames(w.vic, 2);
    expect(px(w.vic, cellX(0, 0), cellY(0))).toBe(P(0));
    expect(px(w.vic, cellX(5, 0), cellY(3))).toBe(P(0));
    expect(px(w.vic, 0, 0)).toBe(P(14)); // border unaffected
  });
});

describe('idle state graphics', () => {
  // YSCROLL = 7: the window top is raster 51 but the first badline is raster 55, so
  // rasters 51-54 are idle lines inside the window (framebuffer rows 36-39).
  it('reads $3FFF in idle lines: set bits black, clear bits $D021', () => {
    const w = vicWorld();
    common(w, 0x1f);
    w.ram[0x3fff] = 0xaa;
    runFrames(w.vic, 2);
    expect(px(w.vic, cellX(0, 0), 36)).toBe(P(0));
    expect(px(w.vic, cellX(0, 1), 36)).toBe(P(6));
  });

  it('with ECM the idle access is $39FF', () => {
    const w = vicWorld();
    common(w, 0x5f);
    w.ram[0x3fff] = 0x00;
    w.ram[0x39ff] = 0xff;
    runFrames(w.vic, 2);
    expect(px(w.vic, cellX(0, 0), 36)).toBe(P(0));
    expect(px(w.vic, cellX(0, 1), 36)).toBe(P(0));
  });
});

describe('mode changes mid-frame', () => {
  it('registers are sampled per cycle: ECM+BMM from raster 120 turns the picture black', () => {
    const w = vicWorld();
    common(w, 0x1b);
    runFrames(w.vic, 2);
    const raster = () => w.vic.raster; // a function: TS must not narrow the property to a literal
    while (raster() !== 120) w.vic.tick();
    w.vic.write(0x11, 0x7b);
    while (raster() !== 130) w.vic.tick();
    expect(px(w.vic, 100, 119 - 15)).toBe(P(6));
    expect(px(w.vic, 100, 121 - 15)).toBe(P(0));
  });
});
