import { C64, type LoadPrgOptions } from '../machine/c64';
import { openSource } from '../machine/sources';
import { createWorkletSink, AudioPump, type AudioSink } from './audio';
import { FrameClock } from './clock';
import { KeyMapper, type KeyEventLike } from './key-map';
import { KeyQueue } from './key-queue';
import { toBytes, type Source } from './loader';

export class ReadyTimeoutError extends Error {
  constructor(readonly frames: number) {
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
  /** Called once by `Player.destroy()` to undo anything else the environment set up. */
  dispose?(): void;
}

export type LoadOptions = LoadPrgOptions;

/** What the player needs from an audio path (an `AudioPump` fits). */
export interface PlayerAudio {
  pump(): number;
  setMuted(muted: boolean): void;
  close(): void;
}

export interface PlayerOptions {
  /** Frames to wait for READY. before loading a program (default 600 = 12 s emulated). */
  readyFrames?: number;
  audio?: PlayerAudio;
}

/** Frames emulated per animation tick while the tape motor runs. */
const WARP_FRAMES = 10;

export class Player {
  running = false;
  private rafId = 0;
  private readonly clock = new FrameClock();
  private readonly mapper: KeyMapper;
  private readonly keys: KeyQueue;
  private readonly unlisten: Array<() => void> = [];
  private readonly readyFrames: number;
  private readonly audio: PlayerAudio | undefined;
  private warping = false;
  private userMuted = false;

  constructor(
    readonly c64: C64,
    private readonly env: PlayerEnv,
    options: PlayerOptions = {},
  ) {
    this.readyFrames = options.readyFrames ?? 600;
    this.audio = options.audio;
    this.keys = new KeyQueue({
      press: (k) => c64.keyDown(k),
      release: (k) => c64.keyUp(k),
      restore: () => c64.restore(),
    });
    this.mapper = new KeyMapper(this.keys);
    this.unlisten.push(
      env.listen('keydown', (e) => {
        if (this.running && this.mapper.down(e)) e.preventDefault?.();
      }),
      env.listen('keyup', (e) => {
        if (this.running && this.mapper.up(e)) e.preventDefault?.();
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
    this.audio?.setMuted(this.userMuted || this.warping);
    this.clock.reset();
    this.schedule();
  }

  /** True when sound is playing through Web Audio, so there is something to mute. */
  get hasAudio(): boolean {
    return this.audio !== undefined;
  }

  /** The user's mute. Pausing and warping silence the sound on their own, whatever this is. */
  get muted(): boolean {
    return this.userMuted;
  }

  set muted(muted: boolean) {
    this.userMuted = muted;
    if (this.running) this.audio?.setMuted(muted || this.warping);
  }

  pause(): void {
    this.running = false;
    this.audio?.setMuted(true);
    if (this.rafId !== 0) this.env.cancelFrame(this.rafId);
    this.rafId = 0;
    // Drop any backlog and release held keys so nothing replays (or sticks) after resume().
    this.mapper.releaseAll();
    this.keys.flush();
  }

  reset(): void {
    this.c64.reset();
  }

  type(text: string): void {
    this.c64.type(text);
  }

  /**
   * Loads a program. Waits (synchronously, up to `readyFrames` emulated frames) for READY. first, so
   * the page can stall briefly if the machine is busy running something else.
   */
  async load(source: Source, options: LoadOptions = {}): Promise<void> {
    const bytes = await toBytes(source);
    const ready = this.c64.runUntilReady(this.readyFrames);
    // We have already waited for READY. (or given up), so load now rather than deferring.
    this.c64.loadPrg(bytes, { ...options, whenReady: false });
    if (!ready) throw new ReadyTimeoutError(this.readyFrames);
  }

  /** Mounts a disk image or program on drive 8; junk is rejected here, never at LOAD time. */
  async mountDisk(
    source: Source,
    kind?: 'd64' | 't64' | 'prg' | 'p00',
    name?: string,
  ): Promise<void> {
    const bytes = await toBytes(source);
    this.c64.drive(8).mount(openSource(bytes, kind, name));
  }

  unmountDisk(): void {
    this.c64.drive(8).unmount();
  }

  /** The (possibly modified) D64 in drive 8 as a fresh copy. */
  exportDisk(): Uint8Array {
    return this.c64.drive(8).exportD64();
  }

  async insertTape(source: Source): Promise<void> {
    this.c64.tape.insert(await toBytes(source));
  }

  get tape() {
    return this.c64.tape;
  }

  destroy(): void {
    this.pause();
    this.mapper.releaseAll();
    this.keys.flush();
    for (const off of this.unlisten) off();
    this.unlisten.length = 0;
    this.audio?.close();
    this.env.dispose?.();
  }

  private schedule(): void {
    this.rafId = this.env.requestFrame((now) => {
      if (!this.running) return;
      const elapsed = this.clock.advance(now);
      // While the tape motor runs the machine is fast-forwarded (bounded per animation tick).
      const warp = this.c64.warp;
      const frames = warp ? WARP_FRAMES : elapsed;
      if (warp !== this.warping) {
        this.warping = warp;
        this.audio?.setMuted(warp || this.userMuted);
      }
      for (let i = 0; i < frames; i++) {
        this.keys.pump();
        this.c64.runFrame();
        this.audio?.pump();
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
  /** A disk image or program for drive 8 (D64, T64, P00 or PRG; detected by content). */
  disk?: Source | { source: Source; kind?: 'd64' | 't64' | 'prg' | 'p00'; name?: string };
  /** A TAP file for the datasette. */
  tape?: Source;
  /** Start the disk (`LOAD"*",8,1` + `RUN`) or the tape (PLAY + `LOAD` + `RUN`) after boot. */
  autostart?: boolean;
  /**
   * Play the SID through Web Audio. Starts after the first user gesture (autoplay policy); falls
   * back to silence with a console notice when AudioWorklet is unavailable.
   */
  audio?: boolean | { sampleRate?: number; model?: '6581' | '8580' };
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
  const audioOptions =
    options.audio === undefined || options.audio === false
      ? null
      : options.audio === true
        ? {}
        : options.audio;
  const c64 = new C64({ kernal, basic, chargen }, audioOptions ? { sid: { ...audioOptions } } : {});

  canvas.width = 384;
  canvas.height = 272;
  canvas.style.imageRendering = 'pixelated';
  const scale = options.scale ?? 'fit';
  if (typeof scale === 'number') {
    canvas.style.width = `${384 * scale}px`;
    canvas.style.height = `${272 * scale}px`;
  }
  canvas.tabIndex = 0;
  const focusOnClick = () => canvas.focus();
  canvas.addEventListener('click', focusOnClick);
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
    dispose: () => canvas.removeEventListener('click', focusOnClick),
  };

  let sink: (AudioSink & { resume(): void }) | null = null;
  const stopGesture: Array<() => void> = [];
  if (audioOptions) {
    sink = await createWorkletSink({ sampleRate: c64.sid.sampleRate });
    if (sink) {
      const resumeAudio = () => {
        sink?.resume();
        for (const off of stopGesture) off();
        stopGesture.length = 0;
      };
      for (const type of ['pointerdown', 'keydown'] as const) {
        document.addEventListener(type, resumeAudio);
        stopGesture.push(() => document.removeEventListener(type, resumeAudio));
      }
    }
  }
  const pump = sink ? new AudioPump(c64.sid, sink) : undefined;
  const player = new Player(c64, env, pump ? { audio: pump } : {});
  if (pump) {
    const onVisibility = () => pump.setHidden(document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    const baseDispose = env.dispose;
    env.dispose = () => {
      document.removeEventListener('visibilitychange', onVisibility);
      for (const off of stopGesture) off();
      baseDispose?.();
    };
  }
  try {
    if (options.disk !== undefined) {
      const d = options.disk;
      if (
        typeof d === 'object' &&
        !(d instanceof Uint8Array) &&
        !(d instanceof ArrayBuffer) &&
        !(d instanceof Blob) &&
        'source' in d
      ) {
        await player.mountDisk(d.source, d.kind, d.name);
      } else {
        await player.mountDisk(d as Source);
      }
    }
    if (options.tape !== undefined) await player.insertTape(options.tape);
    player.resume();
    if (options.autostart) {
      c64.runUntilReady(600);
      if (options.disk !== undefined) {
        player.type('LOAD"*",8,1\rRUN\r');
      } else if (options.tape !== undefined) {
        player.tape.play();
        player.type('LOAD"",1\rRUN\r');
      }
    }
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
  } catch (error) {
    player.destroy();
    throw error;
  }
  return player;
}
