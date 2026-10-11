import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MOS6502, OPS, type Bus } from '../../src/core';

interface State {
  pc: number;
  s: number;
  a: number;
  x: number;
  y: number;
  p: number;
  ram: [number, number][];
}
interface Case {
  name: string;
  initial: State;
  final: State;
  cycles: [number, number, 'read' | 'write'][];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '..', '..', '.testdata', 'singlestep', '6502', 'v1');
const SKIP = JSON.parse(readFileSync(join(HERE, 'singlestep-skip.json'), 'utf8')) as Record<
  string,
  string
>;
const FULL = process.env.SST_FULL === '1';
const SAMPLE = Number(process.env.SST_SAMPLE ?? 200);
const P_MASK = 0xcf; // bits 4 (B) and 5 (always 1) are not real flag storage

class TraceBus implements Bus {
  readonly mem = new Uint8Array(0x10000);
  trace: [number, number, string][] = [];
  read(addr: number): number {
    const v = this.mem[addr]!;
    this.trace.push([addr, v, 'read']);
    return v;
  }
  write(addr: number, value: number): void {
    this.mem[addr] = value;
    this.trace.push([addr, value, 'write']);
  }
}

const hex = (n: number) => n.toString(16).padStart(2, '0');

describe('SingleStepTests skip list', () => {
  it('only skips JAM opcodes (anything else would silently drop 10,000 vectors)', () => {
    for (const key of Object.keys(SKIP)) {
      const opcode = Number.parseInt(key, 16);
      expect(OPS[opcode]?.kind, `opcode $${key}`).toBe('jam');
    }
  });
});

describe('SingleStepTests/65x02 (NMOS 6502)', () => {
  for (let opcode = 0; opcode < 256; opcode++) {
    const name = hex(opcode);
    const skipReason = SKIP[name];
    const run = skipReason ? it.skip : it;
    run(`opcode $${name}${skipReason ? ` (skipped: ${skipReason})` : ''}`, () => {
      const file = join(DIR, `${name}.json`);
      if (!existsSync(file)) throw new Error(`${file} missing: run "npm run fetch-test-data"`);
      const all = JSON.parse(readFileSync(file, 'utf8')) as Case[];
      const cases = FULL ? all : all.slice(0, SAMPLE);
      const bus = new TraceBus();
      const cpu = new MOS6502(bus);
      for (const c of cases) {
        const touched: number[] = [];
        for (const [addr, value] of c.initial.ram) {
          bus.mem[addr] = value;
          touched.push(addr);
        }
        const r = cpu.regs;
        r.pc = c.initial.pc;
        r.sp = c.initial.s;
        r.a = c.initial.a;
        r.x = c.initial.x;
        r.y = c.initial.y;
        r.p = c.initial.p;
        bus.trace = [];
        cpu.step();
        const label = c.name;
        expect(bus.trace, `${label}: bus trace`).toEqual(c.cycles);
        expect(r.pc, `${label}: pc`).toBe(c.final.pc);
        expect(r.sp, `${label}: s`).toBe(c.final.s);
        expect(r.a, `${label}: a`).toBe(c.final.a);
        expect(r.x, `${label}: x`).toBe(c.final.x);
        expect(r.y, `${label}: y`).toBe(c.final.y);
        expect(r.p & P_MASK, `${label}: p`).toBe(c.final.p & P_MASK);
        for (const [addr, value] of c.final.ram) {
          expect(bus.mem[addr], `${label}: ram[${addr.toString(16)}]`).toBe(value);
          touched.push(addr);
        }
        for (const addr of touched) bus.mem[addr] = 0;
      }
    });
  }
});
