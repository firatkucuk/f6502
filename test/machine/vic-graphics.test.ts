import { describe, expect, it } from 'vitest';
import { GraphicsPipe } from '../../src/machine/vic-graphics';

const D021 = 0x21;

interface Cell {
  glyph: number;
  vbuf?: number;
  cbuf?: number;
}

/**
 * Feeds one cell through a fresh pipe: fetched in call 1, shifted to the second stage in call 2 and
 * drawn in call 3 (`regs` apply to all three calls, except that call 3 may differ).
 */
function draw(cell: Cell, d011: number, d016: number, d011Last = d011, d016Last = d016) {
  const pipe = new GraphicsPipe();
  const regs = new Uint8Array(0x40);
  const vbuf = new Uint8Array(64).fill(cell.vbuf ?? 0);
  const cbuf = new Uint8Array(64).fill(cell.cbuf ?? 0);
  regs[0x11] = d011;
  regs[0x16] = d016;
  pipe.drawCycle(regs, true, false, false, cell.glyph, vbuf, cbuf);
  pipe.drawCycle(regs, false, false, false, 0, vbuf, cbuf);
  regs[0x11] = d011Last;
  regs[0x16] = d016Last;
  pipe.drawCycle(regs, false, false, false, 0, vbuf, cbuf);
  return { color: [...pipe.color], fg: [...pipe.fg] };
}

const TEXT = 0x1b;
const BITMAP = 0x3b;
const ECM = 0x5b;
const MC = 0x10;

describe('standard text', () => {
  it('foreground from the colour nibble, background $D021', () => {
    const r = draw({ glyph: 0b1010_0101, cbuf: 1 }, TEXT, 0);
    expect(r.color).toEqual([1, D021, 1, D021, D021, 1, D021, 1]);
    expect(r.fg).toEqual([2, 0, 2, 0, 0, 2, 0, 2]);
  });
});

describe('multicolour text', () => {
  it('colour bit 3 set: pairs use $D021/$D022/$D023/colour&7; fg for 10 and 11', () => {
    const r = draw({ glyph: 0b00_01_10_11, cbuf: 0x0d }, TEXT, MC);
    expect(r.color).toEqual([D021, D021, 0x22, 0x22, 0x23, 0x23, 5, 5]);
    expect(r.fg).toEqual([0, 0, 0, 0, 2, 2, 2, 2]);
  });

  it('colour bit 3 clear: behaves as hi-res with foreground colour 0-7', () => {
    const r = draw({ glyph: 0xf0, cbuf: 5 }, TEXT, MC);
    expect(r.color).toEqual([5, 5, 5, 5, D021, D021, D021, D021]);
  });
});

describe('bitmap modes', () => {
  it('standard bitmap: set bits use the matrix high nibble, clear bits the low nibble', () => {
    const r = draw({ glyph: 0xf0, vbuf: 0x1c, cbuf: 7 }, BITMAP, 0);
    expect(r.color).toEqual([1, 1, 1, 1, 12, 12, 12, 12]);
    expect(r.fg).toEqual([2, 2, 2, 2, 0, 0, 0, 0]);
  });

  it('multicolour bitmap: $D021, matrix high nibble, matrix low nibble, colour RAM', () => {
    const r = draw({ glyph: 0b00_01_10_11, vbuf: 0x1c, cbuf: 7 }, BITMAP, MC);
    expect(r.color).toEqual([D021, D021, 1, 1, 12, 12, 7, 7]);
    expect(r.fg).toEqual([0, 0, 0, 0, 2, 2, 2, 2]);
  });
});

describe('extended colour and illegal modes', () => {
  it('ECM text takes the background from the matrix top two bits', () => {
    const r = draw({ glyph: 0x0f, vbuf: 0xc1, cbuf: 3 }, ECM, 0);
    expect(r.color).toEqual([D021 + 3, D021 + 3, D021 + 3, D021 + 3, 3, 3, 3, 3]);
  });

  it('ECM together with BMM or MCM is black, with the foreground flags of the pixel pairs', () => {
    expect(draw({ glyph: 0xff, cbuf: 3 }, 0x7b, 0).color).toEqual(new Array(8).fill(0));
    const r = draw({ glyph: 0b11_00_11_00, cbuf: 0x0f }, ECM, MC);
    expect(r.color).toEqual(new Array(8).fill(0));
    expect(r.fg).toEqual([2, 2, 0, 0, 2, 2, 0, 0]);
  });
});

describe('sampling points inside a cycle', () => {
  it('BMM switched on is seen from pixel 4, switched off still holds until pixel 6', () => {
    const on = draw({ glyph: 0xff, vbuf: 0x1c, cbuf: 5 }, TEXT, 0, BITMAP, 0);
    expect(on.color).toEqual([5, 5, 5, 5, 1, 1, 1, 1]);
    const off = draw({ glyph: 0xff, vbuf: 0x1c, cbuf: 5 }, BITMAP, 0, TEXT, 0);
    expect(off.color).toEqual([1, 1, 1, 1, 1, 1, 5, 5]);
  });

  it('XSCROLL delays the start of the cell by that many pixels', () => {
    const r = draw({ glyph: 0xff, cbuf: 1 }, TEXT, 3);
    expect(r.color.slice(0, 3)).toEqual([D021, D021, D021]);
    expect(r.color.slice(3)).toEqual([1, 1, 1, 1, 1]);
  });
});
