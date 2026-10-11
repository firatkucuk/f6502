import { describe, expect, it } from 'vitest';
import { C64 } from '../../src/machine/c64';
import { compile } from '../../src/c64script/index';

function boot(src: string, frames = 3): C64 {
  const prg = compile(src);
  const load = prg[0]! | (prg[1]! << 8);
  const c64 = new C64({
    kernal: new Uint8Array(8192).fill(0xea),
    basic: new Uint8Array(8192),
    chargen: new Uint8Array(4096),
  });
  for (let i = 2; i < prg.length; i++) c64.pokeRam(load + i - 2, prg[i]!);
  c64.cpu.regs.pc = load;
  for (let f = 0; f < frames; f++) c64.runFrame();
  return c64;
}

describe('for statement', () => {
  it('runs with a global initialised by assignment and an i++ post clause', () => {
    const c64 = boot(`
      let @zp i: u8 = 0;
      program @ 0x0810 {
        for (i = 0; i < 10; i++) { VIC2.borderColor = i; }
        loop {}
      }`);
    expect(c64.peek(0xd020) & 0x0f).toBe(9);
  });
});
