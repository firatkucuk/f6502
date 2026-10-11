import { describe, expect, it } from 'vitest';
import { C64 } from '../../src/machine/c64';
import { compile } from '../../src/c64script/index';
import { CodeGenError } from '../../src/c64script/errors';

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

describe('clrscr()', () => {
  it('clears all of screen RAM and then continues with the next statement', () => {
    const c64 = boot('program @ 0x0810 { clrscr(); VIC2.borderColor = 5; loop {} }');
    for (const addr of [0x0400, 0x0500, 0x05ef, 0x0600, 0x0700, 0x07e7]) {
      expect(c64.peek(addr), `screen RAM at $${addr.toString(16)}`).toBe(0x20);
    }
    expect(c64.peek(0xd020) & 0x0f).toBe(5); // proves execution did not run off the end
  });

  it('clears all of colour RAM', () => {
    const c64 = boot(`program @ 0x0810 {
      poke(0xd800, 1); poke(0xd9ef, 1); poke(0xdb00, 1); poke(0xdb80, 1); poke(0xdbe7, 1);
      clrscr();
      loop {}
    }`);
    for (const addr of [0xd800, 0xd9ef, 0xdb00, 0xdb80, 0xdbe7]) {
      expect(c64.peek(addr) & 0x0f, `colour RAM at $${addr.toString(16)}`).toBe(0);
    }
  });
});

describe('poke()', () => {
  it('stores a constant value at a constant address', () => {
    const c64 = boot('program @ 0x0810 { poke(0x05ef, 8); loop {} }');
    expect(c64.peek(0x05ef)).toBe(8);
  });

  it('stores a variable value and an expression value', () => {
    const c64 = boot(`
      let @zp v: u8 = 7;
      program @ 0x0810 {
        poke(0x05ef, v);
        poke(0xd9ef, v + 1);
        loop {}
      }`);
    expect(c64.peek(0x05ef)).toBe(7);
    expect(c64.peek(0xd9ef) & 0x0f).toBe(8);
  });

  it('folds a constant address expression', () => {
    const c64 = boot('program @ 0x0810 { poke(0x0400 + 495, 9); loop {} }');
    expect(c64.peek(0x05ef)).toBe(9);
  });

  it('takes a computed address (a variable)', () => {
    const c = boot('let @zp a: u8 = 0x40;\nprogram @ 0x0810 {\n  poke(a, 1);\n  loop {}\n}', 2);
    expect(c.peek(0x0040)).toBe(1);
  });

  it('rejects a 16-bit value that does not fit the byte it stores', () => {
    const src = 'let w: u16 = 300;\nprogram @ 0x0810 {\n  poke(0x0400, w);\n  loop {}\n}';
    try {
      compile(src);
      expect.unreachable('compile should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CodeGenError);
      expect((err as CodeGenError).line).toBe(3);
    }
  });
});
