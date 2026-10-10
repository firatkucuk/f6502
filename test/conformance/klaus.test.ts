import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MOS6502, type Bus } from '../../src/core';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '..', '..', '.testdata', 'klaus', 'bin_files');

function load(name: string): Uint8Array {
  const file = join(DIR, name);
  if (!existsSync(file)) {
    throw new Error(`${file} missing: run "npm run fetch-test-data" first`);
  }
  return new Uint8Array(readFileSync(file));
}

class FlatBus implements Bus {
  readonly mem = new Uint8Array(0x10000);
  read(addr: number): number {
    return this.mem[addr]!;
  }
  write(addr: number, value: number): void {
    this.mem[addr] = value;
  }
}

/** Runs until the PC stops advancing (a trap) or the instruction budget is exhausted. */
function runToTrap(cpu: MOS6502, maxInstructions: number): number {
  for (let i = 0; i < maxInstructions; i++) {
    const pc = cpu.regs.pc;
    cpu.step();
    if (cpu.regs.pc === pc) return pc; // jmp * / branch-to-self
  }
  throw new Error('instruction budget exhausted without reaching a trap');
}

describe('Klaus Dormann 6502 functional test', () => {
  it('reaches the success trap at $3469', () => {
    const bus = new FlatBus();
    bus.mem.set(load('6502_functional_test.bin'), 0x0000);
    const cpu = new MOS6502(bus);
    cpu.regs.pc = 0x0400;
    const trap = runToTrap(cpu, 200_000_000);
    expect(trap.toString(16)).toBe((0x3469).toString(16));
  });
});
