import type { IoChip } from './io';
import { Envelope } from './sid-envelope';
import { modelByName, type SidModelParams } from './sid-model';
import { SampleRing } from './sid-output';
import { Voice } from './sid-voice';

export const SID_CLOCK = 985_248;
const BUS_DECAY_CYCLES = 8192;

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

  constructor(options: SidOptions = {}) {
    this.sampleRate = options.sampleRate ?? 48000;
    this.modelParams = modelByName(options.model ?? '6581');
    this.ring = new SampleRing(this.sampleRate); // one second
    // Sync / ring mod sources: voice 1 <- voice 3, voice 2 <- voice 1, voice 3 <- voice 2.
    this.voices[0]!.source = this.voices[2]!;
    this.voices[1]!.source = this.voices[0]!;
    this.voices[2]!.source = this.voices[1]!;
  }

  get model(): '6581' | '8580' {
    return this.modelParams.name;
  }

  set model(name: '6581' | '8580') {
    this.modelParams = modelByName(name);
  }

  reset(): void {
    this.regs.fill(0);
    for (const e of this.envelopes) e.reset();
    for (const v of this.voices) v.reset();
    this.busValue = 0;
    this.busAge = 0;
    this.ring.clear();
  }

  read(reg: number): number {
    const v = this.peek(reg);
    return v;
  }

  peek(reg: number): number {
    reg &= 0x1f;
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
    reg &= 0x1f;
    value &= 0xff;
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
          v.control = value;
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

  /** One CPU cycle. */
  tick(): void {
    const [v0, v1, v2] = this.voices as [Voice, Voice, Voice];
    v0.advance();
    v1.advance();
    v2.advance();
    v0.applySync();
    v1.applySync();
    v2.applySync();
    const e = this.envelopes;
    e[0]!.tick();
    e[1]!.tick();
    e[2]!.tick();
    if (this.busAge < BUS_DECAY_CYCLES && ++this.busAge >= BUS_DECAY_CYCLES) this.busValue = 0;
    this.mix();
  }

  /** Overridden in Task 4: produces output samples. */
  protected mix(): void {}

  drainSamples(out: Float32Array): number {
    return this.ring.drain(out);
  }
}
