import { describe, expect, it } from 'vitest';
import { B, C, I, U, Z } from '../../src/core/flags';
import { boot } from './helpers';

describe('branches', () => {
  it('not taken: 2 cycles', () => {
    const { cpu } = boot([0xf0, 0x10]); // BEQ, Z=0
    expect(cpu.step()).toBe(2);
    expect(cpu.regs.pc).toBe(0x0202);
  });

  it('taken without page cross: 3 cycles', () => {
    const { cpu } = boot([0xd0, 0x10]); // BNE
    expect(cpu.step()).toBe(3);
    expect(cpu.regs.pc).toBe(0x0212);
  });

  it('taken with page cross: 4 cycles, dummy read at the uncorrected address', () => {
    const m = boot([0xd0, 0x7f], { origin: 0x02f0 });
    m.bus.trace = [];
    expect(m.cpu.step()).toBe(4);
    expect(m.cpu.regs.pc).toBe(0x0371);
    expect(m.bus.trace![3]![0]).toBe(0x0271); // (pc&0xff00)|(new&0xff)
  });

  it('backward branch', () => {
    const { cpu } = boot([0xd0, 0xfe]); // BNE *
    cpu.step();
    expect(cpu.regs.pc).toBe(0x0200);
  });
});

describe('jumps and subroutines', () => {
  it('JMP abs: 3 cycles', () => {
    const { cpu } = boot([0x4c, 0x34, 0x12]);
    expect(cpu.step()).toBe(3);
    expect(cpu.regs.pc).toBe(0x1234);
  });

  it('JMP (ind) reproduces the page-wrap bug', () => {
    const m = boot([0x6c, 0xff, 0x12]);
    m.bus.mem[0x12ff] = 0x34;
    m.bus.mem[0x1200] = 0x56; // fetched instead of $1300
    m.bus.mem[0x1300] = 0x99;
    expect(m.cpu.step()).toBe(5);
    expect(m.cpu.regs.pc).toBe(0x5634);
  });

  it('JSR pushes the address of its last byte; RTS returns after it (6 + 6 cycles)', () => {
    const m = boot([0x20, 0x00, 0x03]);
    m.bus.mem[0x0300] = 0x60; // RTS
    expect(m.cpu.step()).toBe(6);
    expect(m.cpu.regs.pc).toBe(0x0300);
    expect(m.bus.mem[0x01fd]).toBe(0x02);
    expect(m.bus.mem[0x01fc]).toBe(0x02);
    expect(m.cpu.regs.sp).toBe(0xfb);
    expect(m.cpu.step()).toBe(6);
    expect(m.cpu.regs.pc).toBe(0x0203);
    expect(m.cpu.regs.sp).toBe(0xfd);
  });
});

describe('stack', () => {
  it('PHA/PLA: 3 and 4 cycles, PLA sets flags', () => {
    const m = boot([0x48, 0xa9, 0x00, 0x68]);
    m.cpu.regs.a = 0x80;
    expect(m.cpu.step()).toBe(3);
    m.cpu.step();
    expect(m.cpu.step()).toBe(4);
    expect(m.cpu.regs.a).toBe(0x80);
  });

  it('PHP pushes B and bit 5 set; PLP ignores B and forces bit 5', () => {
    const m = boot([0x08, 0x28]);
    m.cpu.regs.p = C | I;
    m.cpu.step();
    expect(m.bus.mem[0x01fd]).toBe(C | I | B | U);
    m.bus.mem[0x01fd] = 0xff;
    m.cpu.step();
    expect(m.cpu.regs.p & B).toBe(0);
    expect(m.cpu.regs.p & U).toBe(U);
    expect(m.cpu.regs.p & C).toBe(C);
  });

  it('stack pointer wraps within page 1 on push and pull', () => {
    const m = boot([0x48, 0x68]);
    m.cpu.regs.sp = 0x00;
    m.cpu.regs.a = 0x5a;
    m.cpu.step();
    expect(m.bus.mem[0x0100]).toBe(0x5a);
    expect(m.cpu.regs.sp).toBe(0xff);
    m.cpu.regs.a = 0;
    m.cpu.step();
    expect(m.cpu.regs.sp).toBe(0x00);
    expect(m.cpu.regs.a).toBe(0x5a);
  });
});

describe('BRK / RTI', () => {
  it('BRK: 7 cycles, pushes PC+2 and P with B set, sets I, vectors via $FFFE', () => {
    const m = boot([0x00, 0xea]);
    m.cpu.regs.p = Z;
    expect(m.cpu.step()).toBe(7);
    expect(m.cpu.regs.pc).toBe(0x0300);
    expect(m.cpu.regs.p & I).toBe(I);
    expect(m.bus.mem[0x01fd]).toBe(0x02);
    expect(m.bus.mem[0x01fc]).toBe(0x02);
    expect(m.bus.mem[0x01fb]).toBe(Z | B | U);
  });

  it('RTI restores P and PC (6 cycles)', () => {
    const m = boot([0x00, 0xea]);
    m.bus.mem[0x0300] = 0x40; // RTI
    m.cpu.regs.p = C;
    m.cpu.step();
    expect(m.cpu.step()).toBe(6);
    expect(m.cpu.regs.pc).toBe(0x0202);
    expect(m.cpu.regs.p & C).toBe(C);
    expect(m.cpu.regs.p & I).toBe(0);
  });
});
