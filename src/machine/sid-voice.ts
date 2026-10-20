import type { SidModelParams } from './sid-model';

/**
 * The 23-bit noise shift register after reset: all ones, shifted once when reset is released
 * (bit 0 = ~bit 17 while reset/TEST holds the feedback input high).
 */
const NOISE_RESET = 0x7ffffe;
/** The shift register bits that drive output bits 11..4. */
const NOISE_TAPS = [20, 18, 14, 11, 9, 5, 2, 0] as const;
const NOISE_TAP_MASK =
  (1 << 20) | (1 << 18) | (1 << 14) | (1 << 11) | (1 << 9) | (1 << 5) | (1 << 2) | 1;
/** Cycles after which a floating (no waveform selected) output has decayed to zero. */
const FLOAT_DECAY_CYCLES = 2_500_000;

/**
 * Whether releasing TEST while switching from waveform selection `prev` to `next` writes the
 * last output back into the shift register before the shift. Combined waveforms drive the
 * register bits through the output while the bits are interconnected for the shift; which
 * transitions actually do so was found by sampling (the noisewriteback test suite), not from
 * the die, and the rules below reproduce those samplings.
 */
function preWriteback(prev: number, next: number, model: SidModelParams): boolean {
  if (prev <= 8) return false; // no combined waveform, nothing drives the bits
  if (next === 8 && prev !== 0xf) return false;
  if (prev === 0xc) return !model.msbPulldown && (next === 0x9 || next === 0xe);
  // On the 6581 a swap between triangle and sawtooth (with noise) leaves the register alone.
  if (
    model.msbPulldown &&
    ((prev & 3) === 1 ? (next & 3) === 2 : (prev & 3) === 2 && (next & 3) === 1)
  )
    return false;
  return true;
}

/** One SID voice: 24-bit phase accumulator, noise LFSR and the waveform generators. */
export class SidVoice {
  acc = 0x555555;
  lfsr = NOISE_RESET;
  freq = 0;
  pw = 0;
  control = 0;
  /** The neighbouring voice that drives sync and ring modulation (set by `Sid`). */
  source: SidVoice = this;
  /** True for the cycle in which the accumulator MSB went from 0 to 1. */
  msbRising = false;
  /**
   * The pulse comparator output (all ones or all zeros) for the current cycle. The compare is
   * pipelined one cycle behind the accumulator, and the TEST bit forces it high.
   */
  pulseOut = 0xfff;
  /**
   * The 8580's triangle/sawtooth latch (`SidModelParams.osc3Delay`): `triSawPipe` is what the
   * last cycle computed, `triSawPrev` the value before it, which is what OSC3 shows.
   * Power-up values; reset does not touch them.
   */
  private triSawPipe = 0x555;
  private triSawPrev = 0x555;
  /**
   * Accumulator bit 19 rising clocks the shift register two cycles later: 2 = detected,
   * 1 = first shift phase (the bits are interconnected), 0 = idle.
   */
  private shiftPipeline = 0;
  /** Cycles until the next step of the shift register recovering to all ones under TEST. */
  private lfsrResetTtl = 0;
  private lfsrRecoverDue = false;
  /**
   * Combined waveforms with noise, and sawtooth combinations on the 6581, feed back into the
   * oscillator every cycle; their output is then computed each cycle (`latch`) and held here.
   */
  private eager = false;
  private eagerOut = 0;
  private floating = 0;
  private floatingOsc3 = 0;
  private floatAge = 0;

  reset(): void {
    this.acc = 0x555555; // power-up value; real reset leaves it unchanged, which the harness mirrors
    this.lfsr = NOISE_RESET;
    this.freq = 0;
    this.pw = 0;
    this.control = 0;
    this.msbRising = false;
    this.pulseOut = 0xfff;
    this.shiftPipeline = 0;
    this.lfsrResetTtl = 0;
    this.lfsrRecoverDue = false;
    this.eager = false;
    this.eagerOut = 0;
    this.floating = 0;
    this.floatingOsc3 = 0;
    this.floatAge = 0;
  }

  /** Write the control register. Deselecting every waveform latches the last output first. */
  setControl(value: number, model: SidModelParams): void {
    const oldSel = this.control & 0xf0;
    const newSel = value & 0xf0;
    if (oldSel !== 0 && newSel === 0) {
      // Latch what was last on the output (and what OSC3 showed of it).
      this.floatingOsc3 = this.osc3(model);
      this.floating = this.wave(model);
      this.floatAge = 0;
    }
    const testWas = (this.control & 0x08) !== 0;
    const testNow = (value & 0x08) !== 0;
    if (!testWas && testNow) {
      // TEST clears the accumulator at once, holds the pulse line high, flushes a pending shift
      // and starts the slow recovery of the shift register cells towards one.
      this.acc = 0;
      this.msbRising = false;
      this.pulseOut = 0xfff;
      this.shiftPipeline = 0;
      this.lfsrResetTtl = model.lfsrResetStart;
    } else if (testWas && !testNow) {
      // Releasing TEST completes a shift whose first phase ran while TEST was set: the last
      // output may be written into the interconnected bits, then they move up one place with
      // the feedback input held high by TEST (bit 0 = ~bit 17).
      if (preWriteback(oldSel >> 4, newSel >> 4, model)) this.writeBack(this.wave(model));
      const bit0 = (~this.lfsr >> 17) & 1;
      this.lfsr = ((this.lfsr << 1) | bit0) & 0x7fffff;
    }
    this.control = value;
    // A write recomputes the output, which also feeds the OSC3 pipeline and the feedback paths.
    this.latch(model);
  }

  /** Advance the oscillator by one cycle (before sync is applied). */
  advance(): void {
    const control = this.control;
    if ((control & 0x08) !== 0) {
      this.acc = 0;
      this.msbRising = false;
      this.pulseOut = 0xfff;
      if (this.lfsrResetTtl !== 0 && --this.lfsrResetTtl === 0) this.lfsrRecoverDue = true;
    } else {
      const old = this.acc;
      // The comparator result reaches the output one cycle after the accumulator it compared.
      this.pulseOut = old >> 12 >= this.pw ? 0xfff : 0;
      const acc = (old + this.freq) & 0xffffff;
      this.acc = acc;
      const rose = (old ^ acc) & acc; // bits that went 0 -> 1
      this.msbRising = (rose & 0x800000) !== 0;
      if ((rose & 0x080000) !== 0) this.shiftPipeline = 2;
      else if (this.shiftPipeline !== 0 && --this.shiftPipeline === 0) this.clockNoise();
    }
    if ((control & 0xf0) === 0 && this.floatAge < FLOAT_DECAY_CYCLES) this.floatAge++;
  }

  /** Hard sync: if enabled, a rising MSB of the source voice resets this accumulator. */
  applySync(): void {
    if ((this.control & 0x02) !== 0 && this.source.msbRising) this.acc = 0;
  }

  /** End of a cycle (after sync): the output stages that keep state or feed back. */
  latch(model: SidModelParams): void {
    if (this.lfsrRecoverDue) {
      // Under TEST the register cells drift to one, from the bottom up, one step at a time.
      this.lfsrRecoverDue = false;
      this.lfsr = (this.lfsr | (this.lfsr << 1) | 1) & 0x7fffff;
      if (this.lfsr !== 0x7fffff) this.lfsrResetTtl = model.lfsrResetStep;
    }
    const sel = this.control & 0xf0;
    if (model.osc3Delay && (sel & 0x30) !== 0) {
      this.triSawPrev = this.triSawPipe;
      this.triSawPipe = this.triSaw(sel);
    }
    const pulldown = model.msbPulldown && (sel & 0x20) !== 0 && (sel & 0xd0) !== 0;
    this.eager = sel > 0x80 || pulldown;
    if (!this.eager) return;
    const out = this.compute(sel, model);
    this.eagerOut = out;
    if (pulldown && (out & 0x800) === 0) this.acc &= 0x7fffff;
    // Combined waveforms drive the shift register bits through the output, except during the
    // first shift phase, when the bits are busy being interconnected.
    if (sel > 0x80 && (this.control & 0x08) === 0 && this.shiftPipeline !== 1) this.writeBack(out);
  }

  /** The shift register moves up one bit; bit 0 = bit 22 xor bit 17. */
  private clockNoise(): void {
    const bit0 = ((this.lfsr >> 22) ^ (this.lfsr >> 17)) & 1;
    this.lfsr = ((this.lfsr << 1) | bit0) & 0x7fffff;
  }

  /** The 8 noise output bits (11..4) of the shift register. */
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

  /** The output bits that are low pull their shift register bit low (a bit cleared stays cleared). */
  private writeBack(out: number): void {
    let keep = 0;
    for (let i = 0; i < 8; i++) {
      if (((out >> (11 - i)) & 1) !== 0) keep |= 1 << NOISE_TAPS[i]!;
    }
    this.lfsr &= ~NOISE_TAP_MASK | keep;
  }

  /** The triangle and/or sawtooth bits for the current accumulator (all ones if neither). */
  private triSaw(sel: number): number {
    const acc = this.acc;
    let out = 0xfff;
    if (sel & 0x10) {
      const ring = (this.control & 0x04) !== 0;
      const srcMsb = (this.source.acc >> 23) & 1;
      const invert =
        (sel & 0x20) === 0 && ((ring && srcMsb === 0 ? 1 : 0) ^ ((acc >> 23) & 1)) === 1;
      out &= ((invert ? ~acc & 0xffffff : acc) >> 11) & 0xfff;
    }
    if (sel & 0x20) out &= (acc >> 12) & 0xfff;
    return out;
  }

  /** The 12-bit output for a (non-zero) waveform selection, from the current state. */
  private compute(sel: number, model: SidModelParams): number {
    let out = this.triSaw(sel);
    let waves = (sel & 0x10 ? 1 : 0) + (sel & 0x20 ? 1 : 0);
    if (sel & 0x40) {
      out &= this.pulseOut;
      waves++;
    }
    if (waves > 1) out = model.combine(out, sel);
    if (sel & 0x80) {
      out &= this.noiseOut();
      if ((sel & 0x40) !== 0) out = model.noisePulse(out);
    }
    return out;
  }

  /** What a read of OSC3 shows: the output, with the 8580's one-cycle triangle/sawtooth delay. */
  osc3(model: SidModelParams): number {
    const sel = this.control & 0xf0;
    if (sel === 0) {
      if (this.floatAge >= FLOAT_DECAY_CYCLES) this.floatingOsc3 = 0;
      return this.floatingOsc3;
    }
    if (!model.osc3Delay || (sel & 0x30) === 0) return this.wave(model);
    let out = this.triSawPrev;
    if (sel & 0x40) out &= this.pulseOut;
    if (sel & 0x80) out &= this.noiseOut();
    return out;
  }

  /** 12-bit waveform output for the current accumulator and control bits. */
  wave(model: SidModelParams): number {
    const sel = this.control & 0xf0;
    if (sel === 0) {
      if (this.floatAge >= FLOAT_DECAY_CYCLES) this.floating = 0;
      return this.floating;
    }
    return this.eager ? this.eagerOut : this.compute(sel, model);
  }
}
