/**
 * Rate counter compare values for the 16 attack/decay/release settings. The counter is zeroed
 * one cycle after it matches, so the period between envelope steps is one more (9, 32, 63 ...
 * cycles), which is what the Programmer's Reference Guide times come to.
 */
export const RATE_COMPARE = [
  8, 31, 62, 94, 148, 219, 266, 312, 391, 976, 1953, 3125, 3906, 11719, 19531, 31250,
] as const;

const ATTACK = 0;
const DECAY = 1;
const RELEASE = 2;

/**
 * One SID envelope generator: a 15-bit rate counter driving an 8-bit counter through an
 * exponential-decay prescaler. State changes and counter steps are pipelined over a few cycles,
 * which the timing of ENV3 reads shows (the env_test programs).
 */
export class SidEnvelope {
  /** The 8-bit envelope value. */
  counter = 0xaa; // odd bits high at power-up
  /** What ENV3 reads: the counter as sampled in the first clock phase (before this cycle's step). */
  env3 = 0;

  private state = RELEASE;
  private nextState = RELEASE;
  private gate = false;
  private rateCounter = 0;
  private rateCompare: number = RATE_COMPARE[0];
  /** The rate counter matched: it is zeroed (and the prescaler stepped) on the next cycle. */
  private rateMatched = false;
  private expCounter = 0;
  private expPeriod = 1;
  /** Cycles until the counter steps, until the prescaler wraps, until the state changes (0 = idle). */
  private stepPipeline = 0;
  private expPipeline = 0;
  private statePipeline = 0;
  /** Once the counter reaches zero it stays there until the next attack. */
  private holdZero = false;
  private attack = 0;
  private decay = 0;
  private sustain = 0; // 4-bit
  private release = 0;

  reset(): void {
    this.counter = 0xaa;
    this.env3 = 0xaa;
    this.state = this.nextState = RELEASE;
    this.gate = false;
    this.rateCounter = 0;
    this.rateCompare = RATE_COMPARE[0];
    this.rateMatched = false;
    this.expCounter = 0;
    this.expPeriod = 1;
    this.stepPipeline = this.expPipeline = this.statePipeline = 0;
    this.holdZero = false;
    this.attack = this.decay = this.sustain = this.release = 0;
  }

  setGate(on: boolean): void {
    if (on === this.gate) return;
    this.gate = on;
    if (on) {
      // Gate on: the counting direction changes first, which briefly selects the decay rate;
      // the attack state (and rate) is reached two cycles later.
      this.nextState = ATTACK;
      this.state = DECAY;
      this.rateCompare = RATE_COMPARE[this.decay]!;
      this.statePipeline = 2;
      if (this.rateMatched || this.expPipeline === 2) {
        this.stepPipeline = this.expPeriod === 1 || this.expPipeline === 2 ? 2 : 4;
      } else if (this.expPipeline === 1) {
        this.statePipeline = 3;
      }
    } else {
      this.nextState = RELEASE;
      this.statePipeline = this.stepPipeline > 0 ? 3 : 2;
    }
  }

  setAttackDecay(value: number): void {
    this.attack = (value >> 4) & 0x0f;
    this.decay = value & 0x0f;
    if (this.state === ATTACK) this.rateCompare = RATE_COMPARE[this.attack]!;
    else if (this.state === DECAY) this.rateCompare = RATE_COMPARE[this.decay]!;
  }

  setSustainRelease(value: number): void {
    this.sustain = (value >> 4) & 0x0f;
    this.release = value & 0x0f;
    if (this.state === RELEASE) this.rateCompare = RATE_COMPARE[this.release]!;
  }

  /** One cycle. */
  tick(): void {
    this.env3 = this.counter;
    if (this.statePipeline !== 0) this.changeState();
    if (this.stepPipeline !== 0 && --this.stepPipeline === 0 && !this.holdZero) this.step();
    if (this.expPipeline !== 0 && --this.expPipeline === 0) {
      this.expCounter = 0;
      if (
        this.state === RELEASE ||
        (this.state === DECAY && this.counter !== this.sustain * 0x11)
      ) {
        this.stepPipeline = 1;
      }
    } else if (this.rateMatched) {
      this.rateCounter = 0;
      this.rateMatched = false;
      if (this.state === ATTACK) {
        // Attack steps are not prescaled; the first one also clears the prescaler.
        this.expCounter = 0;
        this.stepPipeline = 2;
      } else if (!this.holdZero && ++this.expCounter === this.expPeriod) {
        this.expPipeline = this.expPeriod === 1 ? 1 : 2;
      }
    }
    // The compare value can be set below the counter (the ADSR delay bug): the counter then
    // runs on to $7FFF, wraps to 1 and only matches on the next lap.
    if (this.rateCounter !== this.rateCompare) {
      this.rateCounter = this.rateCounter === 0x7fff ? 1 : this.rateCounter + 1;
    } else {
      this.rateMatched = true;
    }
  }

  private changeState(): void {
    this.statePipeline--;
    if (this.nextState === ATTACK) {
      if (this.statePipeline === 0) {
        this.state = ATTACK;
        this.rateCompare = RATE_COMPARE[this.attack]!;
        this.holdZero = false;
      }
    } else if (
      (this.state === ATTACK && this.statePipeline === 0) ||
      (this.state === DECAY && this.statePipeline === 1)
    ) {
      this.state = RELEASE;
      this.rateCompare = RATE_COMPARE[this.release]!;
    }
  }

  private step(): void {
    if (this.state === ATTACK) {
      this.counter = (this.counter + 1) & 0xff;
      if (this.counter === 0xff) {
        this.state = DECAY;
        this.rateCompare = RATE_COMPARE[this.decay]!;
      }
    } else {
      // Decay and release count down; the counter can run through zero to $FF after an attack
      // was cut short and only freezes once it is stepped onto zero.
      this.counter = (this.counter - 1) & 0xff;
    }
    switch (this.counter) {
      case 0xff:
        this.expPeriod = 1;
        break;
      case 0x5d:
        this.expPeriod = 2;
        break;
      case 0x36:
        this.expPeriod = 4;
        break;
      case 0x1a:
        this.expPeriod = 8;
        break;
      case 0x0e:
        this.expPeriod = 16;
        break;
      case 0x06:
        this.expPeriod = 30;
        break;
      case 0x00:
        this.expPeriod = 1;
        this.holdZero = true;
        break;
    }
  }
}
