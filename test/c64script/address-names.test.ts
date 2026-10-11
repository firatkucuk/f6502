import { describe, expect, it } from 'vitest';
import { compile } from '../../src/c64script/index';
import { boot, expectError } from './helpers';

const prog = (body: string, head = '') => `${head}\nprogram @ 0x0810 {\n${body}\n  loop {}\n}`;

describe('well-known address constants', () => {
  it('have their classic values', () => {
    const c = boot(
      prog(`
        poke(SCREEN_RAM, 1);
        poke(COLOR_RAM, 2);
        poke(SPRITE_PTRS, 3);`),
      2,
    );
    expect(c.peek(0x0400)).toBe(1);
    expect(c.peek(0xd800) & 15).toBe(2);
    expect(c.peek(0x07f8)).toBe(3);
  });

  it('fold with offsets, byte-identical to the literal address', () => {
    const named = compile(prog('poke(SCREEN_RAM + 495, 8);'));
    const literal = compile(prog('poke(0x0400 + 495, 8);'));
    expect(Array.from(named)).toEqual(Array.from(literal));
  });

  it('are addresses in assembly', () => {
    const c = boot(
      prog(`asm {
        lda #7
        sta \${SCREEN_RAM},x
        sta \${COLOR_RAM},x
      }`),
      2,
    );
    expect(c.peek(0x0400)).toBe(7);
    expect(c.peek(0xd800) & 15).toBe(7);
  });

  it('SPRITE_PTRS + n addresses sprite n', () => {
    const c = boot(prog('poke(SPRITE_PTRS + 2, 9);'), 2);
    expect(c.peek(0x07fa)).toBe(9);
  });

  it('cannot be redefined', () => {
    expectError(
      prog('', 'const SCREEN_RAM: u16 = 0x0800;'),
      'type',
      /'SCREEN_RAM' already defined/,
      1,
    );
  });

  it('may be used as a data address', () => {
    const c = boot(`data @addr(SPRITE_PTRS + 0x500) { t: [u8; 2] = [4, 5]; }\n${prog('')}`, 2);
    expect(c.peek(0x0cf8)).toBe(4);
  });
});

describe('spritePtr()', () => {
  it('turns a 64-byte aligned address into the pointer value', () => {
    const c = boot(prog('poke(SPRITE_PTRS, spritePtr(0x0D40));'), 2);
    expect(c.peek(0x07f8)).toBe(53);
  });

  it('takes a named constant and a constant expression', () => {
    const c = boot(
      prog('poke(SPRITE_PTRS, spritePtr(SPR + 0x40));', 'const SPR: u16 = 0x0D40;'),
      2,
    );
    expect(c.peek(0x07f8)).toBe(54);
  });

  it('works in a constant initialiser', () => {
    const c = boot(prog('poke(SPRITE_PTRS, P);', 'const P: u8 = spritePtr(0x0C00);'), 2);
    expect(c.peek(0x07f8)).toBe(48);
  });

  it('rejects a misaligned address', () => {
    expectError(
      prog('poke(SPRITE_PTRS, spritePtr(0x0D41));'),
      'type',
      /spritePtr\(\): address 3393 is not a multiple of 64/,
      3,
    );
  });

  it('rejects an address outside VIC bank 0', () => {
    expectError(
      prog('poke(SPRITE_PTRS, spritePtr(0x4000));'),
      'type',
      /spritePtr\(\): address 16384 is outside/,
      3,
    );
  });

  it('rejects a non-constant address', () => {
    expectError(
      prog('let a: u16 = 0x0D40;\n poke(SPRITE_PTRS, spritePtr(a));'),
      'codegen',
      /spritePtr\(\): the address must be a compile-time constant/,
      4,
    );
  });

  it('expects exactly one argument', () => {
    expectError(
      prog('poke(SPRITE_PTRS, spritePtr());'),
      'type',
      /function 'spritePtr' expects 1 argument, got 0/,
      3,
    );
  });
});
