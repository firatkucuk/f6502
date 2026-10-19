/**
 * The VIC-II graphics sequencer: a port of VICE's draw_graphics8 for the 6569R3. Each call draws
 * the 8 pixels of one cycle from a shift register that is loaded `xscroll` pixels into the cycle;
 * the video mode bits are sampled at fixed pixels (MCM and the rising edges of ECM/BMM at pixel 4,
 * the falling edges at pixel 6, the multicolour pixel pairing from pixel 7 of the cycle before).
 * Colours are codes: 0-15 literal, 0x21-0x24 the background registers.
 */

const COL_NONE = 0x10;
const COL_VBUF_L = 0x11;
const COL_VBUF_H = 0x12;
const COL_CBUF = 0x13;
const COL_CBUF_MC = 0x14;
const COL_D02X_EXT = 0x15;
const D021 = 0x21;
const D022 = 0x22;
const D023 = 0x23;

/** Indexed by ECM(0x10) | BMM(0x08) | MCM(0x04) | pixel value. */
const COLORS = Uint8Array.from([
  D021,
  D021,
  COL_CBUF,
  COL_CBUF, // ECM=0 BMM=0 MCM=0
  D021,
  D022,
  D023,
  COL_CBUF_MC, // ECM=0 BMM=0 MCM=1
  COL_VBUF_L,
  COL_VBUF_L,
  COL_VBUF_H,
  COL_VBUF_H, // ECM=0 BMM=1 MCM=0
  D021,
  COL_VBUF_H,
  COL_VBUF_L,
  COL_CBUF, // ECM=0 BMM=1 MCM=1
  COL_D02X_EXT,
  COL_D02X_EXT,
  COL_CBUF,
  COL_CBUF, // ECM=1 BMM=0 MCM=0
  COL_NONE,
  COL_NONE,
  COL_NONE,
  COL_NONE, // ECM=1 BMM=0 MCM=1
  COL_NONE,
  COL_NONE,
  COL_NONE,
  COL_NONE, // ECM=1 BMM=1 MCM=0
  COL_NONE,
  COL_NONE,
  COL_NONE,
  COL_NONE, // ECM=1 BMM=1 MCM=1
]);

export class GraphicsPipe {
  /** Output of the last `drawCycle()`: colour codes and foreground flags (pixel value bit 1). */
  readonly color = new Uint8Array(8);
  readonly fg = new Uint8Array(8);

  private gbufPipe0 = 0;
  private cbufPipe0 = 0;
  private vbufPipe0 = 0;
  private gbufPipe1 = 0;
  private cbufPipe1 = 0;
  private vbufPipe1 = 0;
  private xscrollPipe = 0;
  private vmode11Pipe = 0;
  private vmode16Pipe = 0;
  private vmode16Pipe2 = 0;
  private gbufReg = 0;
  private gbufMcFlop = 0;
  private gbufPixelReg = 0;
  private cbufReg = 0;
  private vbufReg = 0;
  private dmli = 0;

  reset(): void {
    this.gbufPipe0 = this.cbufPipe0 = this.vbufPipe0 = 0;
    this.gbufPipe1 = this.cbufPipe1 = this.vbufPipe1 = 0;
    this.xscrollPipe = this.vmode11Pipe = this.vmode16Pipe = this.vmode16Pipe2 = 0;
    this.gbufReg = this.gbufMcFlop = this.gbufPixelReg = 0;
    this.cbufReg = this.vbufReg = this.dmli = 0;
  }

  /**
   * Draws one cycle. `fetching` is true for the cycles whose g-access feeds the pipe (16-55),
   * `gbuf` is the byte fetched in this cycle, `vbuf`/`cbuf` hold the matrix and colour RAM line.
   */
  drawCycle(
    regs: Uint8Array,
    fetching: boolean,
    vborder: boolean,
    idle: boolean,
    gbuf: number,
    vbuf: Uint8Array,
    cbuf: Uint8Array,
  ): void {
    for (let i = 0; i < 8; i++) {
      if (i === 4) {
        this.vmode16Pipe = (regs[0x16]! & 0x10) >> 2;
        this.vmode11Pipe |= (regs[0x11]! & 0x60) >> 2; // rising edge of the internal signal
      } else if (i === 6) {
        this.vmode11Pipe &= (regs[0x11]! & 0x60) >> 2; // falling edge
      } else if (i === 7) {
        if (this.vmode16Pipe && !this.vmode16Pipe2) this.gbufMcFlop = 0;
        this.vmode16Pipe2 = this.vmode16Pipe;
      }
      this.pixel(i);
    }

    this.vbufPipe1 = this.vbufPipe0;
    this.cbufPipe1 = this.cbufPipe0;
    this.gbufPipe1 = this.gbufPipe0;
    // gbuf is 0 outside the display area
    if (fetching && !vborder) {
      this.gbufPipe0 = gbuf;
      this.xscrollPipe = regs[0x16]! & 7;
    } else {
      this.gbufPipe0 = 0;
    }
    if (fetching && !vborder) {
      if (!idle) {
        this.vbufPipe0 = vbuf[this.dmli & 63]!;
        this.cbufPipe0 = cbuf[this.dmli & 63]!;
        this.dmli++;
      } else {
        this.vbufPipe0 = 0;
        this.cbufPipe0 = 0;
      }
    } else {
      this.dmli = 0;
    }
  }

  private pixel(i: number): void {
    if (i === this.xscrollPipe) {
      this.vbufReg = this.vbufPipe1;
      this.cbufReg = this.cbufPipe1;
      this.gbufReg = this.gbufPipe1;
      this.gbufMcFlop = 1;
    }
    const mcChar = (this.vmode11Pipe & 0x08) !== 0 || (this.cbufReg & 0x08) !== 0;
    if (this.vmode16Pipe2) {
      if (mcChar) {
        if (this.gbufMcFlop) this.gbufPixelReg = this.gbufReg >> 6;
      } else {
        this.gbufPixelReg = this.gbufReg & 0x80 ? 3 : 0;
      }
    } else if (mcChar) {
      // MCM was clear a cycle ago: multicolour characters still draw hires pixels
      this.gbufPixelReg = this.gbufReg & 0x80 ? 2 : 0;
    } else {
      this.gbufPixelReg = this.gbufReg & 0x80 ? 3 : 0;
    }
    const px = this.gbufPixelReg;
    this.gbufReg = (this.gbufReg << 1) & 0xff;
    this.gbufMcFlop ^= 1;

    let cc = COLORS[this.vmode11Pipe | this.vmode16Pipe | px]!;
    switch (cc) {
      case COL_NONE:
        cc = 0;
        break;
      case COL_VBUF_L:
        cc = this.vbufReg & 0x0f;
        break;
      case COL_VBUF_H:
        cc = this.vbufReg >> 4;
        break;
      case COL_CBUF:
        cc = this.cbufReg;
        break;
      case COL_CBUF_MC:
        cc = this.cbufReg & 0x07;
        break;
      case COL_D02X_EXT:
        cc = D021 + (this.vbufReg >> 6);
        break;
      default:
        break;
    }
    this.color[i] = cc;
    this.fg[i] = px & 2;
  }
}
