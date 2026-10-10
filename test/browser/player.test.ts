import { describe, expect, it } from 'vitest';
import {
  Player,
  ReadyTimeoutError,
  type PlayerEnv,
  type PlayerKeyEvent,
} from '../../src/browser/player';
import { C64 } from '../../src/machine/c64';
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
    let prevented = 0;
    f.listeners.get('keydown')!({
      key: 'a',
      code: 'KeyA',
      shiftKey: false,
      preventDefault: () => void prevented++,
    });
    expect(prevented).toBe(1);
    player.c64.writeIo(0xdc02, 0xff);
    player.c64.writeIo(0xdc00, 0b1111_1101);
    expect(player.c64.peek(0xdc01)).toBe(0b1111_1011);
    f.listeners.get('blur')!({ key: '', code: '', shiftKey: false });
    expect(player.c64.peek(0xdc01)).toBe(0xff);
  });

  it('load rejects with ReadyTimeoutError when READY. never appears, but still copies the program', async () => {
    const f = fakeEnv();
    const player = new Player(new C64(loopRoms()), f.env, { readyFrames: 2 });
    await expect(player.load(Uint8Array.from([0x00, 0xc0, 0x60]))).rejects.toBeInstanceOf(
      ReadyTimeoutError,
    );
    expect(player.c64.peek(0xc000)).toBe(0x60);
  });

  it('load with READY. on screen copies and starts', async () => {
    const f = fakeEnv();
    const c64 = new C64(loopRoms());
    c64.runFrame();
    [0x12, 0x05, 0x01, 0x04, 0x19, 0x2e].forEach((c, i) => c64.pokeRam(0x0400 + i, c));
    // the loop-only KERNAL never sets $D018, so point the VIC at the $0400 screen ourselves
    c64.writeIo(0xd018, 0x14);
    const player = new Player(c64, f.env);
    await player.load(Uint8Array.from([0x01, 0x08, 0x05]), { run: 'none' });
    expect(c64.peek(0x0801)).toBe(0x05);
  });
});
