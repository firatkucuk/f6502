import type { SidModelParams } from './sid-model';

const NOISE_RESET = 0x7ffff8;
const NOISE_TAPS = [20, 18, 14, 11, 9, 5, 2, 0];
/** Cycles the TEST bit must be held before the LFSR is reset. */
const TEST_LFSR_DELAY = 0x8000;
/** Cycles after which a floating (no waveform selected) output has decayed to zero. */
const FLOAT_DECAY_CYCLES = 2_500_000;

/** One SID voice: 24-bit phase accumulator, noise LFSR and the waveform generators. */
export class Voice {
  acc = 0x555555;
  lfsr = NOISE_RESET;
  freq = 0;
  pw = 0;
  control = 0;
  /** The neighbouring voice that drives sync and ring modulation (set by `Sid`). */
  source: Voice = this;
  /** True for the cycle in which the accumulator MSB went from 0 to 1. */
  msbRising = false;

  private testCycles = 0;
  private floating = 0;
  private floatAge = 0;

  reset(): void {
    this.acc = 0x555555; // power-up value; real reset leaves it unchanged, which the harness mirrors
    this.lfsr = NOISE_RESET;
    this.freq = 0;
    this.pw = 0;
    this.control = 0;
    this.msbRising = false;
    this.testCycles = 0;
    this.floating = 0;
    this.floatAge = 0;
  }

  /** Write the control register. Deselecting every waveform latches the last output first. */
  setControl(value: number, model: SidModelParams): void {
    const oldSel = this.control & 0xf0;
    const newSel = value & 0xf0;
    if (oldSel !== 0 && newSel === 0) this.wave(model); // latch what was last on the output
    this.control = value;
    if (newSel === 0 && oldSel !== 0) this.floatAge = 0;
  }

  /** Advance the oscillator by one cycle (before sync is applied). */
  advance(): void {
    const control = this.control;
    if ((control & 0x08) !== 0) {
      this.acc = 0;
      this.msbRising = false;
      if (++this.testCycles >= TEST_LFSR_DELAY) this.lfsr = NOISE_RESET;
    } else {
      if (this.testCycles !== 0) this.testCycles = 0;
      const old = this.acc;
      const acc = (old + this.freq) & 0xffffff;
      this.acc = acc;
      const rose = (old ^ acc) & acc; // bits that went 0 -> 1
      this.msbRising = (rose & 0x800000) !== 0;
      if ((rose & 0x080000) !== 0) this.clockNoise();
    }
    if ((control & 0xf0) === 0 && this.floatAge < FLOAT_DECAY_CYCLES) this.floatAge++;
  }

  /** Hard sync: if enabled, a rising MSB of the source voice resets this accumulator. */
  applySync(): void {
    if ((this.control & 0x02) !== 0 && this.source.msbRising) this.acc = 0;
  }

  private clockNoise(): void {
    const bit0 = ((this.lfsr >> 22) ^ (this.lfsr >> 17)) & 1;
    this.lfsr = ((this.lfsr << 1) | bit0) & 0x7fffff;
  }

  private noiseOut(): number {
    const l = this.lfsr;
    return (
      (((l >> 20) & 1) << 11) |
      (((l >> 18) & 1) << 10) |
      (((l >> 14) & 1) << 9) |
      (((l >> 11) & 1) << 8) |
      (((l >> 9) & 1) << 7) |
      (((l >> 5) & 1) << 6) |
      (((l >> 2) & 1) << 5) |
      ((l & 1) << 4)
    );
  }

  /** 12-bit waveform output for the current accumulator and control bits. */
  wave(model: SidModelParams): number {
    const sel = this.control & 0xf0;
    if (sel === 0) {
      if (this.floatAge >= FLOAT_DECAY_CYCLES) this.floating = 0;
      return this.floating;
    }
    const acc = this.acc;
    let out = 0xfff;
    let waves = 0;
    if (sel & 0x10) {
      const ring = (this.control & 0x04) !== 0;
      const srcMsb = (this.source.acc >> 23) & 1;
      const invert =
        (sel & 0x20) === 0 && ((ring && srcMsb === 0 ? 1 : 0) ^ ((acc >> 23) & 1)) === 1;
      out &= ((invert ? ~acc & 0xffffff : acc) >> 11) & 0xfff;
      waves++;
    }
    if (sel & 0x20) {
      out &= (acc >> 12) & 0xfff;
      waves++;
    }
    if (sel & 0x40) {
      out &= (this.control & 0x08) !== 0 || acc >> 12 >= this.pw ? 0xfff : 0;
      waves++;
    }
    if (waves > 1) out = model.combine(out, sel);
    if (sel & 0x80) {
      if (waves === 0) {
        out = this.noiseOut();
      } else {
        // Noise combined with another waveform pulls the LFSR bits towards zero (write-back).
        const noise = this.noiseOut();
        out &= noise;
        this.writeBack(out);
      }
    }
    this.floating = out;
    this.floatAge = 0;
    return out;
  }

  private writeBack(out: number): void {
    const taps = NOISE_TAPS;
    let l = this.lfsr;
    for (let i = 0; i < 8; i++) {
      if (((out >> (11 - i)) & 1) === 0) l &= ~(1 << taps[i]!);
    }
    // A dead register would stay dead: the real chip recovers through the test bit; keep it alive.
    this.lfsr = l === 0 ? NOISE_RESET : l;
  }
}
