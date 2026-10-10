import { SPRITE_P_CYCLE } from './vic-schedule';

export interface SpriteMemory {
  readMem(addr14: number): number;
}

const FETCH_AT = new Int8Array(64).fill(-1);
SPRITE_P_CYCLE.forEach((cycle, n) => {
  FETCH_AT[cycle] = n;
});

/** Eight sprite units: DMA bookkeeping (Bauer 3.8), fetch and per-pixel shifters. */
export class Sprites {
  readonly dma = new Uint8Array(8);
  readonly display = new Uint8Array(8);
  readonly mcBase = new Uint8Array(8);
  readonly mc = new Uint8Array(8);
  private readonly expandFF = new Uint8Array(8).fill(1);
  private readonly data = new Int32Array(8);
  private readonly shiftData = new Int32Array(8);
  /** Source pixel (0..23) each running shifter outputs next, or -1 when idle. */
  private readonly pos = new Int16Array(8).fill(-1);
  /** X-expansion flip-flop: set while a shifter holds its source pixel for a second pixel. */
  private readonly hold = new Uint8Array(8);
  /** Bitmask of sprites whose display flag is on. */
  active = 0;
  private running = 0;

  /** True while any sprite is displayed or still shifting out a started row. */
  get busy(): boolean {
    return (this.active | this.running) !== 0;
  }
  /** Output of the last `sample()`: bit n set = sprite n has an opaque pixel here. */
  mask = 0;
  readonly colors = new Uint8Array(8);

  constructor(
    private readonly regs: Uint8Array,
    private readonly mem: SpriteMemory,
  ) {}

  reset(): void {
    this.dma.fill(0);
    this.display.fill(0);
    this.mcBase.fill(0);
    this.running = 0;
    this.mc.fill(0);
    this.expandFF.fill(1);
    this.data.fill(0);
    this.shiftData.fill(0);
    this.pos.fill(-1);
    this.hold.fill(0);
    this.active = 0;
    this.mask = 0;
  }

  /**
   * The expansion flip-flop is held set while Y-expand is clear, evaluated every cycle in the
   * hardware; applying it when $D017 is written is equivalent and costs nothing per cycle.
   */
  yExpandWritten(value: number): void {
    for (let n = 0; n < 8; n++) if (((value >> n) & 1) === 0) this.expandFF[n] = 1;
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
    switch (c) {
      case 15:
        for (let n = 0; n < 8; n++)
          if (this.dma[n] && this.expandFF[n]) this.mcBase[n] = (this.mcBase[n]! + 2) & 0x3f;
        break;
      case 16:
        for (let n = 0; n < 8; n++) {
          if (this.dma[n] && this.expandFF[n]) this.mcBase[n] = (this.mcBase[n]! + 1) & 0x3f;
          if (this.mcBase[n] === 63) this.dma[n] = 0;
        }
        break;
      case 55:
        for (let n = 0; n < 8; n++) {
          if ((regs[0x17]! >> n) & 1) this.expandFF[n]! ^= 1;
        }
        this.dmaCheck(raster);
        break;
      case 56:
        this.dmaCheck(raster);
        break;
      case 58:
        for (let n = 0; n < 8; n++) {
          this.mc[n] = this.mcBase[n]!;
          if (!this.dma[n]) this.display[n] = 0;
          else if (regs[1 + 2 * n] === (raster & 0xff)) this.display[n] = 1;
        }
        this.updateActive();
        break;
    }
    const n = FETCH_AT[c]!;
    if (n >= 0) this.fetch(n);
  }

  /** Advances every active shifter by one pixel at raster X `x`. */
  sample(x: number): void {
    const regs = this.regs;
    let mask = 0;
    for (let n = 0; n < 8; n++) {
      const displayed = ((this.active >> n) & 1) !== 0;
      let src = this.pos[n]!;
      if (src < 0) {
        if (!displayed) continue;
        const sx = regs[2 * n]! | (((regs[0x10]! >> n) & 1) << 8);
        if (x !== sx) continue;
        src = 0;
        this.hold[n] = 0;
        this.shiftData[n] = this.data[n]!;
      }
      const word = this.shiftData[n]!;
      let colour = -1;
      if ((regs[0x1c]! >> n) & 1) {
        const pair = (word >> (22 - (src & ~1))) & 3;
        if (pair === 1) colour = regs[0x25]! & 0x0f;
        else if (pair === 2) colour = regs[0x27 + n]! & 0x0f;
        else if (pair === 3) colour = regs[0x26]! & 0x0f;
      } else if ((word >> (23 - src)) & 1) {
        colour = regs[0x27 + n]! & 0x0f;
      }
      if (colour >= 0) {
        mask |= 1 << n;
        this.colors[n] = colour;
      }
      // The shifter advances every pixel; with X-expand set every second pixel (flip-flop).
      if ((regs[0x1d]! >> n) & 1 && !this.hold[n]) {
        this.hold[n] = 1;
      } else {
        this.hold[n] = 0;
        src++;
      }
      this.pos[n] = src >= 24 ? -1 : src;
    }
    let running = 0;
    for (let n = 0; n < 8; n++) if (this.pos[n]! >= 0) running |= 1 << n;
    this.running = running;
    this.mask = mask;
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
        if ((regs[0x17]! >> n) & 1) this.expandFF[n] = 0;
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
