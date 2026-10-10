import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { MOS6502 } from '../dist/index.js';

const rom = new URL('../.testdata/klaus/bin_files/6502_functional_test.bin', import.meta.url);
const mem = new Uint8Array(0x10000);
mem.set(readFileSync(rom), 0);
const bus = {
  read: (a) => mem[a],
  write: (a, v) => {
    mem[a] = v;
  },
};
const cpu = new MOS6502(bus);
cpu.regs.pc = 0x0400;

const start = performance.now();
for (;;) {
  const pc = cpu.regs.pc;
  cpu.step();
  if (cpu.regs.pc === pc) break;
}
const seconds = (performance.now() - start) / 1000;
const mhz = cpu.cycles / seconds / 1e6;
console.log(
  `${cpu.cycles} cycles in ${seconds.toFixed(2)} s = ${mhz.toFixed(1)} MHz ` +
    `(${(mhz / 0.985).toFixed(0)}x a PAL C64); final PC $${cpu.regs.pc.toString(16)}`,
);
