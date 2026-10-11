import { describe, expect, it } from 'vitest';
import { SidEnvelope as Envelope } from '../../src/machine/sid-envelope';

function run(env: Envelope, cycles: number): void {
  for (let i = 0; i < cycles; i++) env.tick();
}

describe('Envelope', () => {
  it('attack 0 raises the counter by one every 9 cycles', () => {
    const e = new Envelope();
    e.setAttackDecay(0x00);
    e.setSustainRelease(0xf0);
    e.setGate(true);
    run(e, 9 * 10);
    expect(e.counter).toBe(10);
    run(e, 9 * 245);
    expect(e.counter).toBe(255);
  });

  it('attack 15 uses the 31251-cycle period', () => {
    const e = new Envelope();
    e.setAttackDecay(0xf0);
    e.setSustainRelease(0xf0);
    e.setGate(true);
    run(e, 31250);
    expect(e.counter).toBe(0);
    run(e, 1);
    expect(e.counter).toBe(1);
  });

  it('decays to the sustain level and holds there', () => {
    const e = new Envelope();
    e.setAttackDecay(0x00);
    e.setSustainRelease(0x80); // sustain 8 -> 8 * 17 = 136
    e.setGate(true);
    run(e, 9 * 255 + 20000);
    expect(e.counter).toBe(136);
    run(e, 5000);
    expect(e.counter).toBe(136);
  });

  it('release runs through the exponential segments and stops at zero', () => {
    const e = new Envelope();
    e.setAttackDecay(0x00);
    e.setSustainRelease(0xf0);
    e.setGate(true);
    run(e, 9 * 255 + 5);
    expect(e.counter).toBe(255);
    e.setGate(false);
    run(e, 9 * 756 - 9 * 10);
    expect(e.counter).toBeGreaterThan(0);
    run(e, 9 * 20);
    expect(e.counter).toBe(0);
    run(e, 5000);
    expect(e.counter).toBe(0);
  });

  it('the ADSR delay bug: the rate counter is not reset on a rate change and wraps through $7FFF', () => {
    const e = new Envelope();
    e.setAttackDecay(0xf0); // period 31251
    e.setSustainRelease(0xf0);
    e.setGate(true);
    run(e, 100);
    e.setAttackDecay(0x00); // period 9, but the counter is already at 100
    run(e, 32676);
    expect(e.counter).toBe(0);
    run(e, 1);
    expect(e.counter).toBe(1);
  });

  it('a new gate-on after release restarts the attack from the current value', () => {
    const e = new Envelope();
    e.setAttackDecay(0x00);
    e.setSustainRelease(0x00);
    e.setGate(true);
    run(e, 9 * 255 + 9);
    e.setGate(false);
    run(e, 40000);
    const low = e.counter;
    expect(low).toBeLessThan(255);
    e.setGate(true);
    run(e, 9 * 3);
    expect(e.counter).toBe(Math.min(255, low + 3));
  });
});
