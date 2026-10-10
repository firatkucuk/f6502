import { describe, expect, it } from 'vitest';
import { C64 } from '../../src/machine/c64';
import { Datasette, parseTap } from '../../src/machine/datasette';
import { markerRoms } from './helpers';

function tap(version: number, data: number[]): Uint8Array {
  const head = new TextEncoder().encode('C64-TAPE-RAW');
  const b = new Uint8Array(20 + data.length);
  b.set(head, 0);
  b[12] = version;
  b[16] = data.length & 0xff;
  b[17] = (data.length >> 8) & 0xff;
  b.set(data, 20);
  return b;
}

describe('parseTap', () => {
  it('v0: byte * 8 cycles, 0 is an overflow of 256 * 8', () => {
    expect([...parseTap(tap(0, [0x30, 0x42, 0x00]))]).toEqual([0x30 * 8, 0x42 * 8, 256 * 8]);
  });

  it('v1: a zero byte is followed by a 24-bit cycle count', () => {
    expect([...parseTap(tap(1, [0x30, 0x00, 0x10, 0x27, 0x00]))]).toEqual([0x30 * 8, 10000]);
  });

  it('v2 half-waves are paired into full pulses', () => {
    expect([...parseTap(tap(2, [0x10, 0x20, 0x30, 0x40]))]).toEqual([
      (0x10 + 0x20) * 8,
      (0x30 + 0x40) * 8,
    ]);
  });

  it('rejects a bad header and a truncated v1 length', () => {
    expect(() => parseTap(new Uint8Array(30))).toThrow(/TAP/);
    expect(() => parseTap(tap(1, [0x00, 0x01]))).toThrow(/truncated/);
  });
});

describe('Datasette', () => {
  function rig(pulses: number[], motor = true) {
    let edges = 0;
    const at: number[] = [];
    let cycle = 0;
    const host = { motorOn: () => motor, pulse: () => void (edges++, at.push(cycle)) };
    const d = new Datasette(host);
    d.insert(
      tap(
        1,
        pulses.flatMap((p) => [0x00, p & 0xff, (p >> 8) & 0xff, p >> 16]),
      ),
    );
    return {
      d,
      at,
      run: (n: number) => {
        for (let i = 0; i < n; i++) {
          cycle++;
          d.tick();
        }
      },
      edges: () => edges,
      setMotor: (m: boolean) => (motor = m),
    };
  }

  it('delivers one edge at the end of each pulse while playing with the motor on', () => {
    const t = rig([100, 50, 200]);
    t.d.play();
    t.run(400);
    expect(t.at).toEqual([100, 150, 350]);
  });

  it('does nothing while stopped or with the motor off, and keeps its position', () => {
    const t = rig([100, 100]);
    t.run(500);
    expect(t.edges()).toBe(0);
    t.d.play();
    t.setMotor(false);
    t.run(500);
    expect(t.edges()).toBe(0);
    t.setMotor(true);
    t.run(100);
    expect(t.edges()).toBe(1);
  });

  it('sense reads low only while PLAY is pressed; the end of tape releases it', () => {
    const t = rig([10]);
    expect(t.d.sense).toBe(false);
    t.d.play();
    expect(t.d.sense).toBe(true);
    t.run(20);
    expect(t.d.playing).toBe(false);
    expect(t.d.running).toBe(false);
  });

  it('rewind restarts and position/length report progress', () => {
    const t = rig([10, 10]);
    t.d.play();
    t.run(15);
    expect(t.d.position).toBe(1);
    expect(t.d.length).toBe(2);
    t.d.rewind();
    expect(t.d.position).toBe(0);
  });
});

describe('machine wiring', () => {
  it('feeds pulses into the CIA1 FLAG interrupt and reports warp only while the motor runs', () => {
    const c64 = new C64(markerRoms());
    c64.tape.insert(tap(0, new Array(50).fill(0x30)));
    c64.tape.play();
    expect(c64.warp).toBe(false); // motor off (the port's bit 5 is an input: pulled up)
    c64.busWrite(0x00, 0x2f);
    c64.busWrite(0x01, 0x07); // motor on (bit 5 low), sense visible
    expect(c64.warp).toBe(true);
    expect(c64.peek(0x01) & 0x10).toBe(0); // sense low: PLAY pressed
    c64.busWrite(0xdc0d, 0x90); // enable the FLAG interrupt
    c64.runCycles(0x30 * 8 * 3);
    expect(c64.busRead(0xdc0d) & 0x10).toBe(0x10);
  });
});
