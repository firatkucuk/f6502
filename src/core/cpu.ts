import type { Bus, CpuHooks } from './bus';
import { B, C, D, I, N, U, V, Z } from './flags';
import { OPS, type Mode } from './opcodes';

const MAX_STALL_CYCLES = 4096;

export interface Registers {
  a: number;
  x: number;
  y: number;
  sp: number;
  pc: number;
  p: number;
}

export class MOS6502 {
  /**
   * Register file. Callers that write to it must keep fields in range (a, x, y, sp, p: 0-255;
   * pc: 0-65535); the CPU does not renormalise values written from outside.
   */
  readonly regs: Registers = { a: 0, x: 0, y: 0, sp: 0, pc: 0, p: I | U };
  cycles = 0;
  /** Set by JAM opcodes, cleared by reset(). */
  halted = false;
  /** "Magic" constant for the analogue-dependent ANE and LXA opcodes. */
  magic = 0xee;

  private irqLine = false;
  private nmiLine = false;
  private nmiLatched = false;
  /** Interrupt-pending sample from the end of the most recent cycle. */
  private sampleNow = false;
  /** Sample from the end of the cycle before that (the penultimate-cycle sample). */
  private samplePrev = false;
  /** Decision taken at the end of the previous instruction. */
  private serviceNext = false;
  /**
   * Set by a taken, non-page-crossing branch: the poll result of its first cycle, which is the
   * only poll such a branch performs. Overrides the penultimate-cycle sample.
   */
  private branchPoll: boolean | null = null;
  /** High byte of the base address of the last indexed access (for SHA/SHX/SHY/TAS). */
  private baseHi = 0;
  /** Whether the last indexed access crossed a page. */
  private crossed = false;
  private readonly onCycle: (() => void) | null;
  private readonly rdy: (() => boolean) | null;

  constructor(
    private readonly bus: Bus,
    hooks: CpuHooks = {},
  ) {
    this.onCycle = hooks.onCycle ? hooks.onCycle.bind(hooks) : null;
    this.rdy = hooks.rdy ? hooks.rdy.bind(hooks) : null;
  }

  // ---- public API -------------------------------------------------------

  reset(): void {
    const r = this.regs;
    this.halted = false;
    this.nmiLatched = false;
    this.serviceNext = false;
    this.branchPoll = null;
    this.read(r.pc); // cycles 1-2: dummy reads
    this.read(r.pc);
    for (let i = 0; i < 3; i++) {
      // cycles 3-5: stack accesses are reads during reset
      this.read(0x100 | r.sp);
      r.sp = (r.sp - 1) & 0xff;
    }
    r.p |= I;
    const lo = this.read(0xfffc);
    const hi = this.read(0xfffd);
    r.pc = lo | (hi << 8);
  }

  /** Runs one instruction (or one interrupt sequence). Returns the cycles consumed. */
  step(): number {
    const start = this.cycles;
    const r = this.regs;
    if (this.halted) {
      this.read(0xffff); // a jammed CPU keeps the clock running
      return this.cycles - start;
    }
    if (this.serviceNext) {
      this.serviceNext = false;
      this.read(r.pc); // cycle 1: opcode fetch, discarded
      this.read(r.pc); // cycle 2: dummy read
      this.pushVector(false);
      return this.cycles - start;
    }
    const opcode = this.fetch();
    const e = OPS[opcode]!;
    switch (e.kind) {
      case 'read':
        this.execRead(e.mnemonic, this.resolve(e.mode, false));
        break;
      case 'write':
        this.execWrite(e.mnemonic, this.resolve(e.mode, true));
        break;
      case 'rmw':
        this.execRmw(e.mnemonic, this.resolve(e.mode, true));
        break;
      case 'implied':
        this.execImplied(e.mnemonic);
        break;
      case 'branch':
        this.execBranch(e.mnemonic);
        break;
      case 'flow':
        this.execFlow(e.mnemonic, e.mode);
        break;
      case 'jam':
        this.halted = true;
        break;
    }
    this.serviceNext = this.branchPoll ?? this.samplePrev;
    this.branchPoll = null;
    return this.cycles - start;
  }

  setIrq(level: boolean): void {
    this.irqLine = level;
  }

  setNmi(level: boolean): void {
    if (level && !this.nmiLine) this.nmiLatched = true;
    this.nmiLine = level;
  }

  // ---- cycle primitives -------------------------------------------------

  private endCycle(): void {
    this.cycles++;
    if (this.onCycle !== null) this.onCycle();
    this.samplePrev = this.sampleNow;
    this.sampleNow = this.nmiLatched || (this.irqLine && (this.regs.p & I) === 0);
  }

  private read(addr: number): number {
    if (this.rdy !== null) {
      for (let idle = 0; idle < MAX_STALL_CYCLES && !this.rdy(); idle++) this.endCycle();
    }
    const v = this.bus.read(addr & 0xffff) & 0xff;
    this.endCycle();
    return v;
  }

  private write(addr: number, value: number): void {
    this.bus.write(addr & 0xffff, value & 0xff);
    this.endCycle();
  }

  private fetch(): number {
    const r = this.regs;
    const v = this.read(r.pc);
    r.pc = (r.pc + 1) & 0xffff;
    return v;
  }

  private push(v: number): void {
    const r = this.regs;
    this.write(0x100 | r.sp, v);
    r.sp = (r.sp - 1) & 0xff;
  }

  private pull(): number {
    const r = this.regs;
    r.sp = (r.sp + 1) & 0xff;
    return this.read(0x100 | r.sp);
  }

  private nz(v: number): number {
    const r = this.regs;
    r.p = (r.p & ~(N | Z)) | (v & N) | (v === 0 ? Z : 0);
    return v;
  }

  private adc(v: number): void {
    const r = this.regs;
    const a = r.a;
    const c = r.p & C;
    const bin = a + v + c;
    if (r.p & D) {
      let al = (a & 0x0f) + (v & 0x0f) + c;
      if (al >= 0x0a) al = ((al + 0x06) & 0x0f) + 0x10;
      const signed = (((a & 0xf0) << 24) >> 24) + (((v & 0xf0) << 24) >> 24) + al;
      let s = (a & 0xf0) + (v & 0xf0) + al;
      let p = r.p & ~(N | V | Z | C);
      if ((bin & 0xff) === 0) p |= Z; // NMOS: Z from the binary sum
      if (signed & 0x80) p |= N;
      if (signed < -128 || signed > 127) p |= V;
      if (s >= 0xa0) s += 0x60;
      if (s >= 0x100) p |= C;
      r.p = p;
      r.a = s & 0xff;
      return;
    }
    let p = r.p & ~(N | V | Z | C);
    if (~(a ^ v) & (a ^ bin) & 0x80) p |= V;
    if (bin > 0xff) p |= C;
    r.p = p;
    r.a = this.nz(bin & 0xff);
  }

  private sbc(v: number): void {
    const r = this.regs;
    const a = r.a;
    const c = r.p & C;
    const bin = a - v - (1 - c);
    let p = r.p & ~(N | V | Z | C);
    if ((a ^ v) & (a ^ bin) & 0x80) p |= V;
    if (bin >= 0) p |= C;
    if ((bin & 0xff) === 0) p |= Z;
    if (bin & 0x80) p |= N;
    if (r.p & D) {
      let al = (a & 0x0f) - (v & 0x0f) + c - 1;
      if (al < 0) al = ((al - 0x06) & 0x0f) - 0x10;
      let t = (a & 0xf0) - (v & 0xf0) + al;
      if (t < 0) t -= 0x60;
      r.p = p;
      r.a = t & 0xff;
      return;
    }
    r.p = p;
    r.a = bin & 0xff;
  }

  private compare(reg: number, v: number): void {
    const r = this.regs;
    r.p = (r.p & ~C) | (reg >= v ? C : 0);
    this.nz((reg - v) & 0xff);
  }

  private asl(v: number): number {
    this.regs.p = (this.regs.p & ~C) | (v >> 7);
    return this.nz((v << 1) & 0xff);
  }

  private lsr(v: number): number {
    this.regs.p = (this.regs.p & ~C) | (v & 1);
    return this.nz(v >> 1);
  }

  private rol(v: number): number {
    const c = this.regs.p & C;
    this.regs.p = (this.regs.p & ~C) | (v >> 7);
    return this.nz(((v << 1) | c) & 0xff);
  }

  private ror(v: number): number {
    const c = this.regs.p & C;
    this.regs.p = (this.regs.p & ~C) | (v & 1);
    return this.nz((v >> 1) | (c << 7));
  }

  private arr(v: number): void {
    const r = this.regs;
    const t = r.a & v;
    const c = r.p & C;
    let res = (t >> 1) | (c << 7);
    let p = r.p & ~(N | V | Z | C);
    if (res & 0x80) p |= N;
    if (res === 0) p |= Z;
    if (r.p & D) {
      if (((res ^ t) & 0x40) !== 0) p |= V;
      if ((t & 0x0f) + (t & 0x01) > 5) res = (res & 0xf0) | ((res + 6) & 0x0f);
      if ((t & 0xf0) + (t & 0x10) > 0x50) {
        res = (res & 0x0f) | ((res + 0x60) & 0xf0);
        p |= C;
      }
    } else {
      if (res & 0x40) p |= C;
      if (((res >> 6) ^ (res >> 5)) & 1) p |= V;
    }
    r.p = p;
    r.a = res & 0xff;
  }

  /** SHA/SHX/SHY/TAS: value & (H+1); on a page cross the target's high byte becomes the value. */
  private writeUnstable(addr: number, source: number): void {
    const value = source & ((this.baseHi + 1) & 0xff);
    const target = this.crossed ? (value << 8) | (addr & 0xff) : addr;
    this.write(target, value);
  }

  // ---- addressing modes -------------------------------------------------

  /** Returns the effective address, performing the real bus accesses of the mode. */
  private resolve(mode: Mode, dummyAlways: boolean): number {
    const r = this.regs;
    switch (mode) {
      case 'imm': {
        const a = r.pc;
        r.pc = (r.pc + 1) & 0xffff;
        return a;
      }
      case 'zp':
        return this.fetch();
      case 'zpx': {
        const b = this.fetch();
        this.read(b);
        return (b + r.x) & 0xff;
      }
      case 'zpy': {
        const b = this.fetch();
        this.read(b);
        return (b + r.y) & 0xff;
      }
      case 'abs': {
        const lo = this.fetch();
        return lo | (this.fetch() << 8);
      }
      case 'abx':
        return this.indexed(r.x, dummyAlways);
      case 'aby':
        return this.indexed(r.y, dummyAlways);
      case 'izx': {
        const b = this.fetch();
        this.read(b);
        const p = (b + r.x) & 0xff;
        const lo = this.read(p);
        const hi = this.read((p + 1) & 0xff);
        return lo | (hi << 8);
      }
      case 'izy': {
        const b = this.fetch();
        const lo = this.read(b);
        const hi = this.read((b + 1) & 0xff);
        const sum = lo + r.y;
        this.baseHi = hi;
        this.crossed = sum > 0xff;
        if (this.crossed || dummyAlways) this.read((hi << 8) | (sum & 0xff));
        return ((hi << 8) + sum) & 0xffff;
      }
      default:
        throw new Error(`resolve: unsupported mode ${mode}`);
    }
  }

  private indexed(index: number, dummyAlways: boolean): number {
    const lo = this.fetch();
    const hi = this.fetch();
    const sum = lo + index;
    this.baseHi = hi;
    this.crossed = sum > 0xff;
    if (this.crossed || dummyAlways) this.read((hi << 8) | (sum & 0xff));
    return ((hi << 8) + sum) & 0xffff;
  }

  // ---- operation groups -------------------------------------------------

  private unimplemented(m: string): Error {
    return new Error(`Unimplemented instruction ${m}`);
  }

  private execRead(m: string, addr: number): void {
    const r = this.regs;
    const v = this.read(addr);
    switch (m) {
      case 'LDA':
        r.a = this.nz(v);
        break;
      case 'LDX':
        r.x = this.nz(v);
        break;
      case 'LDY':
        r.y = this.nz(v);
        break;
      case 'AND':
        r.a = this.nz(r.a & v);
        break;
      case 'ORA':
        r.a = this.nz(r.a | v);
        break;
      case 'EOR':
        r.a = this.nz(r.a ^ v);
        break;
      case 'ADC':
        this.adc(v);
        break;
      case 'SBC':
        this.sbc(v);
        break;
      case 'CMP':
        this.compare(r.a, v);
        break;
      case 'CPX':
        this.compare(r.x, v);
        break;
      case 'CPY':
        this.compare(r.y, v);
        break;
      case 'BIT':
        r.p = (r.p & ~(N | V | Z)) | (v & (N | V)) | ((r.a & v) === 0 ? Z : 0);
        break;
      case 'LAX':
        r.a = r.x = this.nz(v);
        break;
      case 'ANC':
        r.a = this.nz(r.a & v);
        r.p = (r.p & ~C) | ((r.a >> 7) & 1);
        break;
      case 'ALR':
        r.a = this.lsr(r.a & v);
        break;
      case 'ARR':
        this.arr(v);
        break;
      case 'SBX': {
        const t = r.a & r.x;
        r.p = (r.p & ~C) | (t >= v ? C : 0);
        r.x = this.nz((t - v) & 0xff);
        break;
      }
      case 'ANE':
        r.a = this.nz((r.a | this.magic) & r.x & v);
        break;
      case 'LXA':
        r.a = r.x = this.nz((r.a | this.magic) & v);
        break;
      case 'LAS': {
        const t = v & r.sp;
        r.a = r.x = r.sp = this.nz(t);
        break;
      }
      case 'NOP':
        break;
      default:
        throw this.unimplemented(m);
    }
  }

  private execWrite(m: string, addr: number): void {
    const r = this.regs;
    switch (m) {
      case 'STA':
        this.write(addr, r.a);
        break;
      case 'STX':
        this.write(addr, r.x);
        break;
      case 'STY':
        this.write(addr, r.y);
        break;
      case 'SAX':
        this.write(addr, r.a & r.x);
        break;
      case 'SHA':
        this.writeUnstable(addr, r.a & r.x);
        break;
      case 'SHX':
        this.writeUnstable(addr, r.x);
        break;
      case 'SHY':
        this.writeUnstable(addr, r.y);
        break;
      case 'TAS':
        r.sp = r.a & r.x;
        this.writeUnstable(addr, r.sp);
        break;
      default:
        throw this.unimplemented(m);
    }
  }

  private execRmw(m: string, addr: number): void {
    const v = this.read(addr);
    this.write(addr, v); // dummy write of the original value
    let n: number;
    switch (m) {
      case 'ASL':
        n = this.asl(v);
        break;
      case 'LSR':
        n = this.lsr(v);
        break;
      case 'ROL':
        n = this.rol(v);
        break;
      case 'ROR':
        n = this.ror(v);
        break;
      case 'INC':
        n = this.nz((v + 1) & 0xff);
        break;
      case 'DEC':
        n = this.nz((v - 1) & 0xff);
        break;
      case 'SLO':
        n = this.asl(v);
        this.regs.a = this.nz(this.regs.a | n);
        break;
      case 'RLA':
        n = this.rol(v);
        this.regs.a = this.nz(this.regs.a & n);
        break;
      case 'SRE':
        n = this.lsr(v);
        this.regs.a = this.nz(this.regs.a ^ n);
        break;
      case 'RRA':
        n = this.ror(v);
        this.adc(n);
        break;
      case 'DCP':
        n = (v - 1) & 0xff;
        this.compare(this.regs.a, n);
        break;
      case 'ISC':
        n = (v + 1) & 0xff;
        this.sbc(n);
        break;
      default:
        throw this.unimplemented(m);
    }
    this.write(addr, n);
  }

  private execImplied(m: string): void {
    const r = this.regs;
    this.read(r.pc); // cycle 2: dummy read of the next opcode byte
    switch (m) {
      case 'NOP':
        break;
      case 'TAX':
        r.x = this.nz(r.a);
        break;
      case 'TXA':
        r.a = this.nz(r.x);
        break;
      case 'TAY':
        r.y = this.nz(r.a);
        break;
      case 'TYA':
        r.a = this.nz(r.y);
        break;
      case 'TSX':
        r.x = this.nz(r.sp);
        break;
      case 'TXS':
        r.sp = r.x;
        break;
      case 'CLC':
        r.p &= ~C;
        break;
      case 'SEC':
        r.p |= C;
        break;
      case 'CLI':
        r.p &= ~I;
        break;
      case 'SEI':
        r.p |= I;
        break;
      case 'CLD':
        r.p &= ~D;
        break;
      case 'SED':
        r.p |= D;
        break;
      case 'CLV':
        r.p &= ~V;
        break;
      case 'INX':
        r.x = this.nz((r.x + 1) & 0xff);
        break;
      case 'INY':
        r.y = this.nz((r.y + 1) & 0xff);
        break;
      case 'DEX':
        r.x = this.nz((r.x - 1) & 0xff);
        break;
      case 'DEY':
        r.y = this.nz((r.y - 1) & 0xff);
        break;
      case 'ASL':
        r.a = this.asl(r.a);
        break;
      case 'LSR':
        r.a = this.lsr(r.a);
        break;
      case 'ROL':
        r.a = this.rol(r.a);
        break;
      case 'ROR':
        r.a = this.ror(r.a);
        break;
      default:
        throw this.unimplemented(m);
    }
  }

  private execBranch(m: string): void {
    const r = this.regs;
    const offset = this.fetch(); // cycle 2
    const polled = this.samplePrev; // sample from the end of cycle 1
    let taken: boolean;
    switch (m) {
      case 'BPL':
        taken = (r.p & N) === 0;
        break;
      case 'BMI':
        taken = (r.p & N) !== 0;
        break;
      case 'BVC':
        taken = (r.p & V) === 0;
        break;
      case 'BVS':
        taken = (r.p & V) !== 0;
        break;
      case 'BCC':
        taken = (r.p & C) === 0;
        break;
      case 'BCS':
        taken = (r.p & C) !== 0;
        break;
      case 'BNE':
        taken = (r.p & Z) === 0;
        break;
      case 'BEQ':
        taken = (r.p & Z) !== 0;
        break;
      default:
        throw this.unimplemented(m);
    }
    if (!taken) return;
    this.read(r.pc); // cycle 3: dummy read
    const target = (r.pc + ((offset << 24) >> 24)) & 0xffff;
    if ((target & 0xff00) !== (r.pc & 0xff00)) {
      this.read((r.pc & 0xff00) | (target & 0xff)); // cycle 4: page-fixup dummy read
    } else {
      // A taken, non-crossing branch has no poll at the end of cycle 2: only what was pending
      // at the end of cycle 1 is serviced after it; anything newer waits one instruction.
      this.branchPoll = polled;
    }
    r.pc = target;
  }

  private execFlow(m: string, mode: Mode): void {
    const r = this.regs;
    switch (m) {
      case 'JMP': {
        if (mode === 'abs') {
          const lo = this.fetch();
          r.pc = lo | (this.fetch() << 8);
        } else {
          const pl = this.fetch();
          const ptr = pl | (this.fetch() << 8);
          const lo = this.read(ptr);
          const hi = this.read((ptr & 0xff00) | ((ptr + 1) & 0xff));
          r.pc = lo | (hi << 8);
        }
        break;
      }
      case 'JSR': {
        const lo = this.fetch(); // cycle 2
        this.read(0x100 | r.sp); // cycle 3: internal operation
        this.push(r.pc >> 8); // cycle 4
        this.push(r.pc & 0xff); // cycle 5
        const hi = this.fetch(); // cycle 6
        r.pc = lo | (hi << 8);
        break;
      }
      case 'RTS': {
        this.read(r.pc); // cycle 2
        this.read(0x100 | r.sp); // cycle 3
        const lo = this.pull(); // cycle 4
        const hi = this.pull(); // cycle 5
        r.pc = lo | (hi << 8);
        this.read(r.pc); // cycle 6
        r.pc = (r.pc + 1) & 0xffff;
        break;
      }
      case 'RTI': {
        this.read(r.pc); // cycle 2
        this.read(0x100 | r.sp); // cycle 3
        r.p = (this.pull() | U) & ~B; // cycle 4
        const lo = this.pull(); // cycle 5
        const hi = this.pull(); // cycle 6
        r.pc = lo | (hi << 8);
        break;
      }
      case 'BRK':
        this.fetch(); // cycle 2: padding byte
        this.pushVector(true);
        break;
      case 'PHA':
        this.read(r.pc);
        this.push(r.a);
        break;
      case 'PHP':
        this.read(r.pc);
        this.push(r.p | B | U);
        break;
      case 'PLA':
        this.read(r.pc);
        this.read(0x100 | r.sp);
        r.a = this.nz(this.pull());
        break;
      case 'PLP':
        this.read(r.pc);
        this.read(0x100 | r.sp);
        r.p = (this.pull() | U) & ~B;
        break;
      default:
        throw this.unimplemented(m);
    }
  }

  /** Cycles 3-7 of BRK / IRQ / NMI. Cycles 1-2 are done by the caller. */
  private pushVector(brk: boolean): void {
    const r = this.regs;
    this.push(r.pc >> 8);
    this.push(r.pc & 0xff);
    this.push((r.p | U | (brk ? B : 0)) & 0xff);
    r.p |= I;
    let vec = 0xfffe;
    if (this.nmiLatched) {
      vec = 0xfffa; // an NMI that arrived by now hijacks the vector
      this.nmiLatched = false;
    }
    const lo = this.read(vec);
    const hi = this.read(vec + 1);
    r.pc = lo | (hi << 8);
  }
}
