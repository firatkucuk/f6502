import { describe, expect, it } from 'vitest';
import { Player, type PlayerEnv, type PlayerKeyEvent } from '../../src/browser/player';
import { C64 } from '../../src/machine/c64';
import { D64, petscii } from '../../src/machine/d64';
import { filled } from '../machine/helpers';

function loopRoms() {
  const kernal = filled(8192, 0xea);
  kernal.set([0x4c, 0x00, 0xe0], 0); // JMP $E000
  kernal[0x1ffc] = 0x00;
  kernal[0x1ffd] = 0xe0;
  return { kernal, basic: filled(8192, 0), chargen: filled(4096, 0) };
}

function fakeEnv() {
  let nextId = 1;
  const callbacks = new Map<number, (now: number) => void>();
  const listeners = new Map<string, (e: PlayerKeyEvent) => void>();
  const presented: Uint32Array[] = [];
  const env: PlayerEnv = {
    present: (p) => void presented.push(p),
    requestFrame: (cb) => {
      const id = nextId++;
      callbacks.set(id, cb);
      return id;
    },
    cancelFrame: (id) => void callbacks.delete(id),
    listen: (type, handler) => {
      listeners.set(type, handler);
      return () => void listeners.delete(type);
    },
  };
  const fire = (now: number) => {
    const pending = [...callbacks.entries()];
    callbacks.clear();
    for (const [, cb] of pending) cb(now);
  };
  return { env, presented, listeners, fire, pending: () => callbacks.size };
}

describe('Player pause and destroy', () => {
  it('ignores key events while paused and drops a queued backlog on pause', () => {
    const f = fakeEnv();
    const player = new Player(new C64(loopRoms()), f.env);
    player.resume();
    const down = (key: string, code: string) =>
      f.listeners.get('keydown')!({ key, code, shiftKey: false });
    player.c64.busWrite(0xdc02, 0xff);
    player.c64.busWrite(0xdc00, 0b1111_1101);
    down('a', 'KeyA'); // queued, not yet applied
    player.pause();
    down('s', 'KeyS'); // ignored while paused
    player.resume();
    f.fire(0);
    f.fire(100);
    expect(player.c64.peek(0xdc01)).toBe(0xff); // neither key reached the matrix
  });

  it('calls the env dispose hook on destroy', () => {
    const f = fakeEnv();
    let disposed = 0;
    const player = new Player(new C64(loopRoms()), { ...f.env, dispose: () => void disposed++ });
    player.destroy();
    expect(disposed).toBe(1);
  });
});

describe('Player', () => {
  it('runs frames and presents them from the animation callback', () => {
    const f = fakeEnv();
    const player = new Player(new C64(loopRoms()), f.env);
    player.resume();
    f.fire(0);
    f.fire(40);
    expect(f.presented.length).toBeGreaterThanOrEqual(1);
    expect(f.presented[0]).toBe(player.c64.frame.pixels);
  });

  it('pause stops scheduling; resume restarts; destroy cancels and removes listeners', () => {
    const f = fakeEnv();
    const player = new Player(new C64(loopRoms()), f.env);
    player.resume();
    expect(f.pending()).toBe(1);
    player.pause();
    expect(f.pending()).toBe(0);
    player.resume();
    player.destroy();
    expect(f.pending()).toBe(0);
    expect(f.listeners.size).toBe(0);
  });

  it('routes key events to the C64 and prevents default on handled keys', () => {
    const f = fakeEnv();
    const player = new Player(new C64(loopRoms()), f.env);
    player.resume();
    let prevented = 0;
    f.listeners.get('keydown')!({
      key: 'a',
      code: 'KeyA',
      shiftKey: false,
      preventDefault: () => void prevented++,
    });
    expect(prevented).toBe(1);
    player.c64.busWrite(0xdc02, 0xff);
    player.c64.busWrite(0xdc00, 0b1111_1101);
    expect(player.c64.peek(0xdc01)).toBe(0xff); // queued: not applied until a frame runs
    f.fire(0);
    f.fire(40); // runs frames, pumping the key queue first
    expect(player.c64.peek(0xdc01)).toBe(0b1111_1011);
    f.listeners.get('blur')!({ key: '', code: '', shiftKey: false });
    expect(player.c64.peek(0xdc01)).toBe(0xff);
  });

  it('load rejects with ReadyTimeoutError when READY. never appears, but still copies the program', async () => {
    const f = fakeEnv();
    const player = new Player(new C64(loopRoms()), f.env, { readyFrames: 2 });
    await expect(player.load(Uint8Array.from([0x00, 0xc0, 0x60]))).rejects.toMatchObject({
      name: 'ReadyTimeoutError',
      frames: 2,
    });
    expect(player.c64.peek(0xc000)).toBe(0x60);
  });

  it('load with READY. on screen copies and starts', async () => {
    const f = fakeEnv();
    const c64 = new C64(loopRoms());
    c64.runFrame();
    [0x12, 0x05, 0x01, 0x04, 0x19, 0x2e].forEach((c, i) => c64.pokeRam(0x0400 + i, c));
    // the loop-only KERNAL never sets $D018, so point the VIC at the $0400 screen ourselves
    c64.busWrite(0xd018, 0x14);
    const player = new Player(c64, f.env);
    await player.load(Uint8Array.from([0x01, 0x08, 0x05]), { run: 'none' });
    expect(c64.peek(0x0801)).toBe(0x05);
  });
});

describe('Player audio', () => {
  it('pumps the audio once per emulated frame and closes it on destroy', () => {
    const f = fakeEnv();
    let pumps = 0;
    let closed = 0;
    const audio = { pump: () => pumps++, close: () => void closed++, setMuted: () => {} };
    const player = new Player(new C64(loopRoms()), f.env, { audio });
    player.resume();
    f.fire(0);
    f.fire(100); // several frames elapsed
    expect(pumps).toBeGreaterThanOrEqual(1);
    const frames = pumps;
    player.destroy();
    expect(closed).toBe(1);
    expect(frames).toBe(pumps);
  });

  it('mutes while paused and unmutes on resume', () => {
    const f = fakeEnv();
    const muted: boolean[] = [];
    const audio = { pump: () => 0, close: () => {}, setMuted: (m: boolean) => void muted.push(m) };
    const player = new Player(new C64(loopRoms()), f.env, { audio });
    player.resume();
    player.pause();
    player.resume();
    expect(muted).toEqual([false, true, false]);
  });
});

describe('Player mute', () => {
  const rig = () => {
    const f = fakeEnv();
    const muted: boolean[] = [];
    const audio = { pump: () => 0, close: () => {}, setMuted: (m: boolean) => void muted.push(m) };
    const c64 = new C64(loopRoms());
    return { f, muted, audio, c64, player: new Player(c64, f.env, { audio }) };
  };

  it('reports whether there is any sound to mute', () => {
    const f = fakeEnv();
    expect(new Player(new C64(loopRoms()), f.env).hasAudio).toBe(false);
    expect(rig().player.hasAudio).toBe(true);
  });

  it('silences the sound without pausing, and brings it back', () => {
    const { player, muted } = rig();
    player.resume();
    player.muted = true;
    expect(player.running).toBe(true);
    expect(muted[muted.length - 1]).toBe(true);
    player.muted = false;
    expect(muted[muted.length - 1]).toBe(false);
  });

  it('stays muted across pause and resume', () => {
    const { player, muted } = rig();
    player.muted = true; // before the first resume
    player.resume();
    expect(muted[muted.length - 1]).toBe(true);
    player.pause();
    player.resume();
    expect(muted[muted.length - 1]).toBe(true);
  });

  it('is not undone when warping ends', () => {
    const { f, c64, player, muted } = rig();
    let warp = true;
    Object.defineProperty(c64, 'warp', { get: () => warp });
    player.resume();
    player.muted = true;
    f.fire(0);
    f.fire(20);
    warp = false;
    f.fire(40);
    expect(muted[muted.length - 1]).toBe(true);
  });
});

describe('Player media', () => {
  it('mounts a D64, exports it after a SAVE through the drive, and rejects junk early', async () => {
    const f = fakeEnv();
    const player = new Player(new C64(loopRoms()), f.env);
    const image = D64.format('X', '01').export();
    await player.mountDisk(image);
    player.c64.drive(8).saveFile(petscii('A'), Uint8Array.from([1, 8, 1]));
    const out = player.exportDisk();
    expect(out.length).toBe(image.length);
    expect(out).not.toEqual(image);
    await expect(player.mountDisk(new Uint8Array(1))).rejects.toThrow();
    await expect(player.mountDisk(new Uint8Array(10), 'd64')).rejects.toThrow();
  });

  it('runs several frames per animation tick while the tape motor runs (warp), bounded', () => {
    const f = fakeEnv();
    const c64 = new C64(loopRoms());
    const player = new Player(c64, f.env);
    let frames = 0;
    const orig = c64.runFrame.bind(c64);
    c64.runFrame = () => {
      frames++;
      orig();
    };
    Object.defineProperty(c64, 'warp', { get: () => true });
    player.resume();
    f.fire(0);
    const afterFirst = frames;
    f.fire(20); // one real frame of wall time
    expect(frames - afterFirst).toBeGreaterThan(1);
    expect(frames - afterFirst).toBeLessThanOrEqual(10); // bounded per animation tick
  });

  it('mutes the audio while warping and restores it afterwards', () => {
    const f = fakeEnv();
    const c64 = new C64(loopRoms());
    const muted: boolean[] = [];
    const audio = { pump: () => 0, close: () => {}, setMuted: (m: boolean) => void muted.push(m) };
    let warp = true;
    Object.defineProperty(c64, 'warp', { get: () => warp });
    const player = new Player(c64, f.env, { audio });
    player.resume();
    f.fire(0);
    f.fire(20);
    warp = false;
    f.fire(40);
    expect(muted).toContain(true);
    expect(muted[muted.length - 1]).toBe(false);
  });
});
