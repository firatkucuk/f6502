export interface SidModelParams {
  name: '6581' | '8580';
  /** Waveform "zero" level (12-bit): the value that produces no output after the envelope DAC. */
  zero: number;
  /** Leakage applied to the AND of combined waveforms (analytical approximation, not measured tables). */
  combine(and: number, selection: number): number;
  /** Filter cutoff in Hz for an 11-bit FC value. */
  cutoffHz(fc: number): number;
  /** Filter damping Q for a 4-bit resonance value. */
  q(resonance: number): number;
  /** DC level (relative to one voice's full scale) that the master volume scales. */
  dcLevel: number;
  /**
   * Cycles a value stays on the internal data bus (what write-only and unused registers read)
   * before it has decayed to zero. Measured with bitfade/delayfrq0.prg: about $1D00 on a 6581
   * and $A2000 on an 8580.
   */
  busTtl: number;
  /**
   * The 8580 latches the triangle/sawtooth output in the first clock phase, so OSC3 shows it
   * one cycle late (the audio output is not delayed). The 6581 connects it directly.
   */
  osc3Delay: boolean;
  /**
   * On the 6581 the accumulator MSB feeds the sawtooth switch directly, so when a combined
   * waveform with sawtooth drives output bit 11 low, the MSB is pulled low for the next cycle.
   * The 8580 buffers the MSB with a flip-flop.
   */
  msbPulldown: boolean;
  /**
   * Noise combined with pulse (waveform selections $C-$F): the shift register bits are shorted
   * through the pulse line, which leaves only runs of set bits (per model) on the output.
   */
  noisePulse(noise: number): number;
  /**
   * Cycles the TEST bit must be held before the noise shift register starts to recover (its
   * cells drift to one), and the cycles per further step of that recovery.
   */
  lfsrResetStart: number;
  lfsrResetStep: number;
}

export const MODEL_8580: SidModelParams = {
  name: '8580',
  zero: 0x800,
  combine: (and) => and,
  cutoffHz: (fc) => 30 + (12000 * fc) / 2047,
  q: (r) => 0.707 + (r / 15) * 6,
  dcLevel: 0.01,
  busTtl: 0xa2000,
  osc3Delay: true,
  msbPulldown: false,
  // A bit survives if the one below it is set as well; the top six bits always come through.
  noisePulse: (noise) => (noise < 0xfc0 ? noise & (noise << 1) & 0xfff : 0xfc0),
  lfsrResetStart: 2_519_864, // about 2.5 s, then roughly 0.3 s per bit
  lfsrResetStep: 315_000,
};

export const MODEL_6581: SidModelParams = {
  name: '6581',
  zero: 0x380,
  // Weak output stages: a combined bit only survives if a neighbouring bit is also set.
  combine: (and, selection) => {
    const weak = and & (((and << 1) | (and >> 1) | 1) & 0xfff);
    // Triangle + sawtooth on the 6581 is so weak that the top bit never comes out.
    return (selection & 0x30) === 0x30 ? weak & 0x7ff : weak;
  },
  cutoffHz: (fc) => 200 * Math.pow(60, fc / 2047),
  q: (r) => 0.707 + (r / 15) * 8,
  dcLevel: 0.05,
  busTtl: 0x1d00,
  osc3Delay: false,
  msbPulldown: true,
  // Nothing comes through unless the top four bits are set; then a bit needs the two below it.
  noisePulse: (noise) => (noise < 0xf00 ? 0 : noise & (noise << 1) & (noise << 2) & 0xfff),
  lfsrResetStart: 35_000, // about $8000 cycles, then a step per bit
  lfsrResetStep: 1_000,
};

export function modelByName(name: '6581' | '8580'): SidModelParams {
  return name === '8580' ? MODEL_8580 : MODEL_6581;
}
