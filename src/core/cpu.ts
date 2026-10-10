import type { Bus, CpuHooks } from './bus';
import { B, C, D, I, N, U, V, Z } from './flags';
import { OPS, type Mode } from './opcodes';

export interface Registers {
  a: number;
  x: number;
  y: number;
  sp: number;
  pc: number;
  p: number;
}

export class MOS6502 {
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
  /** Set by a taken, non-page-crossing branch: suppresses this instruction's poll. */
  private skipPoll = false;
  /** High byte of the base address of the last indexed access (for SHA/SHX/SHY/TAS). */
  private baseHi = 0;
  /** Whether the last indexed access crossed a page. */
  private crossed = false;
  private readonly onCycle: (() => void) | null;

  constructor(
    private readonly bus: Bus,
    hooks: CpuHooks = {},
  ) {
    this.onCycle = hooks.onCycle ? hooks.onCycle.bind(hooks) : null;
  }

  // ---- public API -------------------------------------------------------

  reset(): void {
    const r = this.regs;
    this.halted = false;
    this.nmiLatched = false;
    this.serviceNext = false;
    this.skipPoll = false;
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
      return 1;
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
    this.serviceNext = this.samplePrev && !this.skipPoll;
    this.skipPoll = false;
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
      default:
        throw this.unimplemented(m);
    }
  }

  private execRmw(m: string, _addr: number): void {
    throw this.unimplemented(m);
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
      default:
        throw this.unimplemented(m);
    }
  }

  private execBranch(m: string): void {
    throw this.unimplemented(m);
  }

  private execFlow(m: string, _mode: Mode): void {
    throw this.unimplemented(m);
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
