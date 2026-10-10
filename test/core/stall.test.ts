import { describe, expect, it } from 'vitest';
import { MOS6502 } from '../../src/core';
import { I } from '../../src/core/flags';
import { RamBus } from './helpers';

function rig(
  program: number[],
  baLow: (cpu: MOS6502) => boolean,
  onCycle?: (cpu: MOS6502) => void,
) {
  const bus = new RamBus();
  bus.mem.set(program, 0x0200);
  bus.mem[0xfffc] = 0x00;
  bus.mem[0xfffd] = 0x02;
  bus.mem[0xfffe] = 0x00;
  bus.mem[0xffff] = 0x03;
  const ref: { cpu?: MOS6502 } = {};
  const cpu = new MOS6502(bus, {
    rdy: () => !baLow(ref.cpu!),
    onCycle: () => onCycle?.(ref.cpu!),
  });
  ref.cpu = cpu;
  return { cpu, bus };
}

describe('CpuHooks.rdy', () => {
  it('holds a read for each idle cycle, with no bus access, and counts the cycles', () => {
    // BA low for cycles 7..9 (the three cycles after reset): the opcode fetch waits.
    const { cpu, bus } = rig([0xa9, 0x42], (c) => c.cycles >= 7 && c.cycles < 10);
    cpu.reset();
    bus.trace = [];
    expect(cpu.step()).toBe(5); // 3 idle + opcode + operand
    expect(cpu.regs.a).toBe(0x42);
    expect(bus.trace).toEqual([
      [0x0200, 0xa9, 'read'],
      [0x0201, 0x42, 'read'],
    ]);
  });

  it('never delays a write; the next read pays the remaining stall', () => {
    // STA $10 ; LDA #1. BA low for cycles 9..12 (index of cpu.cycles): the write is cycle 10.
    const { cpu, bus } = rig([0x85, 0x10, 0xa9, 0x01], (c) => c.cycles >= 9 && c.cycles < 12);
    cpu.regs.a = 0x77;
    cpu.reset();
    bus.trace = [];
    expect(cpu.step()).toBe(3); // opcode(8), operand(9), write(10): the write is not held
    expect(bus.mem[0x10]).toBe(0x77);
    expect(bus.trace![2]).toEqual([0x0010, 0x77, 'write']);
    expect(cpu.step()).toBe(4); // two idle cycles (10, 11) + opcode + operand
    expect(cpu.regs.a).toBe(0x01);
  });

  it('holds the dummy reads of indexed and read-modify-write instructions too', () => {
    // INC $10,X is 6 cycles. BA low for the whole instruction: only reads stall.
    const stolen: number[] = [];
    const { cpu } = rig(
      [0xf6, 0x10],
      (c) => c.cycles >= 7 && c.cycles < 20,
      () => stolen.push(1),
    );
    cpu.reset();
    const start = cpu.cycles;
    cpu.step();
    // 6 real cycles (4 reads + 2 writes); the two writes are not held, every read is.
    expect(cpu.cycles - start).toBeGreaterThan(6);
  });

  it('samples interrupt lines during idle cycles', () => {
    const { cpu } = rig(
      [0xea, 0xea],
      (c) => c.cycles >= 7 && c.cycles < 10,
      (c) => {
        if (c.cycles === 8) c.setIrq(true); // asserted while the CPU is held
      },
    );
    cpu.reset();
    cpu.regs.p &= ~I;
    expect(cpu.step()).toBe(5); // 3 idle + NOP
    expect(cpu.step()).toBe(7); // the interrupt sequence, taken at the instruction boundary
    expect(cpu.regs.pc).toBe(0x0300);
  });

  it('gives up after 4096 consecutive idle cycles per read (guard)', () => {
    const { cpu } = rig([0xa9, 0x01], () => true);
    cpu.reset();
    const start = cpu.cycles;
    cpu.step();
    expect(cpu.regs.a).toBe(0x01);
    expect(cpu.cycles - start).toBe(2 + 2 * 4096);
  });

  it('without the hook behaves exactly as before', () => {
    const bus = new RamBus();
    bus.mem.set([0xa9, 0x42], 0x0200);
    bus.mem[0xfffc] = 0x00;
    bus.mem[0xfffd] = 0x02;
    const cpu = new MOS6502(bus);
    cpu.reset();
    expect(cpu.step()).toBe(2);
  });
});
