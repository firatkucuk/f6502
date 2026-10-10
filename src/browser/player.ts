import { C64, type LoadPrgOptions } from '../machine/c64';
import { FrameClock } from './clock';
import { KeyMapper, type KeyEventLike } from './keymap';
import { KeyQueue } from './keyqueue';
import { toBytes, type Source } from './loader';

export class ReadyTimeoutError extends Error {
  constructor(frames: number) {
    super(`the BASIC READY. prompt did not appear within ${frames} frames`);
    this.name = 'ReadyTimeoutError';
  }
}

export interface PlayerKeyEvent extends KeyEventLike {
  preventDefault?(): void;
}

export interface PlayerEnv {
  present(pixels: Uint32Array): void;
  requestFrame(cb: (nowMs: number) => void): number;
  cancelFrame(id: number): void;
  listen(type: 'keydown' | 'keyup' | 'blur', handler: (e: PlayerKeyEvent) => void): () => void;
}

export type LoadOptions = LoadPrgOptions;

export interface PlayerOptions {
  /** Frames to wait for READY. before loading a program (default 600 = 12 s emulated). */
  readyFrames?: number;
}

export class Player {
  running = false;
  private rafId = 0;
  private readonly clock = new FrameClock();
  private readonly mapper: KeyMapper;
  private readonly keys: KeyQueue;
  private readonly unlisten: Array<() => void> = [];
  private readonly readyFrames: number;

  constructor(
    readonly c64: C64,
    private readonly env: PlayerEnv,
    options: PlayerOptions = {},
  ) {
    this.readyFrames = options.readyFrames ?? 600;
    this.keys = new KeyQueue({
      press: (k) => c64.keyDown(k),
      release: (k) => c64.keyUp(k),
      restore: () => c64.restore(),
    });
    this.mapper = new KeyMapper(this.keys);
    this.unlisten.push(
      env.listen('keydown', (e) => {
        if (this.mapper.down(e)) e.preventDefault?.();
      }),
      env.listen('keyup', (e) => {
        if (this.mapper.up(e)) e.preventDefault?.();
      }),
      env.listen('blur', () => {
        this.mapper.releaseAll();
        this.keys.flush();
      }),
    );
  }

  resume(): void {
    if (this.running) return;
    this.running = true;
    this.clock.reset();
    this.schedule();
  }

  pause(): void {
    this.running = false;
    if (this.rafId !== 0) this.env.cancelFrame(this.rafId);
    this.rafId = 0;
  }

  reset(): void {
    this.c64.reset();
  }

  type(text: string): void {
    this.c64.type(text);
  }

  async load(source: Source, options: LoadOptions = {}): Promise<void> {
    const bytes = await toBytes(source);
    const ready = this.c64.runUntilReady(this.readyFrames);
    // We have already waited for READY. (or given up), so load now rather than deferring.
    this.c64.loadPrg(bytes, { ...options, whenReady: false });
    if (!ready) throw new ReadyTimeoutError(this.readyFrames);
  }

  destroy(): void {
    this.pause();
    this.mapper.releaseAll();
    this.keys.flush();
    for (const off of this.unlisten) off();
    this.unlisten.length = 0;
  }

  private schedule(): void {
    this.rafId = this.env.requestFrame((now) => {
      if (!this.running) return;
      const frames = this.clock.advance(now);
      for (let i = 0; i < frames; i++) {
        this.keys.pump();
        this.c64.runFrame();
      }
      if (frames > 0) this.env.present(this.c64.frame.pixels);
      this.schedule();
    });
  }
}

export interface StartOptions {
  canvas: string | HTMLCanvasElement;
  roms: { kernal: Source; basic: Source; chargen: Source };
  program?: Source | { source: Source; address?: number; start?: number };
  scale?: number | 'fit';
  keyboardTarget?: 'canvas' | 'document';
}

function isProgramObject(
  p: NonNullable<StartOptions['program']>,
): p is { source: Source; address?: number; start?: number } {
  return (
    typeof p === 'object' &&
    !(p instanceof Uint8Array) &&
    !(p instanceof ArrayBuffer) &&
    !(p instanceof Blob)
  );
}

export async function start(options: StartOptions): Promise<Player> {
  const canvas =
    typeof options.canvas === 'string'
      ? (document.querySelector(options.canvas) as HTMLCanvasElement | null)
      : options.canvas;
  if (!canvas || typeof canvas.getContext !== 'function') {
    throw new Error(`canvas not found: ${String(options.canvas)}`);
  }
  const [kernal, basic, chargen] = await Promise.all([
    toBytes(options.roms.kernal),
    toBytes(options.roms.basic),
    toBytes(options.roms.chargen),
  ]);
  const c64 = new C64({ kernal, basic, chargen });

  canvas.width = 384;
  canvas.height = 272;
  canvas.style.imageRendering = 'pixelated';
  const scale = options.scale ?? 'fit';
  if (typeof scale === 'number') {
    canvas.style.width = `${384 * scale}px`;
    canvas.style.height = `${272 * scale}px`;
  }
  canvas.tabIndex = 0;
  canvas.addEventListener('click', () => canvas.focus());
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  const image = new ImageData(new Uint8ClampedArray(c64.frame.pixels.buffer), 384, 272);

  const target: EventTarget = options.keyboardTarget === 'document' ? document : canvas;
  const env: PlayerEnv = {
    present: () => ctx.putImageData(image, 0, 0),
    requestFrame: (cb) => requestAnimationFrame(cb),
    cancelFrame: (id) => cancelAnimationFrame(id),
    listen: (type, handler) => {
      // In document mode the canvas never has focus, so window blur is the signal that a key-up
      // may have gone to another window.
      const source: EventTarget =
        type === 'blur' ? (options.keyboardTarget === 'document' ? window : canvas) : target;
      const fn = handler as unknown as EventListener;
      source.addEventListener(type, fn);
      return () => source.removeEventListener(type, fn);
    },
  };

  const player = new Player(c64, env);
  player.resume();
  if (options.program !== undefined) {
    if (isProgramObject(options.program)) {
      const { source, address, start: startAddress } = options.program;
      const opts: LoadOptions = {};
      if (address !== undefined) opts.address = address;
      if (startAddress !== undefined) opts.start = startAddress;
      await player.load(source, opts);
    } else {
      await player.load(options.program);
    }
  }
  return player;
}
