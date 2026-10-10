import type { IoChip } from './io';
import { PALETTE } from './palette';
import { renderGraphics } from './vic-graphics';

export const FRAME_WIDTH = 384;
export const FRAME_HEIGHT = 272;
export const CYCLES_PER_LINE = 63;
export const LINES = 312;

const FIRST_VISIBLE_CYCLE = 12;
const LAST_VISIBLE_CYCLE = 59;
const FIRST_G_CYCLE = 16;
const LAST_G_CYCLE = 55;
const FIRST_VISIBLE_RASTER = 15;
const LAST_VISIBLE_RASTER = 286;

export interface VicMemory {
  readMem(addr14: number): number;
  readColor(index: number): number;
}

export class VicII implements IoChip {
  readonly frame = new Uint32Array(FRAME_WIDTH * FRAME_HEIGHT);
  frameCount = 0;
  raster = 0;

  private cycle = 1;
  private readonly regs = new Uint8Array(0x40);
  private status = 0;
  private enable = 0;
  private matched = false;
  private denLatch = false;
  private badline = false;
  private displayState = false;
  private vcBase = 0;
  private vc = 0;
  private rc = 0;
  private vmli = 0;
  private readonly chars = new Uint8Array(40);
  private readonly colors = new Uint8Array(40);
  private readonly bgColors = new Uint8Array(4);
  private readonly gColor = new Uint8Array(8);
  private readonly gFg = new Uint8Array(8);
  private readonly prevColor = new Uint8Array(8);
  private readonly prevFg = new Uint8Array(8);
  private readonly shiftedColor = new Uint8Array(8);
  private readonly shiftedFg = new Uint8Array(8);

  constructor(private readonly mem: VicMemory) {
    this.reset();
  }

  get irq(): boolean {
    return (this.status & this.enable & 0x0f) !== 0;
  }

  get debug() {
    return { vcBase: this.vcBase, vc: this.vc, rc: this.rc, displayState: this.displayState };
  }

  reset(): void {
    this.regs.fill(0);
    this.status = 0;
    this.enable = 0;
    this.matched = false;
    this.denLatch = false;
    this.badline = false;
    this.displayState = false;
    this.vcBase = this.vc = this.rc = this.vmli = 0;
    this.raster = 0;
    this.cycle = 1;
    this.prevColor.fill(0);
    this.prevFg.fill(0);
    // Raster 0 matches compare 0 at power-on; that is the initial state, not an edge.
    this.matched = true;
  }

  // ---- registers --------------------------------------------------------

  read(reg: number): number {
    return this.peek(reg);
  }

  peek(reg: number): number {
    reg &= 0x3f;
    switch (reg) {
      case 0x11:
        return (this.regs[0x11]! & 0x7f) | ((this.raster & 0x100) >> 1);
      case 0x12:
        return this.raster & 0xff;
      case 0x16:
        return this.regs[0x16]! | 0xc0;
      case 0x18:
        return this.regs[0x18]! | 0x01;
      case 0x19:
        return (this.status & 0x0f) | 0x70 | (this.irq ? 0x80 : 0);
      case 0x1a:
        return this.enable | 0xf0;
      case 0x1e:
      case 0x1f:
        return 0;
      default:
        if (reg >= 0x20 && reg <= 0x2e) return this.regs[reg]! | 0xf0;
        if (reg >= 0x2f) return 0xff;
        return this.regs[reg]!;
    }
  }

  write(reg: number, value: number): void {
    reg &= 0x3f;
    value &= 0xff;
    switch (reg) {
      case 0x19:
        this.status &= ~(value & 0x0f);
        return;
      case 0x1a:
        this.enable = value & 0x0f;
        return;
      case 0x11:
      case 0x12:
        this.regs[reg] = value;
        this.checkRasterCompare();
        return;
      default:
        if (reg < 0x2f) this.regs[reg] = value;
    }
  }

  // ---- per-cycle machine --------------------------------------------------

  tick(): void {
    const c = this.cycle;
    if (c === 14) this.beginDisplayLine();
    if (c >= FIRST_VISIBLE_CYCLE && c <= LAST_VISIBLE_CYCLE) this.outputCycle(c);
    if (c === 58) this.endDisplayLine();
    if (c === CYCLES_PER_LINE) {
      this.cycle = 1;
      this.nextLine();
    } else {
      this.cycle = c + 1;
    }
  }

  private nextLine(): void {
    this.raster++;
    if (this.raster >= LINES) {
      this.raster = 0;
      this.vcBase = 0;
      this.frameCount++;
    }
    this.startLine();
  }

  private startLine(): void {
    if (this.raster === 0x30) this.denLatch = (this.regs[0x11]! & 0x10) !== 0;
    this.checkRasterCompare();
  }

  private checkRasterCompare(): void {
    const compare = ((this.regs[0x11]! & 0x80) << 1) | this.regs[0x12]!;
    const match = this.raster === compare;
    if (match && !this.matched) this.status |= 0x01;
    this.matched = match;
  }

  private beginDisplayLine(): void {
    this.vc = this.vcBase;
    this.vmli = 0;
    const yscroll = this.regs[0x11]! & 7;
    this.badline =
      this.denLatch && this.raster >= 0x30 && this.raster <= 0xf7 && (this.raster & 7) === yscroll;
    if (this.badline) {
      this.displayState = true;
      this.rc = 0;
    }
  }

  private endDisplayLine(): void {
    if (this.rc === 7) {
      this.displayState = false;
      this.vcBase = this.vc;
    }
    if (this.displayState) this.rc = (this.rc + 1) & 7;
  }

  private outputCycle(c: number): void {
    const regs = this.regs;
    const ecm = (regs[0x11]! & 0x40) !== 0;
    const mode = (ecm ? 4 : 0) | (regs[0x11]! & 0x20 ? 2 : 0) | (regs[0x16]! & 0x10 ? 1 : 0);
    const bg = this.bgColors;
    bg[0] = regs[0x21]! & 0x0f;
    bg[1] = regs[0x22]! & 0x0f;
    bg[2] = regs[0x23]! & 0x0f;
    bg[3] = regs[0x24]! & 0x0f;

    if (c >= FIRST_G_CYCLE && c <= LAST_G_CYCLE) {
      let glyph: number;
      let code = 0;
      let nibble = 0;
      if (this.displayState) {
        const vm = ((regs[0x18]! >> 4) & 0x0f) << 10;
        if (this.badline) {
          this.chars[this.vmli] = this.mem.readMem(vm + this.vc);
          this.colors[this.vmli] = this.mem.readColor(this.vc & 0x3ff) & 0x0f;
        }
        code = this.chars[this.vmli]!;
        nibble = this.colors[this.vmli]!;
        let addr: number;
        if (mode & 2) {
          addr = ((regs[0x18]! & 0x08) << 10) | (this.vc << 3) | this.rc;
        } else {
          const cb = ((regs[0x18]! >> 1) & 0x07) << 11;
          addr = cb + ((ecm ? code & 0x3f : code) << 3) + this.rc;
        }
        glyph = this.mem.readMem(addr);
        this.vc = (this.vc + 1) & 0x3ff;
        this.vmli = (this.vmli + 1) % 40;
      } else {
        glyph = this.mem.readMem(ecm ? 0x39ff : 0x3fff);
      }
      renderGraphics(this.gColor, this.gFg, mode, glyph, code, nibble, bg);
    } else {
      this.gColor.fill(bg[0]!);
      this.gFg.fill(0);
    }

    const xs = regs[0x16]! & 7;
    for (let i = 0; i < 8; i++) {
      if (i >= xs) {
        this.shiftedColor[i] = this.gColor[i - xs]!;
        this.shiftedFg[i] = this.gFg[i - xs]!;
      } else {
        this.shiftedColor[i] = this.prevColor[8 + i - xs]!;
        this.shiftedFg[i] = this.prevFg[8 + i - xs]!;
      }
    }
    this.prevColor.set(this.gColor);
    this.prevFg.set(this.gFg);

    if (this.raster < FIRST_VISIBLE_RASTER || this.raster > LAST_VISIBLE_RASTER) return;
    const csel = (regs[0x16]! & 0x08) !== 0;
    const rsel = (regs[0x11]! & 0x08) !== 0;
    const den = (regs[0x11]! & 0x10) !== 0;
    const left = csel ? 32 : 39;
    const right = csel ? 352 : 343;
    const top = rsel ? 51 : 55;
    const bottom = rsel ? 251 : 247;
    const verticalOpen = den && this.raster >= top && this.raster < bottom;
    const border = regs[0x20]! & 0x0f;
    const rowBase = (this.raster - FIRST_VISIBLE_RASTER) * FRAME_WIDTH;
    const fx0 = (c - FIRST_VISIBLE_CYCLE) * 8;
    for (let i = 0; i < 8; i++) {
      const fx = fx0 + i;
      const colour = verticalOpen && fx >= left && fx < right ? this.shiftedColor[i]! : border;
      this.frame[rowBase + fx] = PALETTE[colour]!;
    }
  }
}
