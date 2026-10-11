import { describe, expect, it } from 'vitest';
import { KEY_POSITION, Keyboard } from '../../src/machine/keyboard';
import { PALETTE } from '../../src/machine/palette';
import { KEY_POSITION as EXPORTED_KEYS } from '../../src/machine';

describe('Keyboard matrix', () => {
  it('maps A to column PA1 / row PB2 and RUN_STOP to PA7 / PB7', () => {
    expect(KEY_POSITION.A).toEqual({ col: 1, row: 2 });
    expect(KEY_POSITION.RUN_STOP).toEqual({ col: 7, row: 7 });
    expect(KEY_POSITION.LSHIFT).toEqual({ col: 1, row: 7 });
    expect(KEY_POSITION.RETURN).toEqual({ col: 0, row: 1 });
    expect(KEY_POSITION.SPACE).toEqual({ col: 7, row: 4 });
  });

  it('scans columns -> rows and rows -> columns', () => {
    const k = new Keyboard();
    k.press('A');
    expect(k.scanColumns(0b1111_1101)).toBe(0b1111_1011); // select col 1, row 2 pulled low
    expect(k.scanColumns(0b1111_1110)).toBe(0xff); // col 0 selected: nothing
    expect(k.scanRows(0b1111_1011)).toBe(0b1111_1101); // select row 2, col 1 pulled low
    expect(k.scanRows(0xff)).toBe(0xff);
  });

  it('two keys in different columns both show when both columns are selected', () => {
    const k = new Keyboard();
    k.press('A');
    k.press('RETURN');
    expect(k.scanColumns(0x00)).toBe(0xff & ~(1 << 2) & ~(1 << 1));
  });

  it('is reference counted: two presses need two releases', () => {
    const k = new Keyboard();
    k.press('A');
    k.press('A');
    k.release('A');
    expect(k.scanColumns(0b1111_1101)).toBe(0b1111_1011);
    k.release('A');
    expect(k.scanColumns(0b1111_1101)).toBe(0xff);
  });

  it('extra releases do not go negative', () => {
    const k = new Keyboard();
    k.release('A');
    k.press('A');
    expect(k.scanColumns(0b1111_1101)).toBe(0b1111_1011);
  });
});

describe('palette', () => {
  it('has 16 opaque RGBA entries; white and black are exact', () => {
    expect(PALETTE).toHaveLength(16);
    expect(PALETTE[0]).toBe(0xff000000);
    expect(PALETTE[1]).toBe(0xffffffff);
    for (const c of PALETTE) expect(c >>> 24).toBe(0xff);
  });
});

describe('public keyboard map', () => {
  it('exports the emulator key names for deterministic input validation', () => {
    expect(EXPORTED_KEYS.SPACE).toEqual({ col: 7, row: 4 });
    expect(EXPORTED_KEYS.A).toEqual({ col: 1, row: 2 });
  });
});
