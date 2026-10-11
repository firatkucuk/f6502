import { describe, expect, it } from 'vitest';
import { C, D, I, N, V, Z } from '../../src/core/flags';
import { boot } from './helpers';

describe('reset', () => {
  it('loads PC from $FFFC, sets I, SP=$FD and takes 7 cycles', () => {
    const { cpu } = boot([0xea]);
    expect(cpu.regs.pc).toBe(0x0200);
    expect(cpu.regs.sp).toBe(0xfd);
    expect(cpu.regs.p & I).toBe(I);
    expect(cpu.cycles).toBe(7);
  });
});

describe('load/store', () => {
  it('LDA #imm sets N and takes 2 cycles', () => {
    const { cpu } = boot([0xa9, 0x80]);
    expect(cpu.step()).toBe(2);
    expect(cpu.regs.a).toBe(0x80);
    expect(cpu.regs.p & N).toBe(N);
    expect(cpu.regs.p & Z).toBe(0);
  });

  it('LDA #0 sets Z', () => {
    const { cpu } = boot([0xa9, 0x00]);
    cpu.step();
    expect(cpu.regs.p & Z).toBe(Z);
  });

  it('LDA zp,X wraps inside the zero page and takes 4 cycles', () => {
    const { cpu, bus } = boot([0xa2, 0xff, 0xb5, 0x80]);
    bus.mem[0x7f] = 0x42;
    cpu.step();
    expect(cpu.step()).toBe(4);
    expect(cpu.regs.a).toBe(0x42);
  });

  it('LDA abs,X without page cross: 4 cycles, no dummy read', () => {
    const { cpu, bus } = boot([0xa2, 0x01, 0xbd, 0x00, 0x12]);
    bus.mem[0x1201] = 0x77;
    cpu.step();
    bus.trace = [];
    expect(cpu.step()).toBe(4);
    expect(bus.trace).toEqual([
      [0x0202, 0xbd, 'read'],
      [0x0203, 0x00, 'read'],
      [0x0204, 0x12, 'read'],
      [0x1201, 0x77, 'read'],
    ]);
  });

  it('LDA abs,X with page cross: 5 cycles, dummy read at the uncorrected address', () => {
    const { cpu, bus } = boot([0xa2, 0xff, 0xbd, 0x01, 0x12]);
    bus.mem[0x1300] = 0x55;
    cpu.step();
    bus.trace = [];
    expect(cpu.step()).toBe(5);
    expect(bus.trace[3]).toEqual([0x1200, 0x00, 'read']);
    expect(bus.trace[4]).toEqual([0x1300, 0x55, 'read']);
    expect(cpu.regs.a).toBe(0x55);
  });

  it('STA abs,X always takes 5 cycles with a dummy read before the write', () => {
    const { cpu, bus } = boot([0xa9, 0x99, 0xa2, 0x01, 0x9d, 0x00, 0x12]);
    cpu.step();
    cpu.step();
    bus.trace = [];
    expect(cpu.step()).toBe(5);
    expect(bus.trace[3]).toEqual([0x1201, 0x00, 'read']);
    expect(bus.trace[4]).toEqual([0x1201, 0x99, 'write']);
  });

  it('LDA (zp,X) and LDA (zp),Y resolve pointers', () => {
    const { cpu, bus } = boot([0xa2, 0x02, 0xa1, 0x10, 0xa0, 0x01, 0xb1, 0x20]);
    bus.mem[0x12] = 0x34;
    bus.mem[0x13] = 0x12;
    bus.mem[0x1234] = 0xaa;
    bus.mem[0x20] = 0xff;
    bus.mem[0x21] = 0x12;
    bus.mem[0x1300] = 0xbb;
    cpu.step();
    expect(cpu.step()).toBe(6);
    expect(cpu.regs.a).toBe(0xaa);
    cpu.step();
    expect(cpu.step()).toBe(6); // (zp),Y with page cross
    expect(cpu.regs.a).toBe(0xbb);
  });

  it('STX zp,Y and STY zp,X store with index', () => {
    const { cpu, bus } = boot([0xa2, 0x11, 0xa0, 0x05, 0x96, 0x10, 0x94, 0x20]);
    cpu.step();
    cpu.step();
    cpu.step();
    cpu.step();
    expect(bus.mem[0x15]).toBe(0x11);
    expect(bus.mem[0x31]).toBe(0x05);
  });

  it('wraps PC from $FFFF to $0000 while fetching', () => {
    const { cpu, bus } = boot([0xa9], { origin: 0xffff });
    bus.mem[0x0000] = 0x55;
    expect(cpu.step()).toBe(2);
    expect(cpu.regs.a).toBe(0x55);
    expect(cpu.regs.pc).toBe(0x0001);
  });
});

describe('transfers, flags, NOP', () => {
  it('TAX/TXA/TAY/TYA/TSX/TXS', () => {
    const { cpu } = boot([0xa9, 0x90, 0xaa, 0xa8, 0xa9, 0x00, 0x8a, 0x98, 0xba, 0x9a]);
    cpu.step(); // LDA #$90
    expect(cpu.step()).toBe(2); // TAX
    expect(cpu.regs.x).toBe(0x90);
    cpu.step(); // TAY
    expect(cpu.regs.y).toBe(0x90);
    cpu.step(); // LDA #0
    cpu.step(); // TXA
    expect(cpu.regs.a).toBe(0x90);
    cpu.step(); // TYA
    cpu.step(); // TSX
    expect(cpu.regs.x).toBe(0xfd);
    cpu.regs.x = 0x00;
    const flagsBefore = cpu.regs.p;
    cpu.step(); // TXS must not touch flags
    expect(cpu.regs.sp).toBe(0x00);
    expect(cpu.regs.p).toBe(flagsBefore);
  });

  it('SEC/CLC/CLI/SEI/SED/CLD/CLV', () => {
    const { cpu } = boot([0x38, 0x18, 0x58, 0x78, 0xf8, 0xd8, 0xb8]);
    cpu.regs.p |= V;
    cpu.step();
    expect(cpu.regs.p & C).toBe(C);
    cpu.step();
    expect(cpu.regs.p & C).toBe(0);
    cpu.step();
    expect(cpu.regs.p & I).toBe(0);
    cpu.step();
    expect(cpu.regs.p & I).toBe(I);
    cpu.step();
    expect(cpu.regs.p & D).toBe(D);
    cpu.step();
    expect(cpu.regs.p & D).toBe(0);
    cpu.step();
    expect(cpu.regs.p & V).toBe(0);
  });

  it('NOP takes 2 cycles', () => {
    const { cpu } = boot([0xea]);
    expect(cpu.step()).toBe(2);
  });
});
