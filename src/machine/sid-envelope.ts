/** Rate counter periods (cycles) for the 16 attack/decay/release rate values. */
export const RATE_PERIOD = [
  9, 32, 63, 95, 149, 220, 267, 313, 392, 977, 1954, 3126, 3907, 11720, 19532, 31251,
] as const;

const ATTACK = 0;
const DECAY = 1;
const RELEASE = 2;

/** One SID envelope generator: a 15-bit rate counter driving an 8-bit counter with an exponential stage. */
export class SidEnvelope {
  /** The 8-bit envelope value (what ENV3 reads). */
  counter = 0;

  private state = RELEASE;
  private gate = false;
  /** Rate counter value at `syncCycle`; the live value is (rateBase + cycle - syncCycle) & $7FFF. */
  private rateBase = 0;
  private syncCycle = 0;
  private cycle = 0;
  /** The cycle at which the rate counter next equals the period. */
  private nextEvent = RATE_PERIOD[0] as number;
  private ratePeriod: number = RATE_PERIOD[0];
  private expCounter = 0;
  private expPeriod = 1;
  private holdZero = true;
  private attack = 0;
  private decay = 0;
  private sustain = 0; // 4-bit
  private release = 0;

  reset(): void {
    this.counter = 0;
    this.state = RELEASE;
    this.gate = false;
    this.rateBase = 0;
    this.syncCycle = this.cycle;
    this.expCounter = 0;
    this.expPeriod = 1;
    this.holdZero = true;
    this.attack = this.decay = this.sustain = this.release = 0;
    this.ratePeriod = RATE_PERIOD[0];
    this.schedule();
  }

  setGate(on: boolean): void {
    if (on === this.gate) return;
    this.gate = on;
    if (on) {
      this.state = ATTACK;
      this.setPeriod(RATE_PERIOD[this.attack]!);
      this.holdZero = false;
    } else {
      this.state = RELEASE;
      this.setPeriod(RATE_PERIOD[this.release]!);
    }
  }

  setAttackDecay(value: number): void {
    this.attack = (value >> 4) & 0x0f;
    this.decay = value & 0x0f;
    if (this.state === ATTACK) this.setPeriod(RATE_PERIOD[this.attack]!);
    else if (this.state === DECAY) this.setPeriod(RATE_PERIOD[this.decay]!);
  }

  setSustainRelease(value: number): void {
    this.sustain = (value >> 4) & 0x0f;
    this.release = value & 0x0f;
    if (this.state === RELEASE) this.setPeriod(RATE_PERIOD[this.release]!);
  }

  private liveRate(): number {
    return (this.rateBase + this.cycle - this.syncCycle) & 0x7fff;
  }

  /** Change the compare value: the rate counter keeps its value (the ADSR delay bug). */
  private setPeriod(period: number): void {
    this.rateBase = this.liveRate();
    this.syncCycle = this.cycle;
    this.ratePeriod = period;
    this.schedule();
  }

  /** Cycle of the next compare match: the counter counts up, wrapping through $7FFF. */
  private schedule(): void {
    const rc = this.rateBase;
    const wait = this.ratePeriod > rc ? this.ratePeriod - rc : 0x8000 - rc + this.ratePeriod;
    this.nextEvent = this.syncCycle + wait;
  }

  /** One cycle: only does work when the rate counter reaches the period. */
  tick(): void {
    if (++this.cycle !== this.nextEvent) return;
    this.rateBase = 0;
    this.syncCycle = this.cycle;
    if (this.state !== ATTACK && ++this.expCounter !== this.expPeriod) {
      this.schedule();
      return;
    }
    this.expCounter = 0;
    if (!this.holdZero) this.advance();
    this.schedule();
  }

  private advance(): void {
    switch (this.state) {
      case ATTACK:
        this.counter = (this.counter + 1) & 0xff;
        if (this.counter === 0xff) {
          this.state = DECAY;
          this.ratePeriod = RATE_PERIOD[this.decay]!;
        }
        break;
      case DECAY:
        if (this.counter !== this.sustain * 17) this.counter = (this.counter - 1) & 0xff;
        break;
      default:
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
