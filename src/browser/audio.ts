export interface AudioSink {
  push(samples: Float32Array): void;
  setMuted(muted: boolean): void;
  close(): void;
}

interface SampleSource {
  readonly sampleRate: number;
  drainSamples(out: Float32Array): number;
}

const CHUNK = 4096;

/** Moves the samples the SID produced during the last emulated frame to a sink. */
export class AudioPump {
  private readonly buffer = new Float32Array(CHUNK);
  private muted = false;
  private hidden = false;
  private closed = false;

  constructor(
    private readonly source: SampleSource,
    private readonly sink: AudioSink,
  ) {}

  pump(): number {
    if (this.closed) return 0;
    let total = 0;
    for (;;) {
      const n = this.source.drainSamples(this.buffer);
      if (n === 0) break;
      total += n;
      if (!this.muted && !this.hidden) this.sink.push(this.buffer.slice(0, n));
      if (n < this.buffer.length) break;
    }
    return this.muted || this.hidden ? 0 : total;
  }

  /** Paused by the player. */
  setMuted(muted: boolean): void {
    this.muted = muted;
    this.sink.setMuted(this.muted || this.hidden);
  }

  /** The page is not visible. Independent of `setMuted`: either one silences the output. */
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    this.sink.setMuted(this.muted || this.hidden);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.sink.close();
  }
}

/** Worklet source: a ring buffer that plays at a rate nudged towards the target queue fill. */
const WORKLET_SOURCE = `
class F6502Processor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions;
    this.ratioBase = o.sampleRate / sampleRate;
    this.target = Math.max(256, Math.round(o.sampleRate * o.targetMs / 1000));
    this.buf = new Float32Array(o.sampleRate);
    this.head = 0; this.size = 0; this.pos = 0; this.last = 0; this.muted = false;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.muted !== undefined) { this.muted = m.muted; return; }
      const s = m.samples;
      for (let i = 0; i < s.length; i++) {
        const tail = (this.head + this.size) % this.buf.length;
        this.buf[tail] = s[i];
        if (this.size < this.buf.length) this.size++; else this.head = (this.head + 1) % this.buf.length;
      }
    };
  }
  process(inputs, outputs) {
    const out = outputs[0][0];
    const err = (this.size - this.target) / this.target;
    const ratio = this.ratioBase * (1 + Math.max(-0.005, Math.min(0.005, err * 0.01)));
    for (let i = 0; i < out.length; i++) {
      if (this.muted || this.size === 0) { out[i] = this.muted ? 0 : this.last; continue; }
      const idx = (this.head + 0) % this.buf.length;
      this.last = this.buf[idx];
      out[i] = this.last;
      this.pos += ratio;
      while (this.pos >= 1 && this.size > 0) {
        this.pos -= 1; this.head = (this.head + 1) % this.buf.length; this.size--;
      }
    }
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    return true;
  }
}
registerProcessor('f6502-sid', F6502Processor);
`;

/** Creates the Web Audio sink, or null when AudioWorklet is unavailable. Never throws. */
export async function createWorkletSink(options: {
  sampleRate: number;
  targetMs?: number;
}): Promise<(AudioSink & { resume(): void }) | null> {
  try {
    const Ctx: typeof AudioContext | undefined =
      typeof AudioContext !== 'undefined' ? AudioContext : undefined;
    if (!Ctx || typeof AudioWorkletNode === 'undefined') {
      console.warn('f6502: AudioWorklet is not available; running silent');
      return null;
    }
    let ctx: AudioContext;
    try {
      ctx = new Ctx({ sampleRate: options.sampleRate, latencyHint: 'interactive' });
    } catch {
      ctx = new Ctx({ latencyHint: 'interactive' }); // the browser rejected the rate: resample
    }
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const node = new AudioWorkletNode(ctx, 'f6502-sid', {
      numberOfInputs: 0,
      outputChannelCount: [2],
      processorOptions: { sampleRate: options.sampleRate, targetMs: options.targetMs ?? 60 },
    });
    node.connect(ctx.destination);
    return {
      push: (samples) => node.port.postMessage({ samples }, [samples.buffer]),
      setMuted: (muted) => node.port.postMessage({ muted }),
      resume: () => void ctx.resume(),
      close: () => {
        node.disconnect();
        void ctx.close();
      },
    };
  } catch (error) {
    console.warn('f6502: audio could not start; running silent', error);
    return null;
  }
}
