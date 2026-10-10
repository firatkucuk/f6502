import { MOS6502, type Bus } from '../../src/core';

export type TraceEntry = [addr: number, value: number, type: 'read' | 'write'];

export class RamBus implements Bus {
  readonly mem = new Uint8Array(0x10000);
  trace: TraceEntry[] | null = null;

  read(addr: number): number {
    const v = this.mem[addr]!;
    this.trace?.push([addr, v, 'read']);
    return v;
  }

  write(addr: number, value: number): void {
    this.mem[addr] = value;
    this.trace?.push([addr, value, 'write']);
  }
}

export interface MachineOptions {
  origin?: number;
  onCycle?: () => void;
}

/**
 * Builds a RAM-only machine with the program at `origin` (default $0200).
 * Vectors: RESET -> origin, IRQ/BRK -> $0300, NMI -> $0400.
 * Does NOT call reset(): the caller does, so onCycle closures can reference the result.
 */
export function machine(program: number[], opts: MachineOptions = {}) {
  const bus = new RamBus();
  const origin = opts.origin ?? 0x0200;
  bus.mem[0xfffc] = origin & 0xff;
  bus.mem[0xfffd] = origin >> 8;
  bus.mem[0xfffe] = 0x00;
  bus.mem[0xffff] = 0x03;
  bus.mem[0xfffa] = 0x00;
  bus.mem[0xfffb] = 0x04;
  bus.mem.set(program, origin); // last, so a program at $FFFF wins over the IRQ vector
  const cpu = new MOS6502(bus, opts.onCycle ? { onCycle: opts.onCycle } : {});
  return { bus, cpu };
}

/** machine() followed by reset(). */
export function boot(program: number[], opts: MachineOptions = {}) {
  const m = machine(program, opts);
  m.cpu.reset();
  return m;
}
