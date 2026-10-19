import type { IoChip } from './io';

export interface CiaInputs {
  /** External pin levels for port A / B (bits that are inputs are taken from here). */
  inputA: () => number;
  inputB: () => number;
  /** Called after a write to port A/B or their direction registers (pin levels may have changed). */
  onPortWrite?: () => void;
}

const TENTH_ACC = 985_248; // PAL cycles per second; +10 per cycle gives one tenth per 98,524.8

function incBcd(v: number): number {
  return (v & 0x0f) === 9 ? (v + 7) & 0xff : v + 1;
}

export class Cia implements IoChip {
  irq = false;

  private pra = 0;
  private prb = 0;
  private ddra = 0;
  private ddrb = 0;
  private ta = 0xffff;
  private tb = 0xffff;
  private taLatch = 0xffff;
  private tbLatch = 0xffff;
  private cra = 0;
  private crb = 0;
  private taDelay = 0;
  private tbDelay = 0;
  private flags = 0;
  private pendingFlags = 0;
  private mask = 0;
  private sdr = 0;

  private tod = [0, 0, 0, 0x01]; // tenths, sec, min, hour (BCD)
  private alarm = [0, 0, 0, 0];
  private todLatch = [0, 0, 0, 0];
  private todLatched = false;
  private todRunning = true;
  private todAcc = 0;

  constructor(private readonly inputs: CiaInputs) {}

  reset(): void {
    this.pra = this.prb = this.ddra = this.ddrb = 0;
    this.ta = this.tb = this.taLatch = this.tbLatch = 0xffff;
    this.cra = this.crb = 0;
    this.taDelay = this.tbDelay = 0;
    this.flags = this.pendingFlags = this.mask = 0;
    this.irq = false;
    this.sdr = 0;
    this.tod = [0, 0, 0, 0x01];
    this.alarm = [0, 0, 0, 0];
    this.todLatched = false;
    this.todRunning = true;
    this.todAcc = 0;
  }

  /** Driven pin levels: output bits from the port register, input bits high. */
  /** A falling edge on the FLAG pin (the cassette read line on CIA1). */
  pulseFlag(): void {
    this.pendingFlags |= 0x10;
  }

  outputA(): number {
    return (this.pra | ~this.ddra) & 0xff;
  }

  outputB(): number {
    return (this.prb | ~this.ddrb) & 0xff;
  }

  tick(): void {
    if (this.pendingFlags !== 0) {
      this.flags |= this.pendingFlags;
      this.pendingFlags = 0;
      this.updateIrq();
    }

    let taUnderflow = false;
    if (this.cra & 0x01) {
      if (this.taDelay > 0) this.taDelay--;
      else if ((this.cra & 0x20) === 0) {
        if (this.ta === 0) {
          taUnderflow = true;
          this.ta = this.taLatch;
          if (this.cra & 0x08) this.cra &= ~0x01;
        } else this.ta--;
      }
    }
    if (taUnderflow) this.pendingFlags |= 0x01;

    if (this.crb & 0x01) {
      if (this.tbDelay > 0) this.tbDelay--;
      else {
        const mode = (this.crb >> 5) & 3;
        const clock = mode === 0 ? true : mode >= 2 ? taUnderflow : false;
        if (clock) {
          if (this.tb === 0) {
            this.pendingFlags |= 0x02;
            this.tb = this.tbLatch;
            if (this.crb & 0x08) this.crb &= ~0x01;
          } else this.tb--;
        }
      }
    }

    if (this.todRunning) {
      this.todAcc += 10;
      if (this.todAcc >= TENTH_ACC) {
        this.todAcc -= TENTH_ACC;
        this.todTenth();
      }
    }
  }

  read(reg: number): number {
    switch (reg & 0x0f) {
      case 0x0d: {
        const value = this.flags | (this.irq ? 0x80 : 0);
        this.flags = 0;
        this.updateIrq();
        return value;
      }
      case 0x08: {
        const value = (this.todLatched ? this.todLatch : this.tod)[0]!;
        this.todLatched = false; // reading tenths releases the hour-read latch
        return value;
      }
      case 0x0b:
        this.todLatch = [...this.tod];
        this.todLatched = true;
        return this.todLatch[3]!;
      default:
        return this.peek(reg);
    }
  }

  peek(reg: number): number {
    const tod = this.todLatched ? this.todLatch : this.tod;
    switch (reg & 0x0f) {
      case 0x00:
        return ((this.pra & this.ddra) | (this.inputs.inputA() & ~this.ddra)) & 0xff;
      case 0x01:
        return ((this.prb & this.ddrb) | (this.inputs.inputB() & ~this.ddrb)) & 0xff;
      case 0x02:
        return this.ddra;
      case 0x03:
        return this.ddrb;
      case 0x04:
        return this.ta & 0xff;
      case 0x05:
        return this.ta >> 8;
      case 0x06:
        return this.tb & 0xff;
      case 0x07:
        return this.tb >> 8;
      case 0x08:
        return tod[0]!;
      case 0x09:
        return tod[1]!;
      case 0x0a:
        return tod[2]!;
      case 0x0b:
        return tod[3]!;
      case 0x0c:
        return this.sdr;
      case 0x0d:
        return this.flags | (this.irq ? 0x80 : 0);
      case 0x0e:
        return this.cra & ~0x10;
      default:
        return this.crb & ~0x10;
    }
  }

  write(reg: number, value: number): void {
    value &= 0xff;
    switch (reg & 0x0f) {
      case 0x00:
        this.pra = value;
        this.inputs.onPortWrite?.();
        break;
      case 0x01:
        this.prb = value;
        this.inputs.onPortWrite?.();
        break;
      case 0x02:
        this.ddra = value;
        this.inputs.onPortWrite?.();
        break;
      case 0x03:
        this.ddrb = value;
        this.inputs.onPortWrite?.();
        break;
      case 0x04:
        this.taLatch = (this.taLatch & 0xff00) | value;
        break;
      case 0x05:
        this.taLatch = (this.taLatch & 0x00ff) | (value << 8);
        if (!(this.cra & 0x01)) this.ta = this.taLatch;
        break;
      case 0x06:
        this.tbLatch = (this.tbLatch & 0xff00) | value;
        break;
      case 0x07:
        this.tbLatch = (this.tbLatch & 0x00ff) | (value << 8);
        if (!(this.crb & 0x01)) this.tb = this.tbLatch;
        break;
      case 0x08:
      case 0x09:
      case 0x0a:
      case 0x0b:
        this.writeTod(reg & 0x0f, value);
        break;
      case 0x0c:
        this.sdr = value;
        break;
      case 0x0d:
        if (value & 0x80) this.mask |= value & 0x1f;
        else this.mask &= ~(value & 0x1f);
        this.updateIrq();
        break;
      case 0x0e:
        if (!(this.cra & 0x01) && value & 0x01) this.taDelay = 1;
        // A force-load together with the start bit goes through the 6526 load pipeline: the
        // counter holds the latch for three ticks before it counts, whether the timer was
        // stopped or already running. The values a program can read match VICE's CIA timer
        // model (the VICE VIC-II reference tests of spritecrunch, spritebug and sprite DMA
        // sync on it); the underflow VICE can produce during the hold on a counter of 1 or 2
        // is not modelled, the latch is loaded at once.
        if (value & 0x10) {
          this.ta = this.taLatch;
          if (value & 0x01) this.taDelay = 3;
        }
        this.cra = value & ~0x10;
        break;
      default:
        if (!(this.crb & 0x01) && value & 0x01) this.tbDelay = 1;
        if (value & 0x10) {
          this.tb = this.tbLatch;
          if (value & 0x01) this.tbDelay = 3;
        }
        this.crb = value & ~0x10;
        break;
    }
  }

  private updateIrq(): void {
    this.irq = (this.flags & this.mask) !== 0;
  }

  private writeTod(reg: number, value: number): void {
    const index = reg - 0x08;
    if (this.crb & 0x80) {
      this.alarm[index] = value;
      return;
    }
    if (index === 3) this.todRunning = false; // writing hours stops the clock
    this.tod[index] = value;
    if (index === 0) {
      this.todRunning = true; // writing tenths restarts it
      this.todAcc = 0;
    }
  }

  private todTenth(): void {
    const t = this.tod;
    if (t[0] !== 9) t[0] = t[0]! + 1;
    else {
      t[0] = 0;
      if (t[1] !== 0x59) t[1] = incBcd(t[1]!);
      else {
        t[1] = 0;
        if (t[2] !== 0x59) t[2] = incBcd(t[2]!);
        else {
          t[2] = 0;
          let h = t[3]! & 0x1f;
          let pm = t[3]! & 0x80;
          if (h === 0x12) h = 0x01;
          else {
            h = incBcd(h);
            if (h === 0x12) pm ^= 0x80;
          }
          t[3] = h | pm;
        }
      }
    }
    const a = this.alarm;
    if (t[0] === a[0] && t[1] === a[1] && t[2] === a[2] && t[3] === a[3]) {
      this.pendingFlags |= 0x04;
    }
  }
}
