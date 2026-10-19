import type { IoChip } from './io';
import { PALETTE } from './palette';
import { GraphicsPipe } from './vic-graphics';
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
/**
 * The VIC's draw pipeline: pixels of a screen cycle are composed PIXEL_DELAY cycles after it and
 * its sprite pixels generated SPRITE_DELAY cycles after it, so register writes, border compares and
 * sprite positions see the registers of those later cycles.
 */
const PIXEL_DELAY = 2;
const SPRITE_DELAY = 2;
const FIRST_C_CYCLE = 15;
const LAST_C_CYCLE = 54;
const FIRST_VISIBLE_RASTER = 15;
const LAST_VISIBLE_RASTER = 286;

export interface VicMemory {
  readMem(addr14: number): number;
  /** True if a VIC fetch at `addr14` sees the character ROM instead of RAM. */
  isCharRom?(addr14: number): boolean;
  readColor(index: number): number;
  /** The byte on the data bus when the VIC cannot fetch (VICE: RAM at the CPU's PC). */
  floatingBus?(): number;
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
  /** Badline condition as evaluated in the current cycle. */
  private badLine = false;
  /** Light pen input level (true = low = pen active), a pending latch and the latched position. */
  private lpLow = false;
  private lpPending = false;
  private lpTriggered = false;
  private lpX = 0;
  private lpY = 0;
  /**
   * VICE prefetch_cycles: counts down while BA is low and is 4 while it is high. A matrix fetch
   * with it still above 0 (BA low for fewer than 3 cycles, as in FLI) reads the floating bus.
   */
  private prefetchCycles = 4;
  private mainBorder = true;
  private verticalBorder = true;
  /** Latched vertical border state (VICE set_vborder); the live flag follows it at cycle 1. */
  private setVerticalBorder = true;
  private readonly regs = new Uint8Array(0x40);
  private status = 0;
  private enable = 0;
  private matched = false;
  /** The border state the pixels of the cycle before were drawn with (VICE border_state). */
  private borderState = false;
  /** $D011 as it was a cycle ago (VICE reg11_delay). */
  private reg11Delay = 0;
  private readonly borderPixels = new Uint8Array(8);
  private displayState = false;
  private vcBase = 0;
  private vc = 0;
  private rc = 0;
  private vmli = 0;
  private readonly chars = new Uint8Array(64);
  private readonly colors = new Uint8Array(64);
  /** Colour registers as they were when the previous cycle began. */
  private readonly prevCregs = new Uint8Array(0x30);
  private readonly cregsNow = new Uint8Array(0x30);
  private readonly gfx = new GraphicsPipe();
  /** The byte of this cycle's g-access (feeds the graphics pipe). */
  private gbuf = 0;
  private readonly shiftedColor = new Uint8Array(8);
  /** Graphics pixels per cycle (indexed by cycle & 63) waiting for the draw stage. */
  private readonly pipeColor = new Uint8Array(64 * 8);
  private readonly pipeFg = new Uint8Array(64 * 8);
  /** Sprite pixels per cycle: bit mask of opaque sprites, lowest sprite, its colour register. */
  private readonly spMask = new Uint8Array(64 * 8);
  private readonly spLow = new Uint8Array(64 * 8);
  private readonly spReg = new Uint8Array(64 * 8);
  private readonly spPri = new Uint8Array(64 * 8);
  /** Whether the sprite stage produced any pixel data for a cycle (indexed by cycle & 63). */
  private readonly spriteActive = new Uint8Array(64);
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
    this.badLine = false;
    this.prefetchCycles = 4;
    this.lpLow = this.lpPending = this.lpTriggered = false;
    this.lpX = this.lpY = 0;
    this.lastBusPhi2 = 0xff;
    this.mainBorder = true;
    this.borderState = true;
    this.verticalBorder = true;
    this.setVerticalBorder = true;
    this.baLow = false;
    this.irqBefore = false;
    this.lineWrapPending = false;
    this.vcBase = this.vc = this.rc = this.vmli = 0;
    this.raster = 0;
    this.cycle = 2;
    this.chars.fill(0);
    this.colors.fill(0);
    this.gfx.reset();
    this.gbuf = 0;
    this.spriteSpriteHits = 0;
    this.spriteBgHits = 0;
    this.sprites.reset();
    // Raster 0 matches compare 0 at power-on; that is the initial state, not an edge.
    this.matched = true;
  }

  // ---- registers --------------------------------------------------------

  /**
   * The byte on the VIC's data bus during the CPU half of the current cycle (VICE last_bus_phi2):
   * $FF unless the CPU reads or writes a VIC register, in which case it is that value. A sprite
   * data access that cannot fetch (DMA off, or the BA prefetch window still open) takes it.
   */
  private lastBusPhi2 = 0xff;

  read(reg: number): number {
    reg &= 0x3f;
    let v: number;
    if (reg === 0x1e) {
      v = this.spriteSpriteHits;
      this.spriteSpriteHits = 0;
    } else if (reg === 0x1f) {
      v = this.spriteBgHits;
      this.spriteBgHits = 0;
    } else {
      v = this.peek(reg);
    }
    this.lastBusPhi2 = v;
    return v;
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
      case 0x13:
        return this.lpX;
      case 0x14:
        return this.lpY;
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
    this.lastBusPhi2 = value;
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
        // The compare is evaluated once per cycle in tick(), not at the write (VICE only stores
        // the new compare line), so a write in the last cycle of a line cannot clear the latch.
        this.regs[reg] = value;
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
    this.prevCregs.set(this.cregsNow);
    this.cregsNow.set(this.regs.subarray(0, 0x30));
    this.irqBefore = (this.status & this.enable & 0x0f) !== 0;
    const c = this.cycle;
    const regs = this.regs;

    // Line start: the raster counter increments in cycle 1; it wraps to 0 in cycle 2 of line 0.
    // VICE samples DEN once more in cycle 1, before the raster counter moves on, so a $D011
    // write in the last cycle of line $30 still counts.
    if (c === 1 && this.raster === 0x30 && (regs[0x11]! & 0x10) !== 0) this.denSeen = true;
    if (c === 1) {
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
      // A pen still held low is latched again at the start of the frame (position $D1).
      this.lpTriggered = false;
      if (this.lpLow) this.triggerLightPen(2, true);
    }
    if (this.raster === 0x30 && (regs[0x11]! & 0x10) !== 0) this.denSeen = true;

    // Badline condition, evaluated every cycle.
    const cond =
      this.denSeen &&
      this.raster >= 0x30 &&
      this.raster <= 0xf7 &&
      (this.raster & 7) === (regs[0x11]! & 7);
    this.badLine = cond;
    if (c === 14) {
      this.vc = this.vcBase;
      this.vmli = 0;
      if (cond) this.rc = 0;
    }

    // The phi2 sprite accesses (bytes 0 and 2, in this cycle and the next) read the idle bus
    // while the prefetch window after BA went low is still open (VICE sprite_dma_cycle_0/2).
    const baAt = (cc: number) =>
      (cond && cc >= 12 && cc <= LAST_C_CYCLE) || (SPRITE_BA[cc]! & this.sprites.dmaMask()) !== 0;
    const pf0 = baAt(c) ? Math.max(0, this.prefetchCycles - 1) : 4;
    const pf2 = baAt((c % CYCLES_PER_LINE) + 1) ? Math.max(0, pf0 - 1) : 4;
    this.sprites.prefetch0 = pf0 > 0;
    this.sprites.prefetch2 = pf2 > 0;
    // The phi2 accesses of the previous cycle see the bus as the CPU left it; VICE performs them
    // at the start of the next cycle and then clears the bus to $FF.
    this.sprites.cycle(c, this.raster, this.lastBusPhi2);
    this.lastBusPhi2 = 0xff;

    // BA for this cycle: the CPU consults it before its access. The matrix fetch holds BA only
    // while the badline condition holds (VICE re-evaluates it every cycle).
    let ba = cond && c >= 12 && c <= LAST_C_CYCLE;
    if (!ba && SPRITE_BA[c] !== 0) ba = (SPRITE_BA[c]! & this.sprites.dmaMask()) !== 0;
    this.baLow = ba;
    if (ba) {
      if (this.prefetchCycles > 0) this.prefetchCycles--;
    } else {
      this.prefetchCycles = 4;
    }

    this.graphics(c);
    this.checkHorizontalBorder(c);
    this.drawGraphics(c);
    // The condition enters display state after this cycle's g-access (phi1): VICE runs
    // check_badline later in the cycle. A badline that starts in cycle 16 or later therefore
    // leaves the g-access of that cycle idle, which does not advance VC (DMA delay).
    if (cond) this.displayState = true;
    let sa = c - SPRITE_DELAY;
    if (sa < 1) sa += CYCLES_PER_LINE;
    this.spriteStage(sa);
    let sc = c - PIXEL_DELAY;
    const sameLine = sc >= 1;
    if (!sameLine) sc += CYCLES_PER_LINE;
    const visible = sameLine && sc >= FIRST_VISIBLE_CYCLE && sc <= LAST_VISIBLE_CYCLE;
    this.drawBorder();
    if (visible || this.spriteActive[sc & 63]) this.outputCycle(sc, visible);

    if (c === 58) {
      if (this.rc === 7) {
        this.displayState = cond;
        this.vcBase = this.vc;
      }
      if (this.displayState) this.rc = (this.rc + 1) & 7;
    }

    // Vertical border compares run every cycle (VICE check_vborder_top/_bottom): DEN is sampled
    // on each cycle of the top line, so a $D011 write that clears it later in that line (or in
    // its first cycle, after the sample) still opens the border. The latched flag is applied to
    // the live one at cycle 1 and at the left compare.
    {
      const rsel = (regs[0x11]! & 0x08) !== 0;
      if (this.raster === (rsel ? 51 : 55) && (regs[0x11]! & 0x10) !== 0) {
        this.verticalBorder = false;
        this.setVerticalBorder = false;
      }
      if (this.raster === (rsel ? 251 : 247)) this.setVerticalBorder = true;
      if (c === 1) this.verticalBorder = this.setVerticalBorder;
    }

    if (this.lpPending) {
      this.lpPending = false;
      this.triggerLightPen(c, false);
    }

    this.checkRasterCompare();
    this.reg11Delay = this.regs[0x11]!;
    this.cycle = c === CYCLES_PER_LINE ? 1 : c + 1;
  }

  /** The light pen input changed (CIA1 port B bit 4): a low level latches one cycle later. */
  setLightPen(low: boolean): void {
    if (low) this.lpPending = true;
    this.lpLow = low;
  }

  /** VICE vicii_trigger_light_pen_internal for the 6569R3 (PAL). */
  private triggerLightPen(c: number, retrigger: boolean): void {
    if (this.lpTriggered) return;
    this.lpTriggered = true;
    if (this.raster === LINES - 1 && c > 1) return; // not on the last line, except cycle 1
    // Raster X of the cycle (VICE keeps it in units of 8: cycle 1 is 400, then 8 per cycle),
    // halved, plus the 6569R3's offset of 2.
    let x = ((400 + 8 * (c - 1)) % 504) / 2 + 2;
    if (retrigger) x = 0xd1;
    this.lpX = x & 0xff;
    this.lpY = this.raster & 0xff;
    this.status |= 0x08;
  }

  private newRaster(): void {
    if (this.raster === 0x30) this.denSeen = (this.regs[0x11]! & 0x10) !== 0;
    this.checkRasterCompare();
  }

  /** g-access (phi1, cycles 16-55) then c-access (phi2, cycles 15-54). */
  private graphics(c: number): void {
    const regs = this.regs;
    if (c >= FIRST_G_CYCLE && c <= LAST_G_CYCLE) {
      let glyph: number;
      if (this.displayState) {
        glyph = this.mem.readMem(this.graphicsAddress());
        this.vc = (this.vc + 1) & 0x3ff;
        this.vmli = (this.vmli + 1) & 63;
      } else {
        glyph = this.mem.readMem((regs[0x11]! & 0x40) !== 0 ? 0x39ff : 0x3fff);
      }
      this.gbuf = glyph;
    }

    if (this.badLine && c >= FIRST_C_CYCLE && c <= LAST_C_CYCLE) {
      if (this.prefetchCycles > 0) {
        // BA has been low for fewer than 3 cycles: no bus access, the VIC sees the floating bus.
        this.chars[this.vmli & 63] = 0xff;
        this.colors[this.vmli & 63] = (this.mem.floatingBus?.() ?? 0xff) & 0x0f;
      } else {
        const vm = ((regs[0x18]! >> 4) & 0x0f) << 10;
        this.chars[this.vmli & 63] = this.mem.readMem(vm + this.vc);
        this.colors[this.vmli & 63] = this.mem.readColor(this.vc & 0x3ff) & 0x0f;
      }
    }
  }

  /** VICE g_fetch_addr: the address of a g-access for the video mode bits in `d011`. */
  private graphicsAddressFor(d011: number): number {
    const regs = this.regs;
    let a: number;
    if (d011 & 0x20) a = (this.vc << 3) | this.rc | ((regs[0x18]! & 0x08) << 10);
    else a = (this.chars[this.vmli & 63]! << 3) | this.rc | ((regs[0x18]! & 0x0e) << 10);
    if (d011 & 0x40) a &= 0x39ff;
    return a;
  }

  /**
   * VICE vicii_fetch_graphics for the 6569R3: BMM takes effect for the fetch address one cycle
   * early (current OR delayed), and changing from RAM to character ROM fetches latches the low
   * address byte with the previous mode and the high bits with the new one.
   */
  private graphicsAddress(): number {
    const d011 = this.regs[0x11]!;
    let addr = this.graphicsAddressFor(d011 | (this.reg11Delay & 0x20));
    if ((d011 ^ this.reg11Delay) & 0x20) {
      const from = this.graphicsAddressFor(this.reg11Delay);
      const to = this.graphicsAddressFor(d011);
      const isRom = this.mem.isCharRom;
      if (isRom !== undefined && !isRom(from) && isRom(to)) addr = (from & 0xff) | (to & 0x3f00);
    }
    return addr;
  }

  private checkRasterCompare(): void {
    const compare = ((this.regs[0x11]! & 0x80) << 1) | this.regs[0x12]!;
    const match = this.raster === compare;
    if (match && !this.matched) this.status |= 0x01;
    this.matched = match;
  }

  /**
   * Draws the graphics pixels of screen cycle `c - PIXEL_DELAY` into the ring (VICE draws a cycle's
   * pixels in a later cycle, after that cycle's g-access has fed the pipe).
   */
  private drawGraphics(c: number): void {
    let sc = c - PIXEL_DELAY;
    if (sc < 1) sc += CYCLES_PER_LINE;
    this.gfx.drawCycle(
      this.regs,
      c >= FIRST_G_CYCLE && c <= LAST_G_CYCLE,
      this.verticalBorder,
      !this.displayState,
      this.gbuf,
      this.chars,
      this.colors,
    );
    const base = (sc & 63) * 8;
    this.pipeColor.set(this.gfx.color, base);
    this.pipeFg.set(this.gfx.fg, base);
  }

  /** Generates the sprite pixels of screen cycle `c` into the ring (SPRITE_DELAY after it). */
  private spriteStage(c: number): void {
    const base = (c & 63) * 8;
    const x0 = ((((c - FIRST_VISIBLE_CYCLE) * 8 + 496) % 504) + 504) % 504;
    const sp = this.sprites;
    sp.drawCycle((c % CYCLES_PER_LINE) + 1, x0);
    let any = 0;
    for (let i = 0; i < 8; i++) {
      const mask = sp.outMask[i]!;
      this.spMask[base + i] = mask;
      any |= mask;
      if (mask !== 0) {
        const n = sp.outLow[i]!;
        const pix = sp.outPix[i]!;
        this.spLow[base + i] = n;
        this.spReg[base + i] = pix === 1 ? 0x25 : pix === 3 ? 0x26 : 0x27 + n;
        this.spPri[base + i] = sp.outPri[i]!;
      }
    }
    this.spriteActive[c & 63] = any !== 0 ? 1 : 0;
  }

  /**
   * VICE check_hborder: the left border ends in cycle 17 (CSEL=1) or 18 (CSEL=0) and the right
   * border starts in cycle 56 (CSEL=0) or 57 (CSEL=1). The bottom compare of the vertical border
   * is repeated at the left compare, which then latches it.
   */
  private checkHorizontalBorder(c: number): void {
    const regs = this.regs;
    const csel = (regs[0x16]! & 0x08) !== 0;
    if (csel ? c === 17 : c === 18) {
      const bottom = (regs[0x11]! & 0x08) !== 0 ? 251 : 247;
      if (this.raster === bottom) this.setVerticalBorder = true;
      this.verticalBorder = this.setVerticalBorder;
      if (!this.verticalBorder) this.mainBorder = false;
    }
    if (csel ? c === 57 : c === 56) this.mainBorder = true;
  }

  /**
   * VICE draw_border8: which of the 8 pixels being composed show the border. With CSEL=1 a change
   * of the main border applies from the next group of 8, with CSEL=0 from its last pixel.
   */
  private drawBorder(): void {
    const px = this.borderPixels;
    if (!(this.borderState || this.mainBorder)) {
      px.fill(0);
      return;
    }
    if (this.borderState && this.mainBorder) {
      px.fill(1);
      return;
    }
    if ((this.regs[0x16]! & 0x08) !== 0) {
      px.fill(this.borderState ? 1 : 0);
      this.borderState = this.mainBorder;
    } else {
      px.fill(this.borderState ? 1 : 0, 0, 7);
      px[7] = 0;
      this.borderState = this.mainBorder;
      if (this.borderState) px[7] = 1;
    }
  }

  /** Composes the pixels of screen cycle `c`: graphics, sprites and border (PIXEL_DELAY after it). */
  private outputCycle(c: number, visible: boolean): void {
    const regs = this.regs;

    const base = (c & 63) * 8;
    const writeFrame =
      visible && this.raster >= FIRST_VISIBLE_RASTER && this.raster <= LAST_VISIBLE_RASTER;
    const rowBase = (this.raster - FIRST_VISIBLE_RASTER) * FRAME_WIDTH;
    const fx0 = (c - FIRST_VISIBLE_CYCLE) * 8;

    for (let i = 0; i < 8; i++) {
      // 6569: pixel 0 of a cycle still uses the colour registers of the previous cycle.
      const cregs = i === 0 ? this.prevCregs : regs;
      let colour = this.pipeColor[base + i]!;
      if (colour >= 0x20) colour = cregs[colour]! & 0x0f;
      const fg = this.pipeFg[base + i]!;
      const mask = this.spriteActive[c & 63] ? this.spMask[base + i]! : 0;
      if (mask !== 0) {
        if ((mask & (mask - 1)) !== 0) this.hitSprites(mask);
        if (fg) this.hitBackground(mask);
        const n = this.spLow[base + i]!;
        if (!(this.spPri[base + i] && fg)) colour = cregs[this.spReg[base + i]!]! & 0x0f;
      }
      if (writeFrame) {
        this.frame[rowBase + fx0 + i] =
          PALETTE[this.borderPixels[i] ? cregs[0x20]! & 0x0f : colour]!;
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
