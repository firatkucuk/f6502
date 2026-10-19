import { describe, expect, it } from 'vitest';
import { Cia } from '../../src/machine/cia';

function cia(inputA = 0xff, inputB = 0xff) {
  return new Cia({ inputA: () => inputA, inputB: () => inputB });
}
function ticks(c: Cia, n: number) {
  for (let i = 0; i < n; i++) c.tick();
}
function startTimerA(c: Cia, latch: number, cra = 0x01) {
  c.write(0x04, latch & 0xff);
  c.write(0x05, latch >> 8);
  c.write(0x0e, cra);
}

describe('Timer A', () => {
  it('underflows after latch+1 cycles of counting (plus the start delay) and reloads', () => {
    const c = cia();
    startTimerA(c, 3);
    ticks(c, 6);
    expect(c.read(0x0d)).toBe(0x00); // underflow happened this tick; flag visible next tick
    const d = cia();
    startTimerA(d, 3);
    ticks(d, 7);
    expect(d.read(0x0d)).toBe(0x01);
  });

  it('has period latch+1', () => {
    const c = cia();
    startTimerA(c, 3);
    ticks(c, 7);
    c.read(0x0d); // clear
    ticks(c, 4);
    expect(c.read(0x0d)).toBe(0x01);
  });

  it('one-shot stops after one underflow', () => {
    const c = cia();
    startTimerA(c, 3, 0x09);
    ticks(c, 7);
    expect(c.read(0x0d)).toBe(0x01);
    ticks(c, 50);
    expect(c.read(0x0d)).toBe(0x00);
    expect(c.read(0x0e) & 1).toBe(0); // start bit cleared
  });

  it('latch 0 underflows every cycle after the start delay', () => {
    const c = cia();
    startTimerA(c, 0);
    ticks(c, 4); // ticks 1-2: start delay, tick 3: underflow, tick 4: flag visible
    expect(c.read(0x0d) & 1).toBe(1);
  });

  it('writing the high latch byte while stopped loads the counter', () => {
    const c = cia();
    c.write(0x04, 0x34);
    c.write(0x05, 0x12);
    expect(c.read(0x04)).toBe(0x34);
    expect(c.read(0x05)).toBe(0x12);
  });

  it('force-load with the start bit holds the latch for three ticks before counting', () => {
    const c = cia();
    startTimerA(c, 100);
    ticks(c, 10);
    expect(c.read(0x04)).toBe(92); // running, two start-delay ticks
    c.write(0x0e, 0x11); // start + force load on a running timer
    expect(c.read(0x04)).toBe(100);
    ticks(c, 3);
    expect(c.read(0x04)).toBe(100); // the load pipeline: no count yet
    ticks(c, 1);
    expect(c.read(0x04)).toBe(99);
  });

  it('start + force-load on a stopped timer takes the same three ticks', () => {
    const c = cia();
    c.write(0x04, 100);
    c.write(0x05, 0);
    c.write(0x0e, 0x11);
    ticks(c, 3);
    expect(c.read(0x04)).toBe(100);
    ticks(c, 1);
    expect(c.read(0x04)).toBe(99);
  });

  it('force-load without the start bit loads a stopped timer at once', () => {
    const c = cia();
    startTimerA(c, 100);
    ticks(c, 10);
    c.write(0x0e, 0x00); // stop
    expect(c.read(0x04)).not.toBe(100);
    c.write(0x0e, 0x10); // force load, no start
    expect(c.read(0x04)).toBe(100);
  });
});

describe('ICR and IRQ', () => {
  it('a masked flag does not raise IRQ; unmasking afterwards does', () => {
    const c = cia();
    startTimerA(c, 1);
    ticks(c, 10);
    expect(c.irq).toBe(false);
    c.write(0x0d, 0x81); // enable TA
    expect(c.irq).toBe(true);
  });

  it('reading ICR returns bit 7 with the flag, then clears flags and the IRQ line', () => {
    const c = cia();
    c.write(0x0d, 0x81);
    startTimerA(c, 1);
    ticks(c, 10);
    expect(c.irq).toBe(true);
    expect(c.read(0x0d)).toBe(0x81);
    expect(c.irq).toBe(false);
    expect(c.read(0x0d)).toBe(0x00);
  });

  it('writing ICR with bit 7 clear removes mask bits', () => {
    const c = cia();
    c.write(0x0d, 0x83);
    c.write(0x0d, 0x01);
    startTimerA(c, 1);
    ticks(c, 10);
    expect(c.irq).toBe(false);
  });
});

describe('Timer B', () => {
  it('counts Timer A underflows when CRB selects it (cascade)', () => {
    const c = cia();
    startTimerA(c, 1);
    c.write(0x06, 0x02);
    c.write(0x07, 0x00);
    c.write(0x0f, 0x41); // start, count TA underflows
    ticks(c, 40);
    expect(c.read(0x0d) & 0x03).toBe(0x03);
  });
});

describe('ports', () => {
  it('output bits drive the pin, input bits read the external value', () => {
    const c = cia(0b10101010, 0xff);
    c.write(0x02, 0x0f); // DDRA: low nibble outputs
    c.write(0x00, 0x05);
    expect(c.read(0x00)).toBe(0xa5); // external high nibble 0xA, driven low nibble 0x5
    expect(c.outputA()).toBe(0xf5); // inputs read high on the driven side
  });
});

describe('TOD', () => {
  it('advances one tenth every ~98,525 cycles', () => {
    const c = cia();
    ticks(c, 98_524);
    expect(c.read(0x08)).toBe(0x00);
    ticks(c, 1);
    expect(c.read(0x08)).toBe(0x01);
  });

  it('rolls BCD seconds/minutes/hours and flips AM/PM at 12; hour read latches', () => {
    const c = cia();
    c.write(0x0b, 0x11); // hour 11 AM (stops the clock)
    c.write(0x0a, 0x59);
    c.write(0x09, 0x59);
    c.write(0x08, 0x09); // tenths 9: restarts the clock
    ticks(c, 98_525);
    expect(c.read(0x0b)).toBe(0x92); // 12 PM, latched
    expect(c.read(0x0a)).toBe(0x00);
    expect(c.read(0x09)).toBe(0x00);
    expect(c.read(0x08)).toBe(0x00); // reading tenths unlatches
  });
});

describe('port write hook', () => {
  it('is called after writes to port A/B and their direction registers', () => {
    let calls = 0;
    const c = new Cia({ inputA: () => 0xff, inputB: () => 0xff, onPortWrite: () => calls++ });
    c.write(0x00, 1);
    c.write(0x01, 1);
    c.write(0x02, 1);
    c.write(0x03, 1);
    expect(calls).toBe(4);
    c.write(0x04, 1); // timer latch: no port change
    expect(calls).toBe(4);
  });
});
