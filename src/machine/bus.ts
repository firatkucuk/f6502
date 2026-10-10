import type { Bus } from '../core';
import type { CpuPort } from './cpu-port';
import type { IoChip } from './io';
import { powerOnRam, validateRoms, type RomSet } from './memory';

const RAM = 0;
const BASIC = 1;
const KERNAL = 2;
const CHARGEN = 3;
const IO = 4;

export interface BusChips {
  vic: IoChip;
  cia1: IoChip;
  cia2: IoChip;
  sid: IoChip;
}

export class C64Bus implements Bus {
  readonly ram = new Uint8Array(0x10000);
  readonly colorRam = new Uint8Array(0x400);
  /** VIC bank 0-3, set by the machine from CIA2 port A. */
  vicBank = 0;
  private readonly kind = new Uint8Array(256);

  constructor(
    private readonly roms: RomSet,
    private readonly chips: BusChips,
    private readonly port: CpuPort,
  ) {
    validateRoms(roms);
    this.rebuild();
  }

  powerOn(): void {
    powerOnRam(this.ram);
  }

  rebuild(): void {
    const bits = this.port.bankBits;
    const loram = bits & 1;
    const hiram = (bits >> 1) & 1;
    const charen = (bits >> 2) & 1;
    this.kind.fill(RAM);
    if (hiram && loram) this.kind.fill(BASIC, 0xa0, 0xc0);
    if (hiram) this.kind.fill(KERNAL, 0xe0, 0x100);
    let d000 = CHARGEN;
    if (!hiram && !loram) d000 = RAM;
    else if (!hiram && !charen) d000 = RAM;
    else if (charen) d000 = IO;
    this.kind.fill(d000, 0xd0, 0xe0);
  }

  read(addr: number): number {
    return this.fetchByte(addr & 0xffff, false);
  }

  /** CPU-visible byte with no side effects. */
  peek(addr: number): number {
    return this.fetchByte(addr & 0xffff, true);
  }

  write(addr: number, value: number): void {
    addr &= 0xffff;
    value &= 0xff;
    if (addr < 2) {
      this.port.write(addr as 0 | 1, value);
      return;
    }
    if (this.kind[addr >> 8] === IO) this.writeIo(addr, value);
    else this.ram[addr] = value;
  }

  /** VIC-II memory fetch: 14-bit address within the current bank. */
  vicRead(addr14: number): number {
    const a = addr14 & 0x3fff;
    if ((this.vicBank === 0 || this.vicBank === 2) && a >= 0x1000 && a < 0x2000) {
      return this.roms.chargen[a & 0x0fff]!;
    }
    return this.ram[(this.vicBank << 14) | a]!;
  }

  private fetchByte(addr: number, peek: boolean): number {
    if (addr < 2) return addr === 0 ? this.port.ddr : this.port.readData();
    switch (this.kind[addr >> 8]) {
      case RAM:
        return this.ram[addr]!;
      case BASIC:
        return this.roms.basic[addr & 0x1fff]!;
      case KERNAL:
        return this.roms.kernal[addr & 0x1fff]!;
      case CHARGEN:
        return this.roms.chargen[addr & 0x0fff]!;
      default:
        return this.readIo(addr, peek);
    }
  }

  private readIo(addr: number, peek: boolean): number {
    const page = addr >> 8;
    if (page < 0xd4) {
      const reg = addr & 0x3f;
      return peek ? this.chips.vic.peek(reg) : this.chips.vic.read(reg);
    }
    if (page < 0xd8) {
      const reg = addr & 0x1f;
      return peek ? this.chips.sid.peek(reg) : this.chips.sid.read(reg);
    }
    if (page < 0xdc) return this.colorRam[addr & 0x3ff]! | 0xf0;
    if (page === 0xdc) {
      const reg = addr & 0x0f;
      return peek ? this.chips.cia1.peek(reg) : this.chips.cia1.read(reg);
    }
    if (page === 0xdd) {
      const reg = addr & 0x0f;
      return peek ? this.chips.cia2.peek(reg) : this.chips.cia2.read(reg);
    }
    return 0xff; // expansion I/O
  }

  private writeIo(addr: number, value: number): void {
    const page = addr >> 8;
    if (page < 0xd4) this.chips.vic.write(addr & 0x3f, value);
    else if (page < 0xd8) this.chips.sid.write(addr & 0x1f, value);
    else if (page < 0xdc) this.colorRam[addr & 0x3ff] = value & 0x0f;
    else if (page === 0xdc) this.chips.cia1.write(addr & 0x0f, value);
    else if (page === 0xdd) this.chips.cia2.write(addr & 0x0f, value);
  }
}
