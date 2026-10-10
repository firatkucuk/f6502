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
}

export const MODEL_8580: SidModelParams = {
  name: '8580',
  zero: 0x800,
  combine: (and) => and,
  cutoffHz: (fc) => 30 + (12000 * fc) / 2047,
  q: (r) => 0.707 + (r / 15) * 6,
};

export const MODEL_6581: SidModelParams = {
  name: '6581',
  zero: 0x380,
  // Weak output stages: a combined bit only survives if a neighbouring bit is also set.
  combine: (and) => and & (((and << 1) | (and >> 1) | 1) & 0xfff),
  cutoffHz: (fc) => 200 * Math.pow(60, fc / 2047),
  q: (r) => 0.707 + (r / 15) * 8,
};

export function modelByName(name: '6581' | '8580'): SidModelParams {
  return name === '8580' ? MODEL_8580 : MODEL_6581;
}
