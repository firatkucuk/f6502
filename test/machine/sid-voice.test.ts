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
    v.setControl(0x00, MODEL_8580);
    expect(v.wave(MODEL_8580)).toBe(0xfff);
    for (let i = 0; i < 3_000_000; i++) v.advance();
    expect(v.wave(MODEL_8580)).toBe(0);
  });
});

/** Shift register bits 20,18,14,11,9,5,2,0: the noise output taps. */
const TAPS = 0x144a25;

/** One SID cycle of a lone voice: oscillator, (no sync), output stage. */
function cycle(v: Voice, model = MODEL_6581, n = 1): void {
  for (let i = 0; i < n; i++) {
    v.advance();
    v.latch(model);
  }
}

describe('Voice noise', () => {
  it('the LFSR powers up at $7FFFFE (all ones, shifted once by reset)', () => {
    const v = new Voice();
    expect(v.lfsr).toBe(0x7ffffe);
    v.control = 0x80;
    expect(v.wave(MODEL_6581) >> 4).toBe(0xfe); // oscinit/noiseinit.prg
  });

  it('shifts in (bit22 xor bit17) two cycles after accumulator bit 19 rises', () => {
    const v = new Voice();
    v.lfsr = 0x7ffff8;
    v.acc = 0x07ffff;
    v.freq = 1;
    v.control = 0x80;
    cycle(v); // accumulator bit 19 rises: the shift is detected
    expect(v.lfsr).toBe(0x7ffff8);
    cycle(v); // first shift phase
    expect(v.lfsr).toBe(0x7ffff8);
    cycle(v); // second phase: the register moves
    expect(v.lfsr).toBe(0x7ffff0);
  });

  it('releasing TEST shifts once, with the feedback input held high (bit 0 = ~bit 17)', () => {
    const v = new Voice();
    v.lfsr = 0x7fffff;
    v.setControl(0x88, MODEL_6581);
    cycle(v);
    v.setControl(0x80, MODEL_6581);
    expect(v.lfsr).toBe(0x7ffffe);
    v.setControl(0x88, MODEL_6581);
    v.setControl(0x80, MODEL_6581);
    expect(v.lfsr).toBe(0x7ffffc);
    v.lfsr = 0x7dffff; // bit 17 clear: a one comes in
    v.setControl(0x88, MODEL_6581);
    v.setControl(0x80, MODEL_6581);
    expect(v.lfsr).toBe(0x7bffff);
  });

  it('noise output is taken from LFSR bits 20,18,14,11,9,5,2,0', () => {
    const v = new Voice();
    v.control = 0x80;
    v.lfsr = 0x100000; // only bit 20 set -> output bit 11
    expect(v.wave(MODEL_8580)).toBe(0x800);
    v.lfsr = 0x000001; // only bit 0 -> output bit 4
    expect(v.wave(MODEL_8580)).toBe(0x010);
  });

  it('under TEST the LFSR recovers to all ones, from the bottom up, after a model-specific delay', () => {
    const v = new Voice();
    v.lfsr = 0x000000;
    v.setControl(0x88, MODEL_6581);
    cycle(v, MODEL_6581, 35_000 - 1);
    expect(v.lfsr).toBe(0);
    cycle(v, MODEL_6581, 1);
    expect(v.lfsr).toBe(1);
    cycle(v, MODEL_6581, 1000);
    expect(v.lfsr).toBe(3);
    cycle(v, MODEL_6581, 1000 * 21);
    expect(v.lfsr).toBe(0x7fffff);
    const neu = new Voice();
    neu.lfsr = 0;
    neu.setControl(0x88, MODEL_8580);
    cycle(neu, MODEL_8580, 2_519_864 + 315_000 * 22);
    expect(neu.lfsr).toBe(0x7fffff);
    // The register keeps shifting in zeros while the output is not all ones, so releasing
    // TEST before the recovery is complete shows the partial state (noiselfsrinit relies on it).
    const partial = new Voice();
    partial.lfsr = 0;
    partial.setControl(0x88, MODEL_6581);
    cycle(partial, MODEL_6581, 36_500);
    expect(partial.lfsr).toBe(3);
  });

  it('combined waveforms write their zero output bits back into the shift register', () => {
    const v = new Voice();
    v.lfsr = 0x7fffff;
    v.freq = 0;
    v.acc = 0;
    v.setControl(0xa0, MODEL_8580); // noise + sawtooth of accumulator 0: every bit low
    expect(v.wave(MODEL_8580)).toBe(0);
    expect(v.lfsr).toBe(0x7fffff & ~TAPS); // bits 20,18,14,11,9,5,2,0 cleared
    v.setControl(0x80, MODEL_8580);
    expect(v.wave(MODEL_8580)).toBe(0);
  });

  it('the write-back pauses during the first shift phase', () => {
    const v = new Voice();
    v.lfsr = 0x7fffff;
    v.acc = 0x07ffff;
    v.freq = 1;
    v.pw = 0xfff;
    v.control = 0xc0; // noise + pulse: the pulse line is low, every output bit low
    v.lfsr = 0x7fffff;
    cycle(v, MODEL_8580); // bit 19 rises: shift detected, write-back still happens
    expect(v.lfsr).toBe(0x7fffff & ~TAPS);
    v.lfsr = 0x7fffff;
    cycle(v, MODEL_8580); // first shift phase: no write-back
    expect(v.lfsr).toBe(0x7fffff);
    cycle(v, MODEL_8580); // the shift, then the write-back again
    expect(v.lfsr).toBe(0x7ffffe & ~TAPS);
  });

  it('releasing TEST writes the last output back first for most combined waveforms', () => {
    const v = new Voice();
    v.lfsr = 0x7fffff;
    v.setControl(0xf8, MODEL_6581); // all waveforms + TEST: output 0
    cycle(v);
    v.setControl(0x80, MODEL_6581); // $F -> $8: write-back, then the shift
    expect(v.lfsr).toBe(((0x7fffff & ~TAPS) << 1) & 0x7fffff);
    const w = new Voice();
    w.lfsr = 0x7fffff;
    w.setControl(0x98, MODEL_6581);
    cycle(w);
    w.setControl(0x80, MODEL_6581); // $9 -> $8: no write-back (sampled on real chips)
    expect(w.lfsr).toBe(0x7ffffe);
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

  it('noise combined with another waveform locks the LFSR up at zero; TEST revives it', () => {
    const v = new Voice();
    v.setControl(0xa0, MODEL_6581);
    v.freq = 0x4000;
    cycle(v, MODEL_6581, 20000);
    expect(v.lfsr).toBe(0);
    expect(v.wave(MODEL_6581)).toBe(0);
    v.setControl(0xa8, MODEL_6581);
    cycle(v, MODEL_6581, 35_000 + 1000 * 23);
    expect(v.lfsr).toBe(0x7fffff);
  });

  it('on the 6581 a sawtooth combination with a low top bit pulls the accumulator MSB low', () => {
    const v = new Voice();
    v.freq = 1;
    v.pw = 0xfff; // the pulse output is low
    v.acc = 0x800000;
    v.setControl(0x60, MODEL_6581);
    cycle(v, MODEL_6581);
    expect(v.acc).toBe(0x000001); // osc_topbit_test_pulse_old.prg
    v.acc = 0x800000;
    v.setControl(0x60, MODEL_8580);
    cycle(v, MODEL_8580);
    expect(v.acc).toBe(0x800001); // the 8580 buffers the MSB
    v.acc = 0x800000;
    v.setControl(0x20, MODEL_6581); // sawtooth alone: no pull-down
    cycle(v, MODEL_6581);
    expect(v.acc).toBe(0x800001);
  });
});
