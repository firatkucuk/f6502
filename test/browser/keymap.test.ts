import { describe, expect, it } from 'vitest';
import { KeyMapper, type KeyEventLike } from '../../src/browser/keymap';
import type { C64Key } from '../../src/machine/keyboard';

function rig() {
  const down = new Set<C64Key>();
  let restores = 0;
  const mapper = new KeyMapper({
    press: (k) => void down.add(k),
    release: (k) => void down.delete(k),
    restore: () => void restores++,
  });
  return { mapper, down, restores: () => restores };
}
const ev = (key: string, code: string, shiftKey = false): KeyEventLike => ({ key, code, shiftKey });
const SHIFT_L = ev('Shift', 'ShiftLeft', true);

describe('letters and digits', () => {
  it('maps letters to C64 letter keys regardless of case and passes physical shift through', () => {
    const { mapper, down } = rig();
    mapper.down(ev('a', 'KeyA'));
    expect(down).toEqual(new Set(['A']));
    mapper.up(ev('a', 'KeyA'));
    expect(down.size).toBe(0);
    mapper.down(SHIFT_L);
    mapper.down(ev('A', 'KeyA', true));
    expect(down).toEqual(new Set(['A', 'LSHIFT']));
  });

  it('digits are unshifted: 5 with no shift', () => {
    const { mapper, down } = rig();
    mapper.down(ev('5', 'Digit5'));
    expect(down).toEqual(new Set(['5']));
  });
});

describe('symbols force the virtual shift', () => {
  it('Shift+2 (the character ") presses 2 with C64 shift', () => {
    const { mapper, down } = rig();
    mapper.down(SHIFT_L);
    mapper.down(ev('"', 'Digit2', true));
    expect(down).toEqual(new Set(['2', 'LSHIFT']));
  });

  it('+ pressed with PC shift held (US Shift+=) releases C64 shift', () => {
    const { mapper, down } = rig();
    mapper.down(SHIFT_L);
    mapper.down(ev('+', 'Equal', true));
    expect(down).toEqual(new Set(['PLUS']));
  });

  it('releasing a forced symbol restores the physical shift state', () => {
    const { mapper, down } = rig();
    mapper.down(SHIFT_L);
    mapper.down(ev('+', 'Equal', true));
    expect(down.has('LSHIFT')).toBe(false);
    mapper.up(ev('+', 'Equal', true));
    expect(down).toEqual(new Set(['LSHIFT'])); // physical shift still held
    mapper.up({ key: 'Shift', code: 'ShiftLeft', shiftKey: false });
    expect(down.size).toBe(0);
  });

  it('< and > are shifted comma/period; = is unshifted', () => {
    const { mapper, down } = rig();
    mapper.down(ev('<', 'Comma', true));
    expect(down).toEqual(new Set(['COMMA', 'LSHIFT']));
    mapper.up(ev('<', 'Comma', true));
    mapper.down(ev('=', 'Equal'));
    expect(down).toEqual(new Set(['EQUALS']));
  });
});

describe('special keys', () => {
  it.each([
    [ev('Enter', 'Enter'), ['RETURN']],
    [ev('Backspace', 'Backspace'), ['DEL']],
    [ev('Escape', 'Escape'), ['RUN_STOP']],
    [ev('Tab', 'Tab'), ['CTRL']],
    [ev('Control', 'ControlLeft'), ['COMMODORE']],
    [ev(' ', 'Space'), ['SPACE']],
    [ev('ArrowRight', 'ArrowRight'), ['CRSR_RIGHT']],
    [ev('ArrowLeft', 'ArrowLeft'), ['CRSR_RIGHT', 'LSHIFT']],
    [ev('ArrowDown', 'ArrowDown'), ['CRSR_DOWN']],
    [ev('ArrowUp', 'ArrowUp'), ['CRSR_DOWN', 'LSHIFT']],
    [ev('Home', 'Home'), ['HOME']],
    [ev('F1', 'F1'), ['F1']],
    [ev('F2', 'F2'), ['F1', 'LSHIFT']],
    [ev('F4', 'F4'), ['F3', 'LSHIFT']],
    [ev('F8', 'F8'), ['F7', 'LSHIFT']],
  ])('%j -> %j', (event, keys) => {
    const { mapper, down } = rig();
    expect(mapper.down(event)).toBe(true);
    expect(down).toEqual(new Set(keys as C64Key[]));
  });

  it('Shift+Backspace gives INST (DEL with C64 shift)', () => {
    const { mapper, down } = rig();
    mapper.down(SHIFT_L);
    mapper.down(ev('Backspace', 'Backspace', true));
    expect(down).toEqual(new Set(['DEL', 'LSHIFT']));
  });

  it('PageUp pulses RESTORE and presses no key', () => {
    const { mapper, down, restores } = rig();
    expect(mapper.down(ev('PageUp', 'PageUp'))).toBe(true);
    expect(restores()).toBe(1);
    expect(down.size).toBe(0);
  });

  it('unknown keys are not handled', () => {
    const { mapper, down } = rig();
    expect(mapper.down(ev('F12', 'F12'))).toBe(false);
    expect(mapper.down(ev('~', 'Backquote', true))).toBe(false);
    expect(down.size).toBe(0);
  });

  it('does not treat inherited object property names as keys', () => {
    const { mapper, down } = rig();
    expect(mapper.down(ev('constructor', 'X'))).toBe(false);
    expect(mapper.down(ev('toString', 'Y'))).toBe(false);
    expect(down.size).toBe(0);
  });
});

describe('multiple keys and blur', () => {
  it('two keys held together; releasing one keeps the other', () => {
    const { mapper, down } = rig();
    mapper.down(ev('a', 'KeyA'));
    mapper.down(ev('s', 'KeyS'));
    expect(down).toEqual(new Set(['A', 'S']));
    mapper.up(ev('a', 'KeyA'));
    expect(down).toEqual(new Set(['S']));
  });

  it('releaseAll releases everything', () => {
    const { mapper, down } = rig();
    mapper.down(SHIFT_L);
    mapper.down(ev('A', 'KeyA', true));
    mapper.releaseAll();
    expect(down.size).toBe(0);
  });

  it('keys with an empty code (soft keyboards) are tracked by their key value', () => {
    const { mapper, down } = rig();
    mapper.down(ev('a', ''));
    mapper.down(ev('s', ''));
    expect(down).toEqual(new Set(['A', 'S']));
    mapper.up(ev('a', ''));
    expect(down).toEqual(new Set(['S']));
  });

  it('a keyup arriving without a keydown is ignored', () => {
    const { mapper, down } = rig();
    expect(mapper.up(ev('a', 'KeyA'))).toBe(false);
    expect(down.size).toBe(0);
  });
});
