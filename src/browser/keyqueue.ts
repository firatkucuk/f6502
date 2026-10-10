import type { C64Key } from '../machine/keyboard';
import type { KeySink } from './keymap';

const MODIFIERS: ReadonlySet<C64Key> = new Set<C64Key>(['LSHIFT', 'RSHIFT', 'CTRL', 'COMMODORE']);

type Op = { type: 'press' | 'release'; key: C64Key } | { type: 'restore' };

/**
 * Frame-synchronous key delivery. The KERNAL scans the keyboard about once per frame, so a
 * down+up pair that arrives within one frame (fast typing, scripted input) would be lost.
 * Every key stays down for at least `minHoldFrames` frames and consecutive taps of the same
 * key are separated by a key-up frame. At most one non-modifier key goes down per frame: two
 * distinct keys appearing in the same scan make the KERNAL drop the first one (rollover).
 */
export class KeyQueue implements KeySink {
  private readonly ops: Op[] = [];
  private readonly pressedAt = new Map<C64Key, number>();
  private frame = 0;

  constructor(
    private readonly target: KeySink,
    private readonly minHoldFrames = 2,
  ) {}

  press(key: C64Key): void {
    this.ops.push({ type: 'press', key });
  }

  release(key: C64Key): void {
    this.ops.push({ type: 'release', key });
  }

  restore(): void {
    this.ops.push({ type: 'restore' });
  }

  /** Call once per emulated frame, before running it. */
  pump(): void {
    this.frame++;
    let keyDownThisFrame = false;
    while (this.ops.length > 0) {
      const op = this.ops[0]!;
      if (op.type === 'release') {
        const pressed = this.pressedAt.get(op.key) ?? Number.NEGATIVE_INFINITY;
        if (this.frame - pressed < this.minHoldFrames) return;
        this.ops.shift();
        this.pressedAt.delete(op.key);
        this.target.release(op.key);
        return; // at most one release per frame, so the matrix shows a key-up gap
      }
      if (op.type === 'press' && !MODIFIERS.has(op.key)) {
        if (keyDownThisFrame) return;
        keyDownThisFrame = true;
      }
      this.ops.shift();
      if (op.type === 'press') {
        this.pressedAt.set(op.key, this.frame);
        this.target.press(op.key);
      } else {
        this.target.restore();
      }
    }
  }

  /** Applies every queued operation immediately, in order (blur, destroy). */
  flush(): void {
    for (const op of this.ops) {
      if (op.type === 'press') this.target.press(op.key);
      else if (op.type === 'release') this.target.release(op.key);
      else this.target.restore();
    }
    this.ops.length = 0;
    this.pressedAt.clear();
  }
}
