/** The 6510's on-chip I/O port at $00 (DDR) and $01 (data). */
export class CpuPort {
  ddr = 0x00;
  data = 0x3f;

  constructor(private readonly onBankingChange: () => void) {}

  /** Effective LORAM/HIRAM/CHAREN: input bits are pulled up. */
  get bankBits(): number {
    return (this.data | ~this.ddr) & 0x07;
  }

  /** Output bits from the data register, input bits from the pins (bit 4 sense = 1, bits 6-7 = 0). */
  readData(): number {
    const pins = 0x3f;
    return ((this.data & this.ddr) | (pins & ~this.ddr)) & 0xff;
  }

  write(addr: 0 | 1, value: number): void {
    if (addr === 0) this.ddr = value & 0xff;
    else this.data = value & 0xff;
    this.onBankingChange();
  }

  reset(): void {
    this.ddr = 0x00;
    this.data = 0x3f;
    this.onBankingChange();
  }
}
