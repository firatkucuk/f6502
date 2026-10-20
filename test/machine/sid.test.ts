import { describe, expect, it } from 'vitest';
import { C64 } from '../../src/machine/c64';
import { Sid } from '../../src/machine/sid';
import { SampleRing } from '../../src/machine/sid-output';
import { markerRoms } from './helpers';

function ticks(sid: Sid, n: number): void {
  for (let i = 0; i < n; i++) sid.tick();
}

describe('SampleRing', () => {
  it('drains what fits and keeps the rest', () => {
    const r = new SampleRing(8);
    for (let i = 0; i < 5; i++) r.push(i);
    const out = new Float32Array(3);
    expect(r.drain(out)).toBe(3);
    expect([...out]).toEqual([0, 1, 2]);
    expect(r.length).toBe(2);
  });

  it('drops the oldest samples on overflow instead of growing', () => {
    const r = new SampleRing(4);
    for (let i = 0; i < 10; i++) r.push(i);
    const out = new Float32Array(10);
    expect(r.drain(out)).toBe(4);
    expect([...out.subarray(0, 4)]).toEqual([6, 7, 8, 9]);
  });
});

describe('SID registers', () => {
  it('mirrors the 32 registers and reads $FF from the paddle registers', () => {
    const s = new Sid();
    expect(s.read(0x19)).toBe(0xff);
    expect(s.read(0x3a)).toBe(0xff); // $D41A mirrored at $D43A
  });

  it('write-only registers read the last bus value, which decays to zero', () => {
    const s = new Sid();
    s.write(0x00, 0xab);
    expect(s.read(0x01)).toBe(0xab);
    ticks(s, 9000);
    expect(s.read(0x01)).toBe(0);
  });

  it('reads of the readable registers refresh the bus value that write-only registers return', () => {
    const s = new Sid();
    s.write(0x0f, 0x10); // voice 3 FREQ hi
    s.write(0x12, 0x20); // saw
    ticks(s, 3000);
    s.write(0x10, 0xa5);
    expect(s.read(0x10)).toBe(0xa5);
    const osc3 = s.read(0x1b);
    expect(osc3).not.toBe(0xa5);
    expect(s.read(0x10)).toBe(osc3); // busvalue.prg: a write-only register reads the last OSC3 read
    expect(s.read(0x1d)).toBe(osc3); // and so does an unused register
    expect(s.read(0x19)).toBe(0xff);
    expect(s.read(0x10)).toBe(0xff);
    expect(s.peek(0x10)).toBe(0xff); // peek has no side effects
  });

  it('the bus value lives about $1D00 cycles on a 6581 and $A2000 cycles on an 8580', () => {
    const old = new Sid({ model: '6581' });
    old.write(0x00, 0xab);
    ticks(old, 0x1d00 - 1);
    expect(old.read(0x01)).toBe(0xab);
    ticks(old, 1);
    expect(old.read(0x01)).toBe(0);
    const neu = new Sid({ model: '8580' });
    neu.write(0x00, 0xab);
    ticks(neu, 0xa2000 - 1);
    expect(neu.read(0x01)).toBe(0xab);
    ticks(neu, 1);
    expect(neu.read(0x01)).toBe(0);
  });

  it('OSC3 and ENV3 read the live digital values of voice 3', () => {
    const s = new Sid();
    s.write(0x0f, 0x10); // voice 3 FREQ hi
    s.write(0x12, 0x20); // saw
    ticks(s, 100);
    const a = s.read(0x1b);
    ticks(s, 2000);
    expect(s.read(0x1b)).not.toBe(a);
    ticks(s, 40000); // the envelope has released from its power-up value and is frozen at zero
    expect(s.read(0x1c)).toBe(0);
    s.write(0x13, 0x00);
    s.write(0x14, 0xf0);
    s.write(0x12, 0x21); // gate
    let n = 0;
    while (s.read(0x1c) !== 1 && ++n < 40) ticks(s, 1); // sync to the first attack step
    ticks(s, 9 * 19);
    expect(s.read(0x1c)).toBe(20);
  });

  it('control writes reach the voice on the next cycle', () => {
    const s = new Sid();
    s.write(0x0e, 0x00);
    s.write(0x0f, 0x00);
    s.write(0x12, 0x08); // test bit holds the accumulator at 0
    ticks(s, 2);
    s.write(0x12, 0x20); // saw, test off
    s.write(0x0f, 0x80);
    ticks(s, 2);
    expect(s.peek(0x1b)).toBeGreaterThan(0);
  });
});

describe('OSC3 with the waveform deselected', () => {
  it('keeps the last output of the previous waveform even if it was never sampled', () => {
    const s = new Sid();
    s.write(0x0e, 0x00);
    s.write(0x0f, 0x00); // voice 3 frequency 0
    s.write(0x10, 0x00);
    s.write(0x11, 0x00); // pulse width 0: pulse output is all ones
    s.write(0x12, 0x40); // pulse
    ticks(s, 10); // envelope is zero: the mixer never evaluates this voice
    s.write(0x12, 0x00); // no waveform
    ticks(s, 10);
    expect(s.peek(0x1b)).toBe(0xff);
  });
});

describe('C64 wiring', () => {
  it('routes $D400-$D7FF to the SID and ticks it every cycle', () => {
    const c64 = new C64(markerRoms());
    expect(c64.sid.model).toBe('6581');
    c64.busWrite(0x01, 0x07); // I/O visible
    c64.busWrite(0xd40f, 0x10);
    c64.busWrite(0xd412, 0x20);
    c64.runCycles(500);
    const first = c64.sid.peek(0x1b);
    c64.runCycles(3000);
    expect(c64.sid.peek(0x1b)).not.toBe(first);
    expect(c64.busRead(0xd419)).toBe(0xff);
  });

  it('can be created with the 8580 model and a sample rate', () => {
    const c64 = new C64(markerRoms(), { sid: { model: '8580', sampleRate: 44100 } });
    expect(c64.sid.model).toBe('8580');
    expect(c64.sid.sampleRate).toBe(44100);
  });
});
