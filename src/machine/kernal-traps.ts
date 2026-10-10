import type { MOS6502 } from '../core';
import type { DiskDrive } from './drive';

export interface TrapHost {
  cpu: MOS6502;
  ram: Uint8Array;
  /** CPU-visible byte (banking applied, no side effects). */
  peek(addr: number): number;
  /** A CPU-style store: goes through the bus (colour RAM, I/O registers) like the real LOAD. */
  poke(addr: number, value: number): void;
  drive(device: number): DiskDrive | null;
}

const enum Kind {
  None = 0,
  Open,
  Close,
  Chkin,
  Ckout,
  Clrchn,
  Chrin,
  Chrout,
  Getin,
  Clall,
  Load,
  Save,
  Resume,
}

const VECTORS: Array<[number, Kind]> = [
  [0x031a, Kind.Open],
  [0x031c, Kind.Close],
  [0x031e, Kind.Chkin],
  [0x0320, Kind.Ckout],
  [0x0322, Kind.Clrchn],
  [0x0324, Kind.Chrin],
  [0x0326, Kind.Chrout],
  [0x032a, Kind.Getin],
  [0x032c, Kind.Clall],
  [0x0330, Kind.Load],
  [0x0332, Kind.Save],
];

/** Message stub lives in the cassette buffer; it prints through CHROUT and jumps to RESUME. */
const STUB = 0x0350;
const RESUME = 0x03f8;
const MSG = STUB + 16;
const C = 0x01;

interface Saved {
  a: number;
  x: number;
  y: number;
}

export class KernalTraps {
  readonly map = new Uint8Array(0x10000);
  private readonly files = new Map<number, { device: number; sa: number }>();
  private currentIn = -1;
  private currentOut = -1;
  private pending: (() => void) | null = null;
  /** Cassette-buffer bytes overwritten by the message stub, restored when it finishes. */
  private saved: Uint8Array | null = null;
  private readonly active: number[] = [];

  constructor(private readonly host: TrapHost) {}

  /** Re-read the KERNAL vectors; call after boot, reset and when a drive is mounted. */
  refresh(): void {
    for (const addr of this.active) this.map[addr] = Kind.None;
    this.active.length = 0;
    const ram = this.host.ram;
    for (const [vec, kind] of VECTORS) {
      const target = ram[vec]! | (ram[vec + 1]! << 8);
      if (target >= 0x0200) {
        this.map[target] = kind;
        this.active.push(target);
      }
    }
    this.map[RESUME] = Kind.Resume;
    this.active.push(RESUME);
  }

  /** Returns true when the instruction at `pc` was replaced by a handler. */
  handle(pc: number): boolean {
    switch (this.map[pc] as Kind) {
      case Kind.Load:
        return this.load();
      case Kind.Save:
        return this.save();
      case Kind.Open:
        return this.open();
      case Kind.Close:
        return this.close();
      case Kind.Chkin:
        return this.chk(true);
      case Kind.Ckout:
        return this.chk(false);
      case Kind.Clrchn:
        return this.clrchn();
      case Kind.Chrin:
      case Kind.Getin:
        return this.chrin();
      case Kind.Chrout:
        return this.chrout();
      case Kind.Clall:
        this.closeAll();
        return false;
      case Kind.Resume: {
        const p = this.pending;
        this.pending = null;
        if (p) p(); // may start another message (keeps the saved bytes) or finish
        if (this.pending === null) this.restoreBuffer();
        return true;
      }
      default:
        return false;
    }
  }

  // ---- helpers -----------------------------------------------------------------

  private ram(): Uint8Array {
    return this.host.ram;
  }

  private nameBytes(): Uint8Array {
    const ram = this.ram();
    const len = ram[0xb7]!;
    const ptr = ram[0xbb]! | (ram[0xbc]! << 8);
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = this.host.peek((ptr + i) & 0xffff);
    return out;
  }

  /** Pop the return address and continue after the caller's JSR with the given carry. */
  private ret(carry: boolean, regs?: Partial<Saved>): true {
    const cpu = this.host.cpu;
    const r = cpu.regs;
    const ram = this.ram();
    const lo = ram[0x100 + ((r.sp + 1) & 0xff)]!;
    const hi = ram[0x100 + ((r.sp + 2) & 0xff)]!;
    r.sp = (r.sp + 2) & 0xff;
    r.pc = (((hi << 8) | lo) + 1) & 0xffff;
    r.p = carry ? r.p | C : r.p & ~C;
    if (regs?.a !== undefined) r.a = regs.a & 0xff;
    if (regs?.x !== undefined) r.x = regs.x & 0xff;
    if (regs?.y !== undefined) r.y = regs.y & 0xff;
    return true;
  }

  /** Print through the ROM's CHROUT by running a stub, then run `then`. */
  private print(text: string, then: () => void): void {
    const ram = this.ram();
    const stub = [
      0xa2,
      0x00, // LDX #0
      0xbd,
      MSG & 0xff,
      MSG >> 8, // LDA MSG,X
      0xf0,
      0x06, // BEQ done
      0x20,
      0xd2,
      0xff, // JSR $FFD2
      0xe8, // INX
      0xd0,
      0xf5, // BNE loop
      0x4c,
      RESUME & 0xff,
      RESUME >> 8, // JMP RESUME
    ];
    if (this.saved === null) this.saved = ram.slice(STUB, RESUME + 1);
    stub.forEach((b, i) => (ram[STUB + i] = b));
    const bytes = [...text].map((c) => c.charCodeAt(0) & 0xff).slice(0, 60);
    bytes.forEach((b, i) => (ram[MSG + i] = b));
    ram[MSG + bytes.length] = 0;
    this.pending = then;
    this.host.cpu.regs.pc = STUB;
  }

  private ourFile(lf: number): { device: number; sa: number; drive: DiskDrive } | null {
    const f = this.files.get(lf);
    if (!f) return null;
    const drive = this.host.drive(f.device);
    return drive ? { ...f, drive } : null;
  }

  // ---- LOAD / SAVE ---------------------------------------------------------------

  private load(): boolean {
    const ram = this.ram();
    const drive = this.host.drive(ram[0xba]!);
    if (!drive) return false;
    const r = this.host.cpu.regs;
    const verify = r.a === 1;
    const sa = ram[0xb9]!;
    const x = r.x;
    const y = r.y;
    if (ram[0xb7] === 0) return this.ret(true, { a: 8 });
    const name = this.nameBytes();
    const direct = (ram[0x9d]! & 0x80) !== 0;
    const finish = () => {
      const res = drive.loadFile(name);
      if ('error' in res) return this.ret(true, { a: res.error === 74 ? 5 : 4 });
      const data = res.data;
      if (data.length < 2) return this.ret(true, { a: 4 });
      const start = sa === 0 ? x | (y << 8) : data[0]! | (data[1]! << 8);
      let status = 0x40;
      let addr = start;
      for (let i = 2; i < data.length; i++, addr = (addr + 1) & 0xffff) {
        if (verify) {
          if (this.host.peek(addr) !== data[i]) status |= 0x10;
        } else {
          this.host.poke(addr, data[i]!);
        }
      }
      ram[0x90] = status;
      ram[0xae] = addr & 0xff;
      ram[0xaf] = addr >> 8;
      return this.ret(false, { x: addr & 0xff, y: addr >> 8 });
    };
    if (!direct) return finish();
    const label = String.fromCharCode(...name);
    this.print(`SEARCHING FOR ${label}\r`, () => {
      const probe = drive.loadFile(name);
      if ('error' in probe) {
        this.ret(true, { a: probe.error === 74 ? 5 : 4 });
        return;
      }
      this.print(verify ? 'VERIFYING\r' : 'LOADING\r', () => void finish());
    });
    return true;
  }

  private save(): boolean {
    const ram = this.ram();
    const drive = this.host.drive(ram[0xba]!);
    if (!drive) return false;
    // The KERNAL's SAVE entry has already stored the start pointer in $C1/$C2 and the end
    // address in $AE/$AF before it jumps through the vector (A/X/Y are no longer the arguments).
    const start = ram[0xc1]! | (ram[0xc2]! << 8);
    const end = ram[0xae]! | (ram[0xaf]! << 8);
    if (ram[0xb7] === 0) return this.ret(true, { a: 8 });
    const name = this.nameBytes();
    const direct = (ram[0x9d]! & 0x80) !== 0;
    const finish = () => {
      const len = Math.max(0, (end - start) & 0xffff);
      const data = new Uint8Array(2 + len);
      data[0] = start & 0xff;
      data[1] = start >> 8;
      for (let i = 0; i < len; i++) data[2 + i] = this.host.peek((start + i) & 0xffff);
      const code = drive.saveFile(name, data);
      return code === 0 ? this.ret(false) : this.ret(true, { a: code === 74 ? 5 : 4 });
    };
    if (!direct) return finish();
    this.print(`SAVING ${String.fromCharCode(...name)}\r`, () => void finish());
    return true;
  }

  // ---- channels ----------------------------------------------------------------------

  private open(): boolean {
    const ram = this.ram();
    const device = ram[0xba]!;
    const drive = this.host.drive(device);
    if (!drive) return false;
    const lf = ram[0xb8]!;
    const sa = ram[0xb9]!;
    if (this.files.has(lf)) return this.ret(true, { a: 2 });
    this.files.set(lf, { device, sa });
    drive.open(sa & 0x0f, this.nameBytes());
    return this.ret(false);
  }

  private close(): boolean {
    const lf = this.host.cpu.regs.a;
    const f = this.ourFile(lf);
    if (!f) return false;
    f.drive.close(f.sa & 0x0f);
    this.files.delete(lf);
    if (this.currentIn === lf) this.currentIn = -1;
    if (this.currentOut === lf) this.currentOut = -1;
    return this.ret(false);
  }

  private chk(input: boolean): boolean {
    const lf = this.host.cpu.regs.x;
    const f = this.ourFile(lf);
    if (!f) return false;
    const ram = this.ram();
    if (input) {
      this.currentIn = lf;
      ram[0x99] = f.device;
    } else {
      this.currentOut = lf;
      ram[0x9a] = f.device;
    }
    return this.ret(false);
  }

  private clrchn(): boolean {
    if (this.currentIn < 0 && this.currentOut < 0) return false;
    const ram = this.ram();
    if (this.currentIn >= 0) ram[0x99] = 0;
    if (this.currentOut >= 0) ram[0x9a] = 3;
    this.currentIn = this.currentOut = -1;
    return this.ret(false);
  }

  private closeAll(): void {
    for (const [lf, f] of this.files) {
      this.host.drive(f.device)?.close(f.sa & 0x0f);
      this.files.delete(lf);
    }
    this.currentIn = this.currentOut = -1;
  }

  private chrin(): boolean {
    if (this.currentIn < 0) return false;
    const f = this.ourFile(this.currentIn);
    if (!f || this.ram()[0x99] !== f.device) return false;
    const got = f.drive.read(f.sa & 0x0f);
    this.ram()[0x90] = got.eof ? 0x40 : 0;
    return this.ret(false, { a: got.byte });
  }

  private chrout(): boolean {
    if (this.currentOut < 0) return false;
    const f = this.ourFile(this.currentOut);
    if (!f || this.ram()[0x9a] !== f.device) return false;
    f.drive.write(f.sa & 0x0f, this.host.cpu.regs.a);
    return this.ret(false);
  }

  private restoreBuffer(): void {
    if (this.saved !== null) {
      this.ram().set(this.saved, STUB);
      this.saved = null;
    }
  }

  /** Forget open files (machine reset). */
  reset(): void {
    this.files.clear();
    this.currentIn = this.currentOut = -1;
    this.pending = null;
    this.saved = null;
  }
}
