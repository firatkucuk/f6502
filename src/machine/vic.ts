import type { IoChip } from './io';
import { PALETTE } from './palette';
import { renderGraphics } from './vic-graphics';
import { SPRITE_BA } from './vic-schedule';
import { VicSprites as Sprites } from './vic-sprites';

export const FRAME_WIDTH = 384;
export const FRAME_HEIGHT = 272;
export const CYCLES_PER_LINE = 63;
export const LINES = 312;
export const CYCLES_PER_FRAME = CYCLES_PER_LINE * LINES;

const FIRST_VISIBLE_CYCLE = 12;
const LAST_VISIBLE_CYCLE = 59;
const FIRST_G_CYCLE = 16;
const LAST_G_CYCLE = 55;
const FIRST_C_CYCLE = 15;
const LAST_C_CYCLE = 54;
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

  /** BA during the cycle most recently processed: true holds the CPU on read cycles. */
  baLow = false;

  /** The cycle the next tick() processes. */
  private cycle = 2;
  private lineWrapPending = false;
  private denSeen = false;
  /** Cycle at which BA went low for the current badline, or -1. */
  private baStart = -1;
  private mainBorder = true;
  private verticalBorder = true;
  private readonly regs = new Uint8Array(0x40);
  private status = 0;
  private enable = 0;
  private matched = false;
  private displayState = false;
  private vcBase = 0;
  private vc = 0;
  private rc = 0;
  private vmli = 0;
  private readonly chars = new Uint8Array(64);
  private readonly colors = new Uint8Array(64);
  private readonly bgColors = new Uint8Array(4);
  private readonly gColor = new Uint8Array(8);
  private readonly gFg = new Uint8Array(8);
  private readonly prevColor = new Uint8Array(8);
  private readonly prevFg = new Uint8Array(8);
  private readonly shiftedColor = new Uint8Array(8);
  private readonly shiftedFg = new Uint8Array(8);
  private readonly sprites: Sprites;
  private spriteSpriteHits = 0;
  private spriteBgHits = 0;

  constructor(private readonly mem: VicMemory) {
    this.sprites = new Sprites(this.regs, mem);
    this.reset();
  }

  /**
   * IRQ condition at the start of the current tick. VICE raises the line in the second half of
   * the cycle, so a new interrupt reaches the CPU one cycle after the VIC sets the flag; an
   * acknowledge or mask write still drops it at once.
   */
  private irqBefore = false;

  get irq(): boolean {
    return this.irqBefore && (this.status & this.enable & 0x0f) !== 0;
  }

  get debug() {
    return {
      vcBase: this.vcBase,
      vc: this.vc,
      rc: this.rc,
      displayState: this.displayState,
      cycle: this.cycle,
      sprites: {
        dma: Array.from(this.sprites.dma),
        display: Array.from(this.sprites.display),
        mcBase: Array.from(this.sprites.mcBase),
      },
    };
  }

  reset(): void {
    this.regs.fill(0);
    this.status = 0;
    this.enable = 0;
    this.matched = false;
    this.denSeen = false;
    this.displayState = false;
    this.baStart = -1;
    this.mainBorder = true;
    this.verticalBorder = true;
    this.baLow = false;
    this.irqBefore = false;
    this.lineWrapPending = false;
    this.vcBase = this.vc = this.rc = this.vmli = 0;
    this.raster = 0;
    this.cycle = 2;
    this.chars.fill(0);
    this.colors.fill(0);
    this.prevColor.fill(0);
    this.prevFg.fill(0);
    this.spriteSpriteHits = 0;
    this.spriteBgHits = 0;
    this.sprites.reset();
    // Raster 0 matches compare 0 at power-on; that is the initial state, not an edge.
    this.matched = true;
  }

  // ---- registers --------------------------------------------------------

  read(reg: number): number {
    reg &= 0x3f;
    if (reg === 0x1e) {
      const v = this.spriteSpriteHits;
      this.spriteSpriteHits = 0;
      return v;
    }
    if (reg === 0x1f) {
      const v = this.spriteBgHits;
      this.spriteBgHits = 0;
      return v;
    }
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
        // Bit 7 follows the flag at once (VICE); only the line to the CPU is delayed.
        return (this.status & 0x0f) | 0x70 | (this.status & this.enable & 0x0f ? 0x80 : 0);
      case 0x1a:
        return this.enable | 0xf0;
      case 0x1e:
        return this.spriteSpriteHits;
      case 0x1f:
        return this.spriteBgHits;
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
      case 0x1e:
      case 0x1f:
        return; // collision registers are read-only
      case 0x11:
      case 0x12:
        this.regs[reg] = value;
        this.checkRasterCompare();
        return;
      case 0x17:
        this.regs[reg] = value;
        this.sprites.yExpandWritten(value);
        return;
      default:
        if (reg < 0x2f) this.regs[reg] = value;
    }
  }

  // ---- per-cycle machine --------------------------------------------------

  tick(): void {
    this.irqBefore = (this.status & this.enable & 0x0f) !== 0;
    const c = this.cycle;
    const regs = this.regs;

    // Line start: the raster counter increments in cycle 1; it wraps to 0 in cycle 2 of line 0.
    // VICE samples DEN once more in cycle 1, before the raster counter moves on, so a $D011
    // write in the last cycle of line $30 still counts.
    if (c === 1 && this.raster === 0x30 && (regs[0x11]! & 0x10) !== 0) this.denSeen = true;
    if (c === 1) {
      this.baStart = -1;
      if (this.raster === LINES - 1) {
        this.lineWrapPending = true;
      } else {
        this.raster++;
        this.newRaster();
      }
    } else if (c === 2 && this.lineWrapPending) {
      this.lineWrapPending = false;
      this.raster = 0;
      this.vcBase = 0;
      this.frameCount++;
      this.newRaster();
    }
    if (this.raster === 0x30 && (regs[0x11]! & 0x10) !== 0) this.denSeen = true;

    // Badline condition, evaluated every cycle.
    const cond =
      this.denSeen &&
      this.raster >= 0x30 &&
      this.raster <= 0xf7 &&
      (this.raster & 7) === (regs[0x11]! & 7);
    if (cond) {
      this.displayState = true;
      if (c >= 12 && c <= LAST_C_CYCLE && this.baStart < 0) this.baStart = c;
    }
    if (c === 14) {
      this.vc = this.vcBase;
      this.vmli = 0;
      if (cond) this.rc = 0;
    }

    this.sprites.cycle(c, this.raster);
    this.graphics(c);
    const visible = c >= FIRST_VISIBLE_CYCLE && c <= LAST_VISIBLE_CYCLE;
    if (visible || this.sprites.busy) this.outputCycle(c, visible);

    if (c === 58) {
      if (this.rc === 7) {
        this.displayState = cond;
        this.vcBase = this.vc;
      }
      if (this.displayState) this.rc = (this.rc + 1) & 7;
    }

    if (c === 63) {
      const rsel = (regs[0x11]! & 0x08) !== 0;
      const bottom = rsel ? 251 : 247;
      const top = rsel ? 51 : 55;
      if (this.raster === bottom) this.verticalBorder = true;
      else if (this.raster === top && (regs[0x11]! & 0x10) !== 0) this.verticalBorder = false;
    }

    // BA for this cycle: the CPU consults it before its access.
    let ba = this.baStart >= 0 && c <= LAST_C_CYCLE;
    if (!ba && SPRITE_BA[c] !== 0) ba = (SPRITE_BA[c]! & this.sprites.dmaMask()) !== 0;
    this.baLow = ba;

    this.cycle = c === CYCLES_PER_LINE ? 1 : c + 1;
  }

  private newRaster(): void {
    if (this.raster === 0x30) this.denSeen = (this.regs[0x11]! & 0x10) !== 0;
    this.checkRasterCompare();
  }

  /** g-access (phi1, cycles 16-55) then c-access (phi2, cycles 15-54). */
  private graphics(c: number): void {
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
        code = this.chars[this.vmli & 63]!;
        nibble = this.colors[this.vmli & 63]!;
        let addr: number;
        if (mode & 2) {
          addr = ((regs[0x18]! & 0x08) << 10) | (this.vc << 3) | this.rc;
          if (ecm) addr &= ~0x600; // ECM forces address bits 9 and 10 low (like the idle access)
        } else {
          const cb = ((regs[0x18]! >> 1) & 0x07) << 11;
          addr = cb + ((ecm ? code & 0x3f : code) << 3) + this.rc;
        }
        glyph = this.mem.readMem(addr);
        this.vc = (this.vc + 1) & 0x3ff;
        this.vmli = (this.vmli + 1) & 63;
      } else {
        glyph = this.mem.readMem(ecm ? 0x39ff : 0x3fff);
      }
      renderGraphics(this.gColor, this.gFg, mode, glyph, code, nibble, bg);
    } else {
      this.gColor.fill(bg[0]);
      this.gFg.fill(0);
    }

    if (this.baStart >= 0 && c >= Math.max(FIRST_C_CYCLE, this.baStart + 3) && c <= LAST_C_CYCLE) {
      const vm = ((regs[0x18]! >> 4) & 0x0f) << 10;
      this.chars[this.vmli & 63] = this.mem.readMem(vm + this.vc);
      this.colors[this.vmli & 63] = this.mem.readColor(this.vc & 0x3ff) & 0x0f;
    }
  }

  private checkRasterCompare(): void {
    const compare = ((this.regs[0x11]! & 0x80) << 1) | this.regs[0x12]!;
    const match = this.raster === compare;
    if (match && !this.matched) this.status |= 0x01;
    this.matched = match;
  }

  private outputCycle(c: number, visible: boolean): void {
    const regs = this.regs;

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

    const csel = (regs[0x16]! & 0x08) !== 0;
    const rsel = (regs[0x11]! & 0x08) !== 0;
    const den = (regs[0x11]! & 0x10) !== 0;
    const left = csel ? 24 : 31;
    const right = csel ? 344 : 335;
    const top = rsel ? 51 : 55;
    const bottom = rsel ? 251 : 247;
    const border = regs[0x20]! & 0x0f;
    const writeFrame =
      visible && this.raster >= FIRST_VISIBLE_RASTER && this.raster <= LAST_VISIBLE_RASTER;
    const rowBase = (this.raster - FIRST_VISIBLE_RASTER) * FRAME_WIDTH;
    const fx0 = (c - FIRST_VISIBLE_CYCLE) * 8;
    const x0 = ((((c - FIRST_VISIBLE_CYCLE) * 8 + 496) % 504) + 504) % 504;
    const spritesOn = this.sprites.busy;

    for (let i = 0; i < 8; i++) {
      const x = (x0 + i) % 504;
      if (visible) {
        // Bauer 3.9: the border flip-flops are driven by the X and Y comparisons.
        if (x === right) this.mainBorder = true;
        if (x === left) {
          if (this.raster === bottom) this.verticalBorder = true;
          else if (this.raster === top && den) this.verticalBorder = false;
          if (!this.verticalBorder) this.mainBorder = false;
        }
      }
      let colour = this.shiftedColor[i]!;
      const fg = this.shiftedFg[i]!;
      if (spritesOn) {
        this.sprites.sample(x);
        const mask = this.sprites.mask;
        if (mask !== 0) {
          if ((mask & (mask - 1)) !== 0) this.hitSprites(mask);
          if (fg) this.hitBackground(mask);
          const n = 31 - Math.clz32(mask & -mask); // lowest-numbered sprite wins
          if (!((regs[0x1b]! >> n) & 1 && fg)) colour = this.sprites.colors[n]!;
        }
      }
      if (writeFrame) {
        this.frame[rowBase + fx0 + i] = PALETTE[this.mainBorder ? border : colour]!;
      }
    }
  }

  private hitSprites(bits: number): void {
    const before = this.spriteSpriteHits;
    this.spriteSpriteHits |= bits;
    if (before === 0) this.status |= 0x04;
  }

  private hitBackground(bits: number): void {
    const before = this.spriteBgHits;
    this.spriteBgHits |= bits;
    if (before === 0) this.status |= 0x02;
  }
}
