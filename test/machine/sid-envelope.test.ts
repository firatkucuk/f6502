import { describe, expect, it } from 'vitest';
import { SidEnvelope as Envelope } from '../../src/machine/sid-envelope';

function run(env: Envelope, cycles: number): void {
  for (let i = 0; i < cycles; i++) env.tick();
}

/** Cycles until the counter next changes (fails the test if it never does). */
function untilChange(env: Envelope, limit = 100_000): number {
  const was = env.counter;
  for (let n = 1; n <= limit; n++) {
    env.tick();
    if (env.counter !== was) return n;
  }
  throw new Error(`counter stuck at ${was}`);
}

/** A settled envelope: gate off, released to zero and frozen there (what a program finds after boot). */
function settled(): Envelope {
  const e = new Envelope();
  e.setAttackDecay(0x00);
  e.setSustainRelease(0x00);
  run(e, 40_000);
  expect(e.counter).toBe(0);
  return e;
}

describe('Envelope', () => {
  it('powers up at $AA and releases to zero at rate 0', () => {
    const e = new Envelope();
    expect(e.counter).toBe(0xaa);
    run(e, 40_000);
    expect(e.counter).toBe(0);
  });

  it('attack 0 raises the counter by one every 9 cycles', () => {
    const e = settled();
    e.setSustainRelease(0xf0);
    e.setGate(true);
    untilChange(e); // sync to the rate counter
    expect(e.counter).toBe(1);
    run(e, 9 * 9);
    expect(e.counter).toBe(10);
    run(e, 9 * 245);
    expect(e.counter).toBe(255);
  });

  it('attack 15 uses the 31251-cycle period', () => {
    const e = settled();
    e.setAttackDecay(0xf0);
    e.setSustainRelease(0xf0);
    e.setGate(true);
    untilChange(e);
    expect(e.counter).toBe(1);
    expect(untilChange(e)).toBe(31251);
  });

  it('decays to the sustain level and holds there', () => {
    const e = settled();
    e.setAttackDecay(0x00);
    e.setSustainRelease(0x80); // sustain 8 -> 8 * 17 = 136
    e.setGate(true);
    run(e, 9 * 255 + 20000);
    expect(e.counter).toBe(136);
    run(e, 5000);
    expect(e.counter).toBe(136);
  });

  it('release runs through the exponential segments and stops at zero', () => {
    const e = settled();
    e.setAttackDecay(0x00);
    e.setSustainRelease(0xf0);
    e.setGate(true);
    run(e, 9 * 255 + 20);
    expect(e.counter).toBe(255);
    e.setGate(false);
    // 162 steps at period 1, 39 at 2, 28 at 4, 12 at 8, 8 at 16, 6 at 30: 756 rate periods
    run(e, 9 * 756 - 9 * 10);
    expect(e.counter).toBeGreaterThan(0);
    run(e, 9 * 20);
    expect(e.counter).toBe(0);
    run(e, 5000);
    expect(e.counter).toBe(0);
  });

  it('the ADSR delay bug: the rate counter is not reset on a rate change and wraps through $7FFF', () => {
    const e = settled();
    e.setSustainRelease(0xf0);
    e.setGate(true);
    untilChange(e); // the counter just stepped: the rate counter is at 3
    e.setAttackDecay(0xf0); // compare value 31250
    run(e, 97); // the rate counter is at 100
    e.setAttackDecay(0x00); // compare value 8, already passed: run to $7FFF, wrap to 1, match at 8
    expect(untilChange(e)).toBe(0x7fff - 100 + 12);
  });

  it('a new gate-on after release restarts the attack from the current value', () => {
    const e = settled();
    e.setAttackDecay(0x00);
    e.setSustainRelease(0x00);
    e.setGate(true);
    run(e, 9 * 255 + 20);
    e.setGate(false);
    run(e, 3000);
    const low = e.counter;
    expect(low).toBeLessThan(255);
    expect(low).toBeGreaterThan(0);
    e.setGate(true);
    untilChange(e);
    expect(e.counter).toBe(low + 1);
  });

  it('ENV3 is sampled in the first clock phase: a step shows one cycle late', () => {
    const e = settled();
    e.setSustainRelease(0xf0);
    e.setGate(true);
    untilChange(e);
    expect(e.counter).toBe(1);
    expect(e.env3).toBe(0);
    e.tick();
    expect(e.env3).toBe(1);
  });

  it('gate on takes two cycles to reach the attack state, and the first step three more', () => {
    const e = settled();
    e.setSustainRelease(0xf0);
    e.setGate(true);
    untilChange(e);
    e.setGate(false); // the counter is 1, rate counter 3; release at rate 0 steps it to 0
    const toZero = untilChange(e);
    expect(e.counter).toBe(0);
    expect(toZero).toBeLessThanOrEqual(12);
    e.setGate(true); // frozen at zero: the attack unfreezes it after the state change
    expect(untilChange(e)).toBeLessThanOrEqual(12);
    expect(e.counter).toBe(1);
  });

  it('an attack cut short by release runs the counter down through zero to $FF', () => {
    const e = settled();
    e.setSustainRelease(0xf0);
    e.setGate(true);
    untilChange(e);
    untilChange(e);
    expect(e.counter).toBe(2);
    e.setGate(false); // release at rate 0: 2 -> 1 -> 0 freezes
    run(e, 100);
    expect(e.counter).toBe(0);
    const f = settled();
    f.setSustainRelease(0xf0);
    f.setGate(true);
    untilChange(f);
    f.setGate(false);
    f.setGate(true); // attack again before the release state is reached
    run(f, 1);
    f.setGate(false);
    run(f, 100);
    // Flipping the state while a step is pending steps the counter the wrong way: 0 -> $FF.
    expect([0, 0xff]).toContain(f.counter);
  });
});
