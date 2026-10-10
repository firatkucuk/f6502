import { describe, expect, it } from 'vitest';
import { AudioPump, createWorkletSink, type AudioSink } from '../../src/browser/audio';

function fakeSink() {
  const pushed: number[][] = [];
  let muted = false;
  let closed = false;
  const sink: AudioSink = {
    push: (s) => void pushed.push([...s]),
    setMuted: (m) => void (muted = m),
    close: () => void (closed = true),
  };
  return {
    sink,
    pushed,
    get muted() {
      return muted;
    },
    get closed() {
      return closed;
    },
  };
}

function fakeSid(samples: number[]) {
  let queue = [...samples];
  return {
    sampleRate: 48000,
    drainSamples(out: Float32Array): number {
      const n = Math.min(out.length, queue.length);
      for (let i = 0; i < n; i++) out[i] = queue[i]!;
      queue = queue.slice(n);
      return n;
    },
  };
}

describe('AudioPump', () => {
  it('forwards the drained samples to the sink', () => {
    const f = fakeSink();
    const pump = new AudioPump(fakeSid([0.1, 0.2, 0.3]), f.sink);
    expect(pump.pump()).toBe(3);
    expect(f.pushed).toEqual([[expect.closeTo(0.1), expect.closeTo(0.2), expect.closeTo(0.3)]]);
  });

  it('keeps draining while the sid has more than one buffer of samples', () => {
    const f = fakeSink();
    const many = new Array(5000).fill(0.5);
    const pump = new AudioPump(fakeSid(many), f.sink);
    expect(pump.pump()).toBe(5000);
  });

  it('discards samples while muted and forwards the mute state', () => {
    const f = fakeSink();
    const pump = new AudioPump(fakeSid([0.1, 0.2]), f.sink);
    pump.setMuted(true);
    expect(f.muted).toBe(true);
    expect(pump.pump()).toBe(0);
    expect(f.pushed).toEqual([]);
  });

  it('createWorkletSink degrades to null without Web Audio instead of throwing', async () => {
    const sink = await createWorkletSink({ sampleRate: 48000 });
    expect(sink).toBeNull();
  });

  it('close() closes the sink and further pumps are no-ops', () => {
    const f = fakeSink();
    const pump = new AudioPump(fakeSid([0.1]), f.sink);
    pump.close();
    expect(f.closed).toBe(true);
    expect(pump.pump()).toBe(0);
  });
});
