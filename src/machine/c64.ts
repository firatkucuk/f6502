import { MOS6502 } from '../core';
import { C64Bus } from './bus';
import { Cia } from './cia';
import { CpuPort } from './cpu-port';
import { Keyboard, type C64Key } from './keyboard';
import { validateRoms, type RomSet } from './memory';
import { parsePrg, rawProgram, type Prg } from './prg';
import { FRAME_HEIGHT, FRAME_WIDTH, VicII } from './vic';

export interface C64Options {
  video?: 'pal';
}

export interface LoadPrgOptions {
  run?: 'auto' | 'basic' | 'sys' | 'none';
  /** Treat the bytes as a headerless binary placed at this address. */
  address?: number;
  /** Start address for `SYS` (default: the load address). */
  start?: number;
  /**
   * Defer the copy and start until READY. is on screen (default true): a load issued while the
   * KERNAL is still cold-starting would be wiped by BASIC's NEW. Pass false to load immediately.
   */
  whenReady?: boolean;
}

export const CYCLES_PER_FRAME = 19_656;
const RESTORE_PULSE_CYCLES = 8;

export class C64 {
  readonly cpu: MOS6502;
  private readonly bus: C64Bus;
  private readonly port: CpuPort;
  private readonly cia1: Cia;
  private readonly cia2: Cia;
  private readonly vic: VicII;
  private readonly keyboard = new Keyboard();
  private restoreCountdown = 0;
  private credit = 0;
  private readonly typeQueue: number[] = [];
  private pendingLoad: { prg: Prg; options: LoadPrgOptions } | null = null;

  constructor(roms: RomSet, options: C64Options = {}) {
    validateRoms(roms);
    if (options.video !== undefined && options.video !== 'pal') {
      throw new Error(`unsupported video standard '${options.video}': only 'pal' is implemented`);
    }
    this.port = new CpuPort(() => this.bus.rebuild());
    this.cia1 = new Cia({
      inputA: () => this.keyboard.scanRows(this.cia1.outputB()),
      inputB: () => this.keyboard.scanColumns(this.cia1.outputA()),
    });
    this.cia2 = new Cia({ inputA: () => 0xff, inputB: () => 0xff });
    this.vic = new VicII({
      readMem: (a) => this.bus.vicRead(a),
      readColor: (i) => this.bus.colorRam[i & 0x3ff]!,
    });
    this.bus = new C64Bus(roms, { vic: this.vic, cia1: this.cia1, cia2: this.cia2 }, this.port);
    this.cpu = new MOS6502(this.bus, { onCycle: () => this.tickChips() });
    this.bus.powerOn();
    this.reset();
  }

  get frame() {
    return { width: FRAME_WIDTH as 384, height: FRAME_HEIGHT as 272, pixels: this.vic.frame };
  }

  reset(): void {
    this.port.reset();
    this.cia1.reset();
    this.cia2.reset();
    this.vic.reset();
    this.keyboard.releaseAll();
    this.typeQueue.length = 0;
    this.pendingLoad = null;
    this.restoreCountdown = 0;
    this.credit = 0;
    this.cpu.reset();
  }

  runCycles(n: number): void {
    this.credit += n;
    while (this.credit > 0) this.credit -= this.cpu.step();
  }

  /** Runs until the VIC completes one frame. */
  runFrame(): void {
    const start = this.vic.frameCount;
    while (this.vic.frameCount === start) this.cpu.step();
    this.pumpTypeQueue();
    if (this.pendingLoad !== null && this.isReady()) {
      const { prg, options } = this.pendingLoad;
      this.pendingLoad = null;
      this.applyPrg(prg, options);
    }
  }

  /** Runs frames until READY. is on screen; returns false after `maxFrames`. */
  runUntilReady(maxFrames = 600): boolean {
    for (let i = 0; i < maxFrames; i++) {
      if (this.isReady()) return true;
      this.runFrame();
    }
    return this.isReady();
  }

  isReady(): boolean {
    return this.screenText().some((line) => line.includes('READY.'));
  }

  /** The 25 screen lines as text (uppercase charset screen codes). */
  screenText(): string[] {
    const base = ((this.vic.peek(0x18) >> 4) & 0x0f) << 10;
    const lines: string[] = [];
    for (let row = 0; row < 25; row++) {
      let line = '';
      for (let col = 0; col < 40; col++) {
        line += screenCodeToChar(this.bus.vicRead(base + row * 40 + col));
      }
      lines.push(line);
    }
    return lines;
  }

  keyDown(key: C64Key): void {
    this.keyboard.press(key);
  }

  keyUp(key: C64Key): void {
    this.keyboard.release(key);
  }

  restore(): void {
    this.restoreCountdown = RESTORE_PULSE_CYCLES;
  }

  /**
   * Queues text for the KERNAL keyboard buffer. Letters become the (upper-case) PETSCII letters,
   * \n and \r are RETURN, `£ ^ _` map to their PETSCII codes; characters with no PETSCII
   * equivalent (`\\ { | } ~` and backtick, non-Latin text) are skipped.
   */
  type(text: string): void {
    for (const ch of text) {
      const code = toPetscii(ch);
      if (code !== null) this.typeQueue.push(code);
    }
    this.pumpTypeQueue();
  }

  /**
   * Places a program in RAM and starts it (see `LoadPrgOptions`). A malformed program throws
   * immediately. By default the copy and start wait for READY. (`whenReady: false` loads now).
   */
  loadPrg(bytes: Uint8Array, options: LoadPrgOptions = {}): void {
    const prg: Prg =
      options.address !== undefined ? rawProgram(bytes, options.address) : parsePrg(bytes);
    if ((options.whenReady ?? true) && !this.isReady()) {
      this.pendingLoad = { prg, options };
      return;
    }
    this.applyPrg(prg, options);
  }

  private applyPrg(prg: Prg, options: LoadPrgOptions): void {
    this.bus.ram.set(prg.data, prg.address);
    let run = options.run ?? 'auto';
    if (run === 'auto') {
      run = prg.address === 0x0801 && options.start === undefined ? 'basic' : 'sys';
    }
    if (run === 'basic') {
      for (const lo of [0x2d, 0x2f, 0x31]) {
        this.bus.ram[lo] = prg.end & 0xff;
        this.bus.ram[lo + 1] = prg.end >> 8;
      }
      this.type('RUN\r');
    } else if (run === 'sys') {
      this.type(`SYS ${options.start ?? prg.address}\r`);
    }
  }

  peek(addr: number): number {
    return this.bus.peek(addr);
  }

  /** @internal Test/diagnostic helper: write straight into RAM, ignoring banking. */
  pokeRam(addr: number, value: number): void {
    this.bus.ram[addr & 0xffff] = value & 0xff;
  }

  /** @internal Test/diagnostic helper: a CPU-visible bus write (RAM, I/O or the 6510 port). */
  busWrite(addr: number, value: number): void {
    this.bus.write(addr, value);
  }

  // ---- internals -----------------------------------------------------------

  private tickChips(): void {
    this.cia1.tick();
    this.cia2.tick();
    this.vic.tick();
    this.bus.vicBank = ~this.cia2.outputA() & 3;
    let restoreActive = false;
    if (this.restoreCountdown > 0) {
      restoreActive = true;
      this.restoreCountdown--;
    }
    this.cpu.setIrq(this.cia1.irq || this.vic.irq);
    this.cpu.setNmi(this.cia2.irq || restoreActive);
  }

  private pumpTypeQueue(): void {
    const ram = this.bus.ram;
    const max = Math.min(ram[0x0289]! || 10, 10);
    while (this.typeQueue.length > 0 && ram[0xc6]! < max) {
      const n = ram[0xc6]!;
      ram[0x0277 + n] = this.typeQueue.shift()!;
      ram[0xc6] = n + 1;
    }
  }
}

/** ASCII/Unicode character -> PETSCII byte, or null when the C64 has no such key. */
function toPetscii(ch: string): number | null {
  if (ch === '\n' || ch === '\r') return 0x0d;
  if (ch === '£') return 0x5c;
  const code = ch.toUpperCase().charCodeAt(0);
  if (ch.length === 0 || code > 0x7f) return null;
  if (code === 0x5c || code >= 0x60) return null; // \ and { | } ~ ` DEL have no PETSCII
  if (code < 0x20) return null;
  return code;
}

function screenCodeToChar(code: number): string {
  const c = code & 0x7f;
  if (c === 0) return '@';
  if (c <= 26) return String.fromCharCode(0x40 + c);
  if (c === 27) return '[';
  if (c === 28) return '£';
  if (c === 29) return ']';
  if (c === 30) return '^';
  if (c === 31) return '←';
  if (c >= 32 && c < 64) return String.fromCharCode(c);
  return ' ';
}
