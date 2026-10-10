import { describe, expect, it } from 'vitest';
import { KeyQueue } from '../../src/browser/keyqueue';
import type { C64Key } from '../../src/machine/keyboard';

function rig(minHoldFrames?: number) {
  const calls: string[] = [];
  const queue = new KeyQueue(
    {
      press: (k: C64Key) => void calls.push(`+${k}`),
      release: (k: C64Key) => void calls.push(`-${k}`),
      restore: () => void calls.push('restore'),
    },
    minHoldFrames,
  );
  return { queue, calls };
}

describe('KeyQueue', () => {
  it('applies a press on the next pump and holds the key for at least 2 frames', () => {
    const { queue, calls } = rig();
    queue.press('A');
    queue.release('A'); // a tap shorter than one frame
    expect(calls).toEqual([]);
    queue.pump(); // frame 1: key goes down
    expect(calls).toEqual(['+A']);
    queue.pump(); // frame 2: still held
    expect(calls).toEqual(['+A']);
    queue.pump(); // frame 3: released
    expect(calls).toEqual(['+A', '-A']);
  });

  it('serialises the same key tapped twice so each tap is seen as a separate press', () => {
    const { queue, calls } = rig();
    queue.press('L');
    queue.release('L');
    queue.press('L');
    queue.release('L');
    for (let i = 0; i < 12; i++) queue.pump();
    expect(calls).toEqual(['+L', '-L', '+L', '-L']);
  });

  it('puts a key-up gap of at least one frame between taps', () => {
    const { queue, calls } = rig();
    queue.press('L');
    queue.release('L');
    queue.press('L');
    queue.pump();
    queue.pump();
    queue.pump();
    expect(calls).toEqual(['+L', '-L']); // the second press waits for the next frame
    queue.pump();
    expect(calls).toEqual(['+L', '-L', '+L']);
  });

  it('applies SHIFT and a key pressed together in the same frame', () => {
    const { queue, calls } = rig();
    queue.press('LSHIFT');
    queue.press('2');
    queue.pump();
    expect(calls).toEqual(['+LSHIFT', '+2']);
  });

  it('keeps RESTORE in order with key operations', () => {
    const { queue, calls } = rig();
    queue.press('A');
    queue.restore();
    queue.pump();
    expect(calls).toEqual(['+A', 'restore']);
  });

  it('flush applies everything immediately, in order', () => {
    const { queue, calls } = rig();
    queue.press('A');
    queue.release('A');
    queue.press('B');
    queue.flush();
    expect(calls).toEqual(['+A', '-A', '+B']);
    queue.pump();
    expect(calls).toHaveLength(3);
  });

  it('a held key is not released until its release is queued', () => {
    const { queue, calls } = rig();
    queue.press('A');
    for (let i = 0; i < 10; i++) queue.pump();
    expect(calls).toEqual(['+A']);
    queue.release('A');
    queue.pump();
    expect(calls).toEqual(['+A', '-A']);
  });
});
