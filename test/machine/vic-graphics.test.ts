import { describe, expect, it } from 'vitest';
import { renderGraphics } from '../../src/machine/vic-graphics';

const BG = Uint8Array.from([6, 2, 3, 4]);

function render(mode: number, glyph: number, code: number, nibble: number) {
  const color = new Uint8Array(8);
  const fg = new Uint8Array(8);
  renderGraphics(color, fg, mode, glyph, code, nibble, BG);
  return { color: [...color], fg: [...fg] };
}

describe('standard text (mode 0)', () => {
  it('foreground from the colour nibble, background $D021', () => {
    const r = render(0b000, 0b1010_0101, 0, 1);
    expect(r.color).toEqual([1, 6, 1, 6, 6, 1, 6, 1]);
    expect(r.fg).toEqual([1, 0, 1, 0, 0, 1, 0, 1]);
  });
});

describe('multicolour text (mode 1)', () => {
  it('colour bit 3 set: pairs 00/01/10/11 -> $D021/$D022/$D023/colour&7; fg for 10 and 11', () => {
    const r = render(0b001, 0b00_01_10_11, 0, 0x0d);
    expect(r.color).toEqual([6, 6, 2, 2, 3, 3, 5, 5]);
    expect(r.fg).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
  });

  it('colour bit 3 clear: behaves as hi-res with foreground colour 0-7', () => {
    const r = render(0b001, 0xf0, 0, 5);
    expect(r.color).toEqual([5, 5, 5, 5, 6, 6, 6, 6]);
    expect(r.fg).toEqual([1, 1, 1, 1, 0, 0, 0, 0]);
  });
});

describe('standard bitmap (mode 2)', () => {
  it('set bits use the matrix high nibble, clear bits the low nibble', () => {
    const r = render(0b010, 0xf0, 0x1c, 7);
    expect(r.color).toEqual([1, 1, 1, 1, 12, 12, 12, 12]);
    expect(r.fg).toEqual([1, 1, 1, 1, 0, 0, 0, 0]);
  });
});

describe('multicolour bitmap (mode 3)', () => {
  it('pairs: 00 -> $D021, 01 -> high nibble, 10 -> low nibble, 11 -> colour RAM', () => {
    const r = render(0b011, 0b00_01_10_11, 0x1c, 5);
    expect(r.color).toEqual([6, 6, 1, 1, 12, 12, 5, 5]);
    expect(r.fg).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
  });
});

describe('extended-colour text (mode 4)', () => {
  it('clear bits take the background selected by the top two code bits', () => {
    expect(render(0b100, 0xf0, 0x41, 7).color).toEqual([7, 7, 7, 7, 2, 2, 2, 2]); // $D022
    expect(render(0b100, 0xf0, 0xc1, 7).color).toEqual([7, 7, 7, 7, 4, 4, 4, 4]); // $D024
    expect(render(0b100, 0xf0, 0x01, 7).fg).toEqual([1, 1, 1, 1, 0, 0, 0, 0]);
  });
});

describe('invalid modes (5, 6, 7)', () => {
  it('render black but keep the foreground pattern of the mode they resemble', () => {
    const m5 = render(0b101, 0b00_01_10_11, 0, 8);
    expect(m5.color).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(m5.fg).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
    const m5hires = render(0b101, 0xf0, 0, 0);
    expect(m5hires.color).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(m5hires.fg).toEqual([1, 1, 1, 1, 0, 0, 0, 0]);
    const m6 = render(0b110, 0xf0, 0x1c, 5);
    expect(m6.color).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(m6.fg).toEqual([1, 1, 1, 1, 0, 0, 0, 0]);
    const m7 = render(0b111, 0b00_01_10_11, 0x1c, 5);
    expect(m7.color).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(m7.fg).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
  });
});
