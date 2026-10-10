import { describe, expect, it } from 'vitest';
import { FrameClock } from '../../src/browser/clock';

describe('FrameClock', () => {
  it('first call primes and returns 0', () => {
    expect(new FrameClock().advance(1000)).toBe(0);
  });

  it('runs about one frame per 19.95 ms and carries the fraction', () => {
    const clock = new FrameClock();
    clock.advance(0);
    let frames = 0;
    for (let t = 16.667; t < 1000; t += 16.667) frames += clock.advance(t);
    expect(frames).toBeGreaterThanOrEqual(49);
    expect(frames).toBeLessThanOrEqual(51);
  });

  it('clamps a huge gap (hidden tab) to at most 5 frames', () => {
    const clock = new FrameClock();
    clock.advance(0);
    expect(clock.advance(60_000)).toBeLessThanOrEqual(5);
  });

  it('negative or zero elapsed time yields 0 frames', () => {
    const clock = new FrameClock();
    clock.advance(100);
    expect(clock.advance(90)).toBe(0);
  });

  it('reset re-primes (used on resume)', () => {
    const clock = new FrameClock();
    clock.advance(0);
    clock.reset();
    expect(clock.advance(500)).toBe(0);
  });
});
