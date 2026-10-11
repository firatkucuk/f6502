import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { C64 } from '../../src/machine/c64';
import { compile } from '../../src/c64script/index';
import { EXAMPLES } from '../../website/js/playground-examples.js';

const rom = (name: string) => new Uint8Array(readFileSync(`website/demos/${name}`));

function machine(): C64 {
  return new C64({
    kernal: rom('kernal.bin'),
    basic: rom('basic.bin'),
    chargen: rom('chargen.bin'),
  });
}

describe('playground Run: reset, wait for READY., load', () => {
  it('reaches READY. again after a program that clears the screen', () => {
    const hello = compile(EXAMPLES.find((e) => e.id === 'hello')!.source);
    const c64 = machine();
    expect(c64.runUntilReady(600)).toBe(true);
    for (let round = 0; round < 4; round++) {
      c64.reset();
      expect(c64.runUntilReady(600), `reset round ${round}`).toBe(true);
      c64.loadPrg(hello, { whenReady: false });
      for (let i = 0; i < 20; i++) c64.runFrame();
    }
  });

  it('every example can be run after every other example', () => {
    const progs = EXAMPLES.map((e) => compile(e.source));
    const c64 = machine();
    expect(c64.runUntilReady(600)).toBe(true);
    for (const first of progs) {
      for (const second of progs) {
        c64.reset();
        expect(c64.runUntilReady(600)).toBe(true);
        c64.loadPrg(first, { whenReady: false });
        for (let i = 0; i < 10; i++) c64.runFrame();
        c64.reset();
        expect(c64.runUntilReady(600)).toBe(true);
        c64.loadPrg(second, { whenReady: false });
        for (let i = 0; i < 10; i++) c64.runFrame();
      }
    }
  });
});
