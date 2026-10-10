import { describe, expect, it } from 'vitest';
import { C, I, Z } from '../../src/core/flags';
import { boot } from './helpers';

describe('illegal opcodes', () => {
  it('LAX zp loads A and X', () => {
    const m = boot([0xa7, 0x10]);
    m.bus.mem[0x10] = 0x8c;
    expect(m.cpu.step()).toBe(3);
    expect(m.cpu.regs.a).toBe(0x8c);
    expect(m.cpu.regs.x).toBe(0x8c);
  });

  it('SAX zp stores A & X without touching flags', () => {
    const m = boot([0x87, 0x10]);
    m.cpu.regs.a = 0xf0;
    m.cpu.regs.x = 0x3c;
    const p = m.cpu.regs.p;
    m.cpu.step();
    expect(m.bus.mem[0x10]).toBe(0x30);
    expect(m.cpu.regs.p).toBe(p);
  });

  it('DCP zp decrements memory then compares with A (5 cycles)', () => {
    const m = boot([0xc7, 0x10]);
    m.bus.mem[0x10] = 0x41;
    m.cpu.regs.a = 0x40;
    expect(m.cpu.step()).toBe(5);
    expect(m.bus.mem[0x10]).toBe(0x40);
    expect(m.cpu.regs.p & Z).toBe(Z);
    expect(m.cpu.regs.p & C).toBe(C);
  });

  it('ISC zp increments memory then subtracts it from A', () => {
    const m = boot([0xe7, 0x10]);
    m.bus.mem[0x10] = 0x0f;
    m.cpu.regs.a = 0x20;
    m.cpu.regs.p |= C;
    m.cpu.step();
    expect(m.bus.mem[0x10]).toBe(0x10);
    expect(m.cpu.regs.a).toBe(0x10);
  });

  it('SLO / RLA / SRE / RRA combine the shift with the logic op', () => {
    const m = boot([0x07, 0x10, 0x27, 0x10, 0x47, 0x10, 0x67, 0x10]);
    m.bus.mem[0x10] = 0x81;
    m.cpu.regs.a = 0x01;
    m.cpu.step(); // SLO: mem=0x02 C=1, A=0x01|0x02
    expect(m.bus.mem[0x10]).toBe(0x02);
    expect(m.cpu.regs.a).toBe(0x03);
    m.cpu.step(); // RLA: mem=0x05 (C in), A=0x03&0x05
    expect(m.bus.mem[0x10]).toBe(0x05);
    expect(m.cpu.regs.a).toBe(0x01);
    m.cpu.step(); // SRE: mem=0x02 C=1, A=0x01^0x02
    expect(m.bus.mem[0x10]).toBe(0x02);
    expect(m.cpu.regs.a).toBe(0x03);
    m.cpu.step(); // RRA: mem=0x81 (C in), then ADC
    expect(m.bus.mem[0x10]).toBe(0x81);
  });

  it('ALR, ANC, SBX immediate', () => {
    const m = boot([0x4b, 0x0f, 0x0b, 0x80, 0xcb, 0x01]);
    m.cpu.regs.a = 0xff;
    m.cpu.step(); // ALR: (0xff&0x0f)>>1 = 0x07, C=1
    expect(m.cpu.regs.a).toBe(0x07);
    expect(m.cpu.regs.p & C).toBe(C);
    m.cpu.regs.a = 0xff;
    m.cpu.step(); // ANC: 0xff&0x80 = 0x80, C = bit 7
    expect(m.cpu.regs.p & C).toBe(C);
    m.cpu.regs.a = 0x0f;
    m.cpu.regs.x = 0x07;
    m.cpu.step(); // SBX: X = (A&X) - 1 = 0x06
    expect(m.cpu.regs.x).toBe(0x06);
  });

  it('SBC $EB behaves as SBC #imm', () => {
    const m = boot([0xeb, 0x01]);
    m.cpu.regs.a = 0x05;
    m.cpu.regs.p |= C;
    m.cpu.step();
    expect(m.cpu.regs.a).toBe(0x04);
  });

  it('undocumented NOPs consume operands: NOP abs,X costs 5 cycles on a page cross', () => {
    const m = boot([0x1c, 0xff, 0x12]);
    m.cpu.regs.x = 0x01;
    expect(m.cpu.step()).toBe(5);
    const n = boot([0x1c, 0x00, 0x12]);
    n.cpu.regs.x = 0x01;
    expect(n.cpu.step()).toBe(4);
    const z = boot([0x04, 0x10]);
    expect(z.cpu.step()).toBe(3);
    const i = boot([0x1a]);
    expect(i.cpu.step()).toBe(2);
  });

  it('LXA / ANE use the configurable magic constant', () => {
    const m = boot([0xab, 0xff]);
    m.cpu.magic = 0xff;
    m.cpu.regs.a = 0x00;
    m.cpu.step();
    expect(m.cpu.regs.a).toBe(0xff);
    expect(m.cpu.regs.x).toBe(0xff);
  });

  it('SHY abx stores Y & (H+1); on a page cross the target high byte becomes the value', () => {
    const m = boot([0x9c, 0x00, 0x12]);
    m.cpu.regs.x = 0x10;
    m.cpu.regs.y = 0xff;
    expect(m.cpu.step()).toBe(5);
    expect(m.bus.mem[0x1210]).toBe(0x13); // Y & (0x12 + 1)
    const c = boot([0x9c, 0xf0, 0x12]);
    c.cpu.regs.x = 0x20; // $12F0 + $20 = $1310: crosses a page
    c.cpu.regs.y = 0x55;
    c.cpu.step();
    // value = Y & (H+1) = 0x55 & 0x13 = 0x11; the target's high byte is replaced by it
    expect(c.bus.mem[0x1110]).toBe(0x11);
    expect(c.bus.mem[0x1310]).toBe(0x00); // the uncorrupted target is untouched
  });
});

describe('JAM', () => {
  it('halts the CPU; step() keeps consuming 1 cycle and PC does not move', () => {
    const m = boot([0x02, 0xea]);
    m.cpu.step();
    expect(m.cpu.halted).toBe(true);
    const pc = m.cpu.regs.pc;
    const before = m.cpu.cycles;
    expect(m.cpu.step()).toBe(1);
    expect(m.cpu.regs.pc).toBe(pc);
    expect(m.cpu.cycles).toBe(before + 1);
  });

  it('stays halted with IRQ and NMI asserted; only reset() clears it', () => {
    const m = boot([0x12]);
    m.cpu.regs.p &= ~I;
    m.cpu.step();
    m.cpu.setIrq(true);
    m.cpu.setNmi(true);
    for (let i = 0; i < 10; i++) m.cpu.step();
    expect(m.cpu.halted).toBe(true);
    m.cpu.reset();
    expect(m.cpu.halted).toBe(false);
  });
});
