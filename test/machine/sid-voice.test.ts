import { describe, expect, it } from 'vitest';
import { MODEL_6581, MODEL_8580 } from '../../src/machine/sid-model';
import { SidVoice as Voice } from '../../src/machine/sid-voice';

function pair(): { a: Voice; b: Voice } {
  const a = new Voice();
  const b = new Voice();
  b.source = a;
  a.source = b;
  return { a, b };
}

describe('Voice oscillator', () => {
  it('powers up with the accumulator at $555555', () => {
    expect(new Voice().acc).toBe(0x555555);
  });

  it('advances by FREQ every cycle and wraps at 24 bits', () => {
    const v = new Voice();
    v.acc = 0;
    v.freq = 0x1000;
    for (let i = 0; i < 16; i++) {
      v.advance();
      v.applySync();
    }
    expect(v.acc).toBe(0x10000);
    v.acc = 0xfffff0;
    v.freq = 0x20;
    v.advance();
    expect(v.acc).toBe(0x10);
  });

  it('the TEST bit holds the accumulator at zero', () => {
    const v = new Voice();
    v.freq = 0xffff;
    v.control = 0x08;
    v.advance();
    expect(v.acc).toBe(0);
  });
});

describe('Voice waveforms', () => {
  it('sawtooth is the top 12 bits', () => {
    const v = new Voice();
    v.control = 0x20;
    v.acc = 0x123456;
    expect(v.wave(MODEL_8580)).toBe(0x123);
  });

  it('triangle folds at the MSB', () => {
    const v = new Voice();
    v.control = 0x10;
    v.acc = 0x400000;
    expect(v.wave(MODEL_8580)).toBe(0x800);
    v.acc = 0x800000;
    expect(v.wave(MODEL_8580)).toBe(0xfff);
    v.acc = 0xffffff;
    expect(v.wave(MODEL_8580)).toBe(0x000);
  });

  it('pulse compares the top 12 bits with the pulse width', () => {
    const v = new Voice();
    v.control = 0x40;
    v.pw = 0x800;
    v.acc = 0x7ff000;
    v.advance(); // freq 0: the accumulator stays, the comparator result is latched
    expect(v.wave(MODEL_8580)).toBe(0);
    v.acc = 0x800000;
    v.advance();
    expect(v.wave(MODEL_8580)).toBe(0xfff);
  });

  it('the pulse comparator result is one cycle behind the accumulator', () => {
    const v = new Voice();
    v.control = 0x40;
    v.pw = 0x800;
    v.acc = 0x7ff000;
    v.freq = 0x1000;
    v.advance(); // accumulator reaches $800000, but the output still shows the old compare
    expect(v.acc).toBe(0x800000);
    expect(v.wave(MODEL_8580)).toBe(0);
    v.advance();
    expect(v.wave(MODEL_8580)).toBe(0xfff);
  });

  it('pulse is held high by the TEST bit', () => {
    const v = new Voice();
    v.control = 0x40;
    v.pw = 0xfff;
    v.acc = 0;
    v.advance();
    expect(v.wave(MODEL_8580)).toBe(0);
    v.setControl(0x48, MODEL_8580);
    expect(v.wave(MODEL_8580)).toBe(0xfff);
    v.advance();
    expect(v.wave(MODEL_8580)).toBe(0xfff);
    v.setControl(0x40, MODEL_8580); // released: the compare of accumulator 0 against PW=$FFF
    v.advance();
    expect(v.wave(MODEL_8580)).toBe(0);
  });

  it('the 8580 shows triangle and sawtooth on OSC3 one cycle late, the 6581 at once', () => {
    const v = new Voice();
    v.control = 0x20;
    v.freq = 0x1000;
    v.acc = 0;
    for (let i = 0; i < 2; i++) {
      v.advance();
      v.latch(MODEL_8580);
    }
    expect(v.wave(MODEL_8580)).toBe(2); // the audio output is not delayed
    expect(v.osc3(MODEL_8580)).toBe(1);
    expect(v.osc3(MODEL_6581)).toBe(2);
    v.setControl(0x20, MODEL_8580); // a control write feeds the latch from the current value
    expect(v.osc3(MODEL_8580)).toBe(2);
    v.pw = 0xfff;
    v.setControl(0x60, MODEL_8580); // saw + pulse: the (pipelined) pulse level masks the latch
    expect(v.osc3(MODEL_8580)).toBe(2);
    v.advance();
    v.latch(MODEL_8580);
    expect(v.osc3(MODEL_8580)).toBe(0);
  });

  it('ring mod with both oscillators at zero inverts the triangle (OSC3 = $FF)', () => {
    const { a, b } = pair();
    a.acc = 0;
    b.acc = 0;
    b.control = 0x14; // triangle + ring mod
    expect(b.wave(MODEL_8580) >> 4).toBe(0xff);
  });

  it('without a waveform selected the output holds, then decays to zero', () => {
    const v = new Voice();
    v.control = 0x40;
    v.pw = 0;
    v.acc = 0x800000;
    expect(v.wave(MODEL_8580)).toBe(0xfff);
    v.control = 0x00;
    expect(v.wave(MODEL_8580)).toBe(0xfff);
    for (let i = 0; i < 3_000_000; i++) v.advance();
    expect(v.wave(MODEL_8580)).toBe(0);
  });
});

describe('Voice noise', () => {
  it('the LFSR powers up at $7FFFF8 and shifts in (bit22 xor bit17)', () => {
    const v = new Voice();
    expect(v.lfsr).toBe(0x7ffff8);
    v.acc = 0x07ffff;
    v.freq = 1;
    v.control = 0x80;
    v.advance(); // accumulator bit 19 rises
    expect(v.lfsr).toBe(0x7ffff0);
  });

  it('noise output is taken from LFSR bits 20,18,14,11,9,5,2,0', () => {
    const v = new Voice();
    v.control = 0x80;
    v.lfsr = 0x100000; // only bit 20 set -> output bit 11
    expect(v.wave(MODEL_8580)).toBe(0x800);
    v.lfsr = 0x000001; // only bit 0 -> output bit 4
    expect(v.wave(MODEL_8580)).toBe(0x010);
  });

  it('the LFSR is reset after the TEST bit has been held long enough', () => {
    const v = new Voice();
    v.lfsr = 0x123456;
    v.control = 0x08;
    for (let i = 0; i < 0x9000; i++) v.advance();
    expect(v.lfsr).toBe(0x7ffff8);
  });
});

describe('Voice sync and combined waveforms', () => {
  it('hard sync clears the accumulator when the source MSB rises', () => {
    const { a, b } = pair();
    a.acc = 0x7fffff;
    a.freq = 1;
    b.acc = 0x123456;
    b.freq = 0;
    b.control = 0x02;
    a.advance();
    b.advance();
    a.applySync();
    b.applySync();
    expect(b.acc).toBe(0);
  });

  it('combined waveforms are the AND of the selected waveforms (8580)', () => {
    const v = new Voice();
    v.control = 0x30; // triangle + saw
    v.acc = 0x6a5000;
    const tri = (v.acc >> 11) & 0xfff & 0xfff;
    const saw = (v.acc >> 12) & 0xfff;
    expect(v.wave(MODEL_8580)).toBe(tri & saw);
  });

  it('the 6581 triangle+sawtooth never reaches the top bit (chip detection relies on it)', () => {
    const v = new Voice();
    v.control = 0x30;
    for (const acc of [0x800000, 0xc00000, 0xff0000, 0xfff000]) {
      v.acc = acc;
      expect(v.wave(MODEL_6581) & 0x800).toBe(0);
    }
    v.acc = 0xff0000;
    expect(v.wave(MODEL_8580) & 0x800).toBe(0x800);
  });

  it('the 6581 leaks combined waveforms more than the 8580 (never more bits set)', () => {
    const v = new Voice();
    v.control = 0x60;
    v.pw = 0x400;
    v.acc = 0x6a5000;
    const w8580 = v.wave(MODEL_8580);
    const w6581 = v.wave(MODEL_6581);
    expect(w6581 & ~w8580).toBe(0);
  });

  it('noise combined with another waveform never leaves the LFSR dead', () => {
    const v = new Voice();
    v.control = 0xa0;
    v.freq = 0x4000;
    for (let i = 0; i < 20000; i++) {
      v.advance();
      v.wave(MODEL_6581);
    }
    expect(v.lfsr).not.toBe(0);
  });
});
