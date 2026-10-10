import type { C64Key } from '../machine/keyboard';

export interface KeyEventLike {
  key: string;
  code: string;
  shiftKey: boolean;
}

export interface KeySink {
  press(key: C64Key): void;
  release(key: C64Key): void;
  restore(): void;
}

type ShiftMode = 'on' | 'off' | 'pass';
interface Resolved {
  keys: C64Key[];
  shift: ShiftMode;
}

const SYMBOLS: Record<string, Resolved> = {
  '!': { keys: ['1'], shift: 'on' },
  '"': { keys: ['2'], shift: 'on' },
  '#': { keys: ['3'], shift: 'on' },
  $: { keys: ['4'], shift: 'on' },
  '%': { keys: ['5'], shift: 'on' },
  '&': { keys: ['6'], shift: 'on' },
  "'": { keys: ['7'], shift: 'on' },
  '(': { keys: ['8'], shift: 'on' },
  ')': { keys: ['9'], shift: 'on' },
  '@': { keys: ['AT'], shift: 'off' },
  '*': { keys: ['ASTERISK'], shift: 'off' },
  '+': { keys: ['PLUS'], shift: 'off' },
  '-': { keys: ['MINUS'], shift: 'off' },
  '=': { keys: ['EQUALS'], shift: 'off' },
  ':': { keys: ['COLON'], shift: 'off' },
  ';': { keys: ['SEMICOLON'], shift: 'off' },
  ',': { keys: ['COMMA'], shift: 'off' },
  '.': { keys: ['PERIOD'], shift: 'off' },
  '/': { keys: ['SLASH'], shift: 'off' },
  '<': { keys: ['COMMA'], shift: 'on' },
  '>': { keys: ['PERIOD'], shift: 'on' },
  '?': { keys: ['SLASH'], shift: 'on' },
  '[': { keys: ['COLON'], shift: 'on' },
  ']': { keys: ['SEMICOLON'], shift: 'on' },
  '^': { keys: ['UP_ARROW'], shift: 'off' },
  _: { keys: ['LEFT_ARROW'], shift: 'off' },
  '£': { keys: ['POUND'], shift: 'off' },
  ' ': { keys: ['SPACE'], shift: 'pass' },
};

const SPECIALS: Record<string, Resolved> = {
  Enter: { keys: ['RETURN'], shift: 'pass' },
  Backspace: { keys: ['DEL'], shift: 'pass' },
  Escape: { keys: ['RUN_STOP'], shift: 'pass' },
  Tab: { keys: ['CTRL'], shift: 'pass' },
  ArrowRight: { keys: ['CRSR_RIGHT'], shift: 'pass' },
  ArrowLeft: { keys: ['CRSR_RIGHT'], shift: 'on' },
  ArrowDown: { keys: ['CRSR_DOWN'], shift: 'pass' },
  ArrowUp: { keys: ['CRSR_DOWN'], shift: 'on' },
  Home: { keys: ['HOME'], shift: 'pass' },
  F1: { keys: ['F1'], shift: 'off' },
  F2: { keys: ['F1'], shift: 'on' },
  F3: { keys: ['F3'], shift: 'off' },
  F4: { keys: ['F3'], shift: 'on' },
  F5: { keys: ['F5'], shift: 'off' },
  F6: { keys: ['F5'], shift: 'on' },
  F7: { keys: ['F7'], shift: 'off' },
  F8: { keys: ['F7'], shift: 'on' },
};

function resolve(e: KeyEventLike): Resolved | null {
  if (e.key === 'Control') {
    return e.code === 'ControlLeft' ? { keys: ['COMMODORE'], shift: 'pass' } : null;
  }
  if (Object.hasOwn(SPECIALS, e.key)) return SPECIALS[e.key]!;
  if (e.key.length === 1) {
    if (/^[a-z]$/i.test(e.key)) return { keys: [e.key.toUpperCase() as C64Key], shift: 'pass' };
    if (/^[0-9]$/.test(e.key)) return { keys: [e.key as C64Key], shift: 'off' };
    return Object.hasOwn(SYMBOLS, e.key) ? SYMBOLS[e.key]! : null;
  }
  return null;
}

export class KeyMapper {
  private readonly held = new Map<string, Resolved>();
  private physicalShift = false;
  private readonly applied = new Set<C64Key>();

  constructor(private readonly sink: KeySink) {}

  down(e: KeyEventLike): boolean {
    this.physicalShift = e.shiftKey || e.key === 'Shift';
    if (e.key === 'Shift') {
      this.sync();
      return true;
    }
    if (e.key === 'PageUp') {
      this.sink.restore();
      return true;
    }
    const resolved = resolve(e);
    if (!resolved) return false;
    this.held.set(e.code, resolved);
    this.sync();
    return true;
  }

  up(e: KeyEventLike): boolean {
    this.physicalShift = e.key === 'Shift' ? false : e.shiftKey;
    if (e.key === 'Shift') {
      this.sync();
      return true;
    }
    if (e.key === 'PageUp') return true;
    if (!this.held.delete(e.code)) return false;
    this.sync();
    return true;
  }

  releaseAll(): void {
    this.held.clear();
    this.physicalShift = false;
    this.sync();
  }

  private sync(): void {
    const desired = new Set<C64Key>();
    let forceOn = false;
    let forceOff = false;
    for (const r of this.held.values()) {
      for (const k of r.keys) desired.add(k);
      if (r.shift === 'on') forceOn = true;
      if (r.shift === 'off') forceOff = true;
    }
    const shift = forceOn ? true : forceOff ? false : this.physicalShift;
    if (shift) desired.add('LSHIFT');
    for (const k of this.applied) {
      if (!desired.has(k)) {
        this.sink.release(k);
        this.applied.delete(k);
      }
    }
    for (const k of desired) {
      if (!this.applied.has(k)) {
        this.sink.press(k);
        this.applied.add(k);
      }
    }
  }
}
