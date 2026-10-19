import { SPRITE_P_CYCLE } from './vic-schedule';

export interface SpriteMemory {
  readMem(addr14: number): number;
}

const FETCH_AT = new Int8Array(64).fill(-1);
SPRITE_P_CYCLE.forEach((cycle, n) => {
  FETCH_AT[cycle] = n;
});

/** Eight sprite units: DMA bookkeeping (Bauer 3.8), fetch and per-pixel shifters. */
export class VicSprites {
  readonly dma = new Uint8Array(8);
  readonly display = new Uint8Array(8);
  readonly mcBase = new Uint8Array(8);
  readonly mc = new Uint8Array(8);
  private readonly expandFF = new Uint8Array(8).fill(1);
  private readonly data = new Int32Array(8);
  /** VICE draw state (vicii-draw-cycle.c): shift registers, pixel registers and flip-flops. */
  private readonly sbufReg = new Int32Array(8);
  private readonly pixelReg = new Uint8Array(8);
  private readonly xPipe = new Int16Array(8);
  private expxFlops = 0;
  private mcFlops = 0;
  private priBits = 0;
  private mcBits = 0;
  private expxBits = 0;
  private pending = 0;
  private activeBits = 0;
  private haltBits = 0;
  /** Per pixel of the last `drawCycle()`: sprite mask, lowest sprite, its pixel (1..3), priority. */
  readonly outMask = new Uint8Array(8);
  readonly outLow = new Uint8Array(8);
  readonly outPix = new Uint8Array(8);
  readonly outPri = new Uint8Array(8);
  /** Bitmask of sprites whose display flag is on. */
  active = 0;
  /** Cycle whose events ran last; a $D017 write lands after it. */
  private lastCycle = 0;
  /** Sprites whose expansion flip-flop was set by a $D017 write between cycles 15 and 16. */
  private readonly crunched = new Uint8Array(8);

  /** True while any sprite is displayed, pending or still shifting out a started row. */
  get busy(): boolean {
    return (this.active | this.pending | this.activeBits) !== 0;
  }

  constructor(
    private readonly regs: Uint8Array,
    private readonly mem: SpriteMemory,
  ) {}

  reset(): void {
    this.dma.fill(0);
    this.display.fill(0);
    this.mcBase.fill(0);
    this.crunched.fill(0);
    this.mc.fill(0);
    this.expandFF.fill(1);
    this.data.fill(0);
    this.sbufReg.fill(0);
    this.pixelReg.fill(0);
    this.xPipe.fill(0);
    this.expxFlops = this.mcFlops = this.priBits = this.mcBits = this.expxBits = 0;
    this.pending = this.activeBits = this.haltBits = 0;
    this.active = 0;
  }

  /**
   * The expansion flip-flop is held set while Y-expand is clear, evaluated every cycle in the
   * hardware; applying it when $D017 is written is equivalent and costs nothing per cycle.
   */
  yExpandWritten(value: number): void {
    for (let n = 0; n < 8; n++) {
      if (((value >> n) & 1) !== 0) continue;
      if (this.lastCycle === 15 && this.dma[n] && !this.expandFF[n]) this.crunched[n] = 1;
      this.expandFF[n] = 1;
    }
  }

  /** Bit n set = sprite n's DMA is on. */
  dmaMask(): number {
    let m = 0;
    for (let n = 0; n < 8; n++) if (this.dma[n]) m |= 1 << n;
    return m;
  }

  /** DMA bookkeeping and fetch events for cycle `c` of line `raster`. */
  cycle(c: number, raster: number): void {
    const regs = this.regs;
    this.lastCycle = c;
    switch (c) {
      case 15:
        for (let n = 0; n < 8; n++)
          if (this.dma[n] && this.expandFF[n]) this.mcBase[n] = (this.mcBase[n]! + 2) & 0x3f;
        break;
      case 16:
        for (let n = 0; n < 8; n++) {
          if (this.crunched[n]) {
            // Sprite crunch (VICE): the flip-flop was set after the +2 step, so MCBASE takes a
            // bit-wise mix of MCBASE and MC instead of the plain +1.
            const base = this.mcBase[n]!;
            const mc = this.mc[n]!;
            this.mcBase[n] = (0x2a & (base & mc)) | (0x15 & (base | mc));
            this.crunched[n] = 0;
          } else if (this.dma[n] && this.expandFF[n]) {
            this.mcBase[n] = (this.mcBase[n]! + 1) & 0x3f;
          }
          if (this.mcBase[n] === 63) this.dma[n] = 0;
        }
        break;
      case 55:
        this.dmaCheck(raster);
        break;
      case 56:
        this.dmaCheck(raster);
        // VICE checks the expansion flip-flop here, after the second DMA check, and only for
        // sprites whose DMA is on (Bauer places it in cycle 55).
        for (let n = 0; n < 8; n++) {
          if (this.dma[n] && (regs[0x17]! >> n) & 1) this.expandFF[n]! ^= 1;
        }
        break;
      case 58:
        for (let n = 0; n < 8; n++) {
          this.mc[n] = this.mcBase[n]!;
          if (!this.dma[n]) this.display[n] = 0;
          // VICE (check_sprite_display) also needs the sprite still enabled here: a sprite whose
          // DMA started in cycle 55/56 but is disabled by cycle 58 is not displayed.
          else if ((regs[0x15]! >> n) & 1 && regs[1 + 2 * n] === (raster & 0xff))
            this.display[n] = 1;
        }
        this.updateActive();
        break;
    }
    const n = FETCH_AT[c]!;
    if (n >= 0) this.fetch(n);
  }

  /**
   * Draws the 8 pixels of screen cycle `c` whose first raster X is `x0` (VICE draw_sprites8). The
   * events of the cycle sit at fixed pixels: the display flags are copied at pixel 4 of cycle 58, a
   * sprite's shifter is loaded at pixel 4, cut at pixel 2 and halted from pixel 3 of its pointer
   * cycle to pixel 7 of its DMA cycle; priority and X-expand are latched at pixel 6, the
   * multicolour flags at pixel 7, and the X positions at the end of the cycle.
   */
  drawCycle(c: number, x0: number): void {
    const regs = this.regs;
    let dma0 = 0;
    let dma2 = 0;
    for (let n = 0; n < 8; n++) {
      const p = SPRITE_P_CYCLE[n]!;
      if (p === c) dma0 = 1 << n;
      if ((p % 63) + 1 === c) dma2 = 1 << n;
    }
    let candidates = 0;
    for (let n = 0; n < 8; n++) {
      if ((x0 & 0x1f8) === (this.xPipe[n]! & 0x1f8)) candidates |= 1 << n;
    }
    for (let i = 0; i < 8; i++) {
      if (i === 2) this.activeBits &= ~dma2;
      else if (i === 3) this.haltBits |= dma0;
      else if (i === 4) {
        if (c === 58) this.pending = this.active;
        if (dma2) {
          for (let n = 0; n < 8; n++) if ((dma2 >> n) & 1) this.sbufReg[n] = this.data[n]!;
        }
      } else if (i === 6) {
        this.priBits = regs[0x1b]!;
        this.expxBits = regs[0x1d]!;
      } else if (i === 7) {
        const next = regs[0x1c]!;
        this.mcFlops &= ~(next ^ this.mcBits);
        this.mcBits = next;
        this.haltBits &= ~dma2;
      }
      this.trigger((x0 + i) % 504, candidates);
      this.drawPixel(i);
    }
    for (let n = 0; n < 8; n++) this.xPipe[n] = regs[2 * n]! | (((regs[0x10]! >> n) & 1) << 8);
  }

  private trigger(x: number, candidates: number): void {
    if (candidates === 0 || this.pending === 0) return;
    for (let n = 0; n < 8; n++) {
      const m = 1 << n;
      if (
        candidates & m &&
        this.pending & m &&
        !(this.activeBits & m) &&
        !(this.haltBits & m) &&
        x === this.xPipe[n]
      ) {
        this.expxFlops |= m;
        this.mcFlops |= m;
        this.activeBits |= m;
      }
    }
  }

  private drawPixel(i: number): void {
    let mask = 0;
    let low = -1;
    if (this.activeBits !== 0) {
      for (let n = 7; n >= 0; n--) {
        const m = 1 << n;
        if (!(this.activeBits & m)) continue;
        if (this.sbufReg[n] === 0 && this.pixelReg[n] === 0) {
          this.activeBits &= ~m;
          continue;
        }
        if (!(this.haltBits & m)) {
          if (this.expxFlops & m) {
            if (this.mcBits & m) {
              if (this.mcFlops & m) this.pixelReg[n] = (this.sbufReg[n]! >> 22) & 3;
              this.mcFlops ^= m;
            } else {
              this.pixelReg[n] = ((this.sbufReg[n]! >> 23) & 1) << 1;
            }
          }
          if (this.expxFlops & m) this.sbufReg[n] = this.sbufReg[n]! << 1;
          if (this.expxBits & m) this.expxFlops ^= m;
          else this.expxFlops |= m;
        }
        if (this.pixelReg[n] !== 0) {
          low = n;
          mask |= m;
        }
      }
    }
    this.outMask[i] = mask;
    if (low >= 0) {
      this.outLow[i] = low;
      this.outPix[i] = this.pixelReg[low]!;
      this.outPri[i] = (this.priBits >> low) & 1;
    }
  }

  private dmaCheck(raster: number): void {
    const regs = this.regs;
    for (let n = 0; n < 8; n++) {
      if (
        ((regs[0x15]! >> n) & 1) !== 0 &&
        this.dma[n] === 0 &&
        regs[1 + 2 * n] === (raster & 0xff)
      ) {
        this.dma[n] = 1;
        this.mcBase[n] = 0;
        this.expandFF[n] = 1;
      }
    }
  }

  private fetch(n: number): void {
    const vm = ((this.regs[0x18]! >> 4) & 0x0f) << 10;
    const pointer = this.mem.readMem(vm + 0x3f8 + n);
    if (!this.dma[n]) return;
    const base = pointer * 64 + this.mc[n]!;
    this.data[n] =
      (this.mem.readMem(base) << 16) |
      (this.mem.readMem(base + 1) << 8) |
      this.mem.readMem(base + 2);
    this.mc[n]! += 3;
  }

  private updateActive(): void {
    let a = 0;
    for (let n = 0; n < 8; n++) if (this.display[n]) a |= 1 << n;
    this.active = a;
  }
}
