/** The 6510's on-chip I/O port at $00 (DDR) and $01 (data). */
export class CpuPort {
  ddr = 0x00;
  data = 0x3f;

  /** True while the cassette PLAY key is down (the sense line reads low). */
  senseLow: () => boolean = () => false;

  constructor(private readonly onBankingChange: () => void) {}

  /** The cassette motor runs when bit 5 is an output driven low. */
  get motorOn(): boolean {
    return ((this.data | ~this.ddr) & 0x20) === 0;
  }

  /** Effective LORAM/HIRAM/CHAREN: input bits are pulled up. */
  get bankBits(): number {
    return (this.data | ~this.ddr) & 0x07;
  }

  /** Output bits from the data register, input bits from the pins (bit 4 sense = 1, bits 6-7 = 0). */
  readData(): number {
    const pins = 0x3f & ~(this.senseLow() ? 0x10 : 0);
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
