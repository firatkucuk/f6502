import { expect } from 'vitest';
import { C64 } from '../../src/machine/c64';
import { compile } from '../../src/c64script/index';
import {
  C64ScriptError,
  C64ScriptTypeError,
  CodeGenError,
  LexError,
} from '../../src/c64script/errors';

/** Compiles `src`, loads it into a bare machine and runs `frames` frames. */
export function boot(src: string, frames = 3): C64 {
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

export const border = (c: C64): number => c.peek(0xd020) & 0x0f;
export const background = (c: C64): number => c.peek(0xd021) & 0x0f;

/** Asserts that compiling `src` fails with the given error class, on `line` when given. */
export function expectError(
  src: string,
  kind: 'type' | 'codegen' | 'lex',
  match: RegExp,
  line?: number,
): void {
  const Expected = kind === 'type' ? C64ScriptTypeError : kind === 'lex' ? LexError : CodeGenError;
  try {
    compile(src);
  } catch (err) {
    expect(err).toBeInstanceOf(C64ScriptError);
    expect(err).toBeInstanceOf(Expected);
    expect((err as Error).message).toMatch(match);
    if (line !== undefined) expect((err as C64ScriptError).line).toBe(line);
    return;
  }
  expect.unreachable(`compile should have thrown for:\n${src}`);
}
