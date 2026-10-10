const HEADER = 'C64-TAPE-RAW';

/** Parse a TAP file into pulse lengths (CPU cycles between falling edges). */
export function parseTap(bytes: Uint8Array): Uint32Array {
  if (bytes.length < 20 || new TextDecoder().decode(bytes.subarray(0, 12)) !== HEADER) {
    throw new Error('not a TAP file (bad header)');
  }
  const version = bytes[12]!;
  const size = bytes[16]! | (bytes[17]! << 8) | (bytes[18]! << 16) | (bytes[19]! << 24);
  const end = Math.min(bytes.length, 20 + (size >>> 0));
  const out: number[] = [];
  let half = -1;
  for (let i = 20; i < end; i++) {
    const b = bytes[i]!;
    let cycles: number;
    if (b !== 0) {
      cycles = b * 8;
    } else if (version === 0) {
      cycles = 256 * 8;
    } else {
      if (i + 3 >= end) throw new Error('truncated TAP data (cycle count)');
      cycles = bytes[i + 1]! | (bytes[i + 2]! << 8) | (bytes[i + 3]! << 16);
      i += 3;
    }
    if (version === 2) {
      if (half < 0) half = cycles;
      else {
        out.push(half + cycles);
        half = -1;
      }
    } else {
      out.push(cycles);
    }
  }
  return Uint32Array.from(out);
}

interface Host {
  motorOn(): boolean;
  pulse(): void;
}

export class Datasette {
  private pulses: Uint32Array = new Uint32Array(0);
  private index = 0;
  private countdown = 0;
  private pressed = false;

  constructor(private readonly host: Host) {}

  insert(bytes: Uint8Array): void {
    this.pulses = parseTap(bytes);
    this.rewind();
    this.pressed = false;
  }

  eject(): void {
    this.pulses = new Uint32Array(0);
    this.rewind();
    this.pressed = false;
  }

  play(): void {
    if (this.pulses.length > 0 && this.index < this.pulses.length) this.pressed = true;
  }

  stop(): void {
    this.pressed = false;
  }

  rewind(): void {
    this.index = 0;
    this.countdown = this.pulses.length > 0 ? this.pulses[0]! : 0;
  }

  /** The PLAY key is down (the cassette sense line reads low). */
  get sense(): boolean {
    return this.pressed;
  }

  get playing(): boolean {
    return this.pressed;
  }

  /** Playing and the motor is on: the tape is moving. */
  get running(): boolean {
    return this.pressed && this.host.motorOn();
  }

  get position(): number {
    return this.index;
  }

  get length(): number {
    return this.pulses.length;
  }

  tick(): void {
    if (!this.pressed || !this.host.motorOn()) return;
    if (--this.countdown > 0) return;
    this.host.pulse();
    this.index++;
    if (this.index >= this.pulses.length) {
      this.pressed = false; // end of tape: the key pops up
      return;
    }
    this.countdown = Math.max(1, this.pulses[this.index]!);
  }
}
