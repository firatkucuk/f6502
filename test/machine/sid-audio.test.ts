import { describe, expect, it } from 'vitest';
import { SID_CLOCK, Sid } from '../../src/machine/sid';

function setVoice(s: Sid, n: number, hz: number, wave: number): void {
  const f = Math.round((hz * 16777216) / SID_CLOCK);
  const b = n * 7;
  s.write(b, f & 0xff);
  s.write(b + 1, f >> 8);
  s.write(b + 2, 0x00);
  s.write(b + 3, 0x08);
  s.write(b + 5, 0x00); // attack 0, decay 0
  s.write(b + 6, 0xf0); // sustain 15
  s.write(b + 4, wave | 1);
}

function render(s: Sid, seconds: number): Float32Array {
  const n = Math.round(seconds * s.sampleRate);
  const cycles = Math.round(seconds * SID_CLOCK);
  for (let i = 0; i < cycles; i++) s.tick();
  const out = new Float32Array(n + 64);
  const got = s.drainSamples(out);
  return out.subarray(0, got);
}

function rms(a: Float32Array): number {
  let sum = 0;
  for (const v of a) sum += v * v;
  return Math.sqrt(sum / a.length);
}

function frequency(a: Float32Array, rate: number): number {
  let crossings = 0;
  for (let i = 1; i < a.length; i++) if (a[i - 1]! < 0 && a[i]! >= 0) crossings++;
  return (crossings * rate) / a.length;
}

describe('SID audio output', () => {
  it('a pulse voice plays at the programmed frequency', () => {
    const s = new Sid();
    s.write(0x18, 0x0f);
    setVoice(s, 0, 440, 0x40);
    render(s, 0.2); // let the envelope open
    const out = render(s, 1);
    expect(frequency(out, s.sampleRate)).toBeGreaterThan(436);
    expect(frequency(out, s.sampleRate)).toBeLessThan(444);
    expect(rms(out)).toBeGreaterThan(0.02);
  });

  it('master volume scales the output', () => {
    const loud = new Sid();
    loud.write(0x18, 0x0f);
    setVoice(loud, 0, 440, 0x20);
    render(loud, 0.2);
    const quiet = new Sid();
    quiet.write(0x18, 0x07);
    setVoice(quiet, 0, 440, 0x20);
    render(quiet, 0.2);
    const a = rms(render(loud, 0.5));
    const b = rms(render(quiet, 0.5));
    expect(b / a).toBeGreaterThan(0.4);
    expect(b / a).toBeLessThan(0.55);
  });

  it('a low-pass filter with a low cutoff attenuates a bright waveform', () => {
    const dry = new Sid();
    dry.write(0x18, 0x0f);
    setVoice(dry, 0, 1000, 0x20);
    render(dry, 0.2);
    const filtered = new Sid();
    filtered.write(0x15, 0x00);
    filtered.write(0x16, 0x08); // low FC
    filtered.write(0x17, 0x01); // route voice 1 through the filter
    filtered.write(0x18, 0x1f); // low-pass, volume 15
    setVoice(filtered, 0, 1000, 0x20);
    render(filtered, 0.2);
    const a = rms(render(dry, 0.5));
    const b = rms(render(filtered, 0.5));
    expect(b).toBeLessThan(a * 0.5);
  });

  it('6581 and 8580 filter curves differ for the same FC', () => {
    const make = (model: '6581' | '8580') => {
      const s = new Sid({ model });
      s.write(0x16, 0x40);
      s.write(0x17, 0x01);
      s.write(0x18, 0x1f);
      setVoice(s, 0, 1000, 0x20);
      render(s, 0.2);
      return rms(render(s, 0.5));
    };
    expect(Math.abs(make('6581') - make('8580'))).toBeGreaterThan(0.005);
  });

  it('is deterministic and stays within [-1, 1] under random register writes', () => {
    const run = () => {
      const s = new Sid();
      let x = 12345;
      const rnd = () => (x = (x * 1103515245 + 12345) & 0x7fffffff);
      const all: number[] = [];
      for (let step = 0; step < 200; step++) {
        s.write(rnd() % 0x19, rnd() & 0xff);
        for (let c = 0; c < 2000; c++) s.tick();
        const out = new Float32Array(200);
        const n = s.drainSamples(out);
        for (let i = 0; i < n; i++) all.push(out[i]!);
      }
      return all;
    };
    const a = run();
    const b = run();
    expect(a).toEqual(b);
    for (const v of a) {
      expect(Number.isFinite(v)).toBe(true);
      expect(Math.abs(v)).toBeLessThanOrEqual(1);
    }
  });

  it('the filter stays stable at every resonance with a high cutoff', () => {
    for (const model of ['6581', '8580'] as const) {
      for (let res = 0; res < 16; res++) {
        const s = new Sid({ model });
        s.write(0x15, 0x07);
        s.write(0x16, 0xff); // FC = $7FF
        s.write(0x17, (res << 4) | 0x01);
        s.write(0x18, 0x1f);
        setVoice(s, 0, 3000, 0x20);
        render(s, 0.1);
        s.write(0x04, 0x20); // release: the voice goes silent
        render(s, 0.3);
        const tail = render(s, 0.1);
        expect(rms(tail), `${model} res ${res}`).toBeLessThan(0.05);
      }
    }
  });

  it('volume steps are audible (digi playback) even with silent voices', () => {
    const s = new Sid();
    render(s, 0.05);
    s.write(0x18, 0x0f);
    const out = render(s, 0.01);
    expect(Math.max(...out.map(Math.abs))).toBeGreaterThan(0.001);
  });

  it('switching the model mid-note keeps playing without NaN', () => {
    const s = new Sid();
    s.write(0x18, 0x0f);
    setVoice(s, 0, 440, 0x20);
    render(s, 0.1);
    s.model = '8580';
    const out = render(s, 0.1);
    for (const v of out) expect(Number.isFinite(v)).toBe(true);
  });
});
