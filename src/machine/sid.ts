import type { IoChip } from './io';
import { SidEnvelope as Envelope } from './sid-envelope';
import { modelByName, type SidModelParams } from './sid-model';
import { SampleRing } from './sid-output';
import { SidVoice as Voice } from './sid-voice';

export const SID_CLOCK = 985_248;
const BUS_DECAY_CYCLES = 8192;
/** The model runs in batches: at most this many CPU cycles behind, or on any read/drain. */
const CATCH_UP_CYCLES = 16384;
const QUEUE_SIZE = 256;

export interface SidOptions {
  model?: '6581' | '8580';
  sampleRate?: number;
}

export class Sid implements IoChip {
  readonly sampleRate: number;
  readonly voices = [new Voice(), new Voice(), new Voice()];
  readonly envelopes = [new Envelope(), new Envelope(), new Envelope()];
  protected readonly regs = new Uint8Array(0x20);
  protected modelParams: SidModelParams;
  protected readonly ring: SampleRing;
  private busValue = 0;
  private busAge = 0;
  private phase = 0;
  private accDry = 0;
  private accFilt = 0;
  private accCount = 0;
  private subCycle = 0;
  private ic1 = 0; // trapezoidal state-variable filter state
  private ic2 = 0;
  private dcIn = 0;
  private dcOut = 0;
  /** One-pole DC blocker pole for a corner of about 10 Hz at the output rate. */
  private readonly dcBlock: number;
  /** CPU cycles seen by `tick()` and how many of them the model has simulated. */
  private now = 0;
  private simulated = 0;
  /** Register writes waiting for the model to catch up: (cycle, register, value). */
  private readonly queueAt = new Float64Array(QUEUE_SIZE);
  private readonly queueReg = new Uint8Array(QUEUE_SIZE);
  private readonly queueValue = new Uint8Array(QUEUE_SIZE);
  private queueLength = 0;

  constructor(options: SidOptions = {}) {
    this.sampleRate = options.sampleRate ?? 48000;
    this.modelParams = modelByName(options.model ?? '6581');
    this.ring = new SampleRing(this.sampleRate); // one second
    this.dcBlock = 1 - (2 * Math.PI * 10) / this.sampleRate;
    // Sync / ring mod sources: voice 1 <- voice 3, voice 2 <- voice 1, voice 3 <- voice 2.
    this.voices[0]!.source = this.voices[2]!;
    this.voices[1]!.source = this.voices[0]!;
    this.voices[2]!.source = this.voices[1]!;
  }

  get model(): '6581' | '8580' {
    return this.modelParams.name;
  }

  set model(name: '6581' | '8580') {
    this.catchUp(); // what was played so far belongs to the old model
    this.modelParams = modelByName(name);
  }

  reset(): void {
    this.now = this.simulated = 0;
    this.queueLength = 0;
    this.regs.fill(0);
    for (const e of this.envelopes) e.reset();
    for (const v of this.voices) v.reset();
    this.busValue = 0;
    this.busAge = 0;
    this.ring.clear();
    this.ic1 = this.ic2 = this.dcIn = this.dcOut = 0;
    this.phase = 0;
    this.accDry = this.accFilt = 0;
    this.accCount = 0;
  }

  read(reg: number): number {
    return this.peek(reg);
  }

  peek(reg: number): number {
    reg &= 0x1f;
    this.catchUp();
    switch (reg) {
      case 0x19:
      case 0x1a:
        return 0xff;
      case 0x1b:
        return this.voices[2]!.wave(this.modelParams) >> 4;
      case 0x1c:
        return this.envelopes[2]!.counter;
      default:
        return this.busValue;
    }
  }

  write(reg: number, value: number): void {
    if (this.queueLength === QUEUE_SIZE) this.catchUp();
    const i = this.queueLength++;
    this.queueAt[i] = this.now;
    this.queueReg[i] = reg & 0x1f;
    this.queueValue[i] = value & 0xff;
  }

  private applyWrite(reg: number, value: number): void {
    this.busValue = value;
    this.busAge = 0;
    if (reg >= 0x19) {
      this.regs[reg] = value;
      return;
    }
    this.regs[reg] = value;
    if (reg < 0x15) {
      const n = (reg / 7) | 0;
      const r = reg - n * 7;
      const v = this.voices[n]!;
      const e = this.envelopes[n]!;
      switch (r) {
        case 0:
          v.freq = (v.freq & 0xff00) | value;
          break;
        case 1:
          v.freq = (v.freq & 0x00ff) | (value << 8);
          break;
        case 2:
          v.pw = (v.pw & 0x0f00) | value;
          break;
        case 3:
          v.pw = (v.pw & 0x00ff) | ((value & 0x0f) << 8);
          break;
        case 4:
          v.setControl(value, this.modelParams);
          e.setGate((value & 1) !== 0);
          break;
        case 5:
          e.setAttackDecay(value);
          break;
        default:
          e.setSustainRelease(value);
      }
    }
  }

  /** One CPU cycle. The model itself runs lazily (see `catchUp`). */
  tick(): void {
    if (++this.now - this.simulated >= CATCH_UP_CYCLES) this.catchUp();
  }

  /** Simulate up to the current cycle, applying the queued register writes at their cycles. */
  private catchUp(): void {
    const target = this.now;
    let qi = 0;
    const n = this.queueLength;
    while (this.simulated < target) {
      while (qi < n && this.queueAt[qi]! <= this.simulated) {
        this.applyWrite(this.queueReg[qi]!, this.queueValue[qi]!);
        qi++;
      }
      const stop = qi < n ? Math.min(this.queueAt[qi]!, target) : target;
      for (let c = stop - this.simulated; c > 0; c--) this.step();
      this.simulated = stop;
    }
    while (qi < n) {
      this.applyWrite(this.queueReg[qi]!, this.queueValue[qi]!);
      qi++;
    }
    this.queueLength = 0;
  }

  private step(): void {
    const [v0, v1, v2] = this.voices as [Voice, Voice, Voice];
    v0.advance();
    v1.advance();
    v2.advance();
    if (((v0.control | v1.control | v2.control) & 0x02) !== 0) {
      v0.applySync();
      v1.applySync();
      v2.applySync();
    }
    const e = this.envelopes;
    e[0]!.tick();
    e[1]!.tick();
    e[2]!.tick();
    if (this.busAge < BUS_DECAY_CYCLES && ++this.busAge >= BUS_DECAY_CYCLES) this.busValue = 0;
    this.mix();
  }

  protected mix(): void {
    // Sample the voice outputs every 4th cycle and box-average them per output sample.
    if ((this.subCycle = (this.subCycle + 1) & 3) === 0) {
      const m = this.modelParams;
      const filterRoute = this.regs[0x17]!;
      let dry = 0;
      let filt = 0;
      for (let n = 0; n < 3; n++) {
        if (n === 2 && (this.regs[0x18]! & 0x80) !== 0 && (filterRoute & 0x04) === 0) continue; // voice 3 off
        const env = this.envelopes[n]!.counter;
        if (env === 0) continue; // silent: no need to evaluate the waveform
        const w = this.voices[n]!.wave(m);
        const v = ((w - m.zero) / 2048) * (env / 255);
        if ((filterRoute >> n) & 1) filt += v;
        else dry += v;
      }
      this.accDry += dry;
      this.accFilt += filt;
      this.accCount++;
    }
    this.phase += this.sampleRate;
    if (this.phase < SID_CLOCK) return;
    this.phase -= SID_CLOCK;
    const cnt = this.accCount || 1;
    const dry = this.accDry / cnt;
    const filtIn = this.accFilt / cnt;
    this.accDry = this.accFilt = 0;
    this.accCount = 0;

    const mode = this.regs[0x18]!;
    const fc = (this.regs[0x15]! & 7) | (this.regs[0x16]! << 3);
    const res = this.regs[0x17]! >> 4;
    const m = this.modelParams;
    // Zero-delay-feedback (trapezoidal) state-variable filter: stable for any cutoff and Q.
    const hz = Math.min(m.cutoffHz(fc), this.sampleRate * 0.45);
    const g = Math.tan((Math.PI * hz) / this.sampleRate);
    const k = 1 / m.q(res);
    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    const v3 = filtIn - this.ic2;
    const bp = a1 * this.ic1 + a2 * v3;
    const lp = this.ic2 + a2 * this.ic1 + g * a2 * v3;
    this.ic1 = 2 * bp - this.ic1;
    this.ic2 = 2 * lp - this.ic2;
    const hp = filtIn - k * bp - lp;
    if (!Number.isFinite(this.ic1) || !Number.isFinite(this.ic2)) this.ic1 = this.ic2 = 0;
    let filtered = 0;
    if (mode & 0x10) filtered += lp;
    if (mode & 0x20) filtered += bp;
    if (mode & 0x40) filtered += hp;
    const vol = (mode & 0x0f) / 15;
    // The master volume scales a small DC level (per model), so volume steps are audible (digi).
    let s = ((dry + filtered) / 3 + m.dcLevel) * vol;
    // One-pole DC blocker (about 10 Hz): the per-model zero level and volume changes are DC.
    const y = s - this.dcIn + this.dcBlock * this.dcOut;
    this.dcIn = s;
    this.dcOut = y;
    s = Math.max(-1, Math.min(1, y));
    this.ring.push(s);
  }

  drainSamples(out: Float32Array): number {
    this.catchUp();
    return this.ring.drain(out);
  }
}
