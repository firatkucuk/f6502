import { describe, expect, it } from 'vitest';
import { C64 } from '../../src/machine/c64';
import { compile } from '../../src/c64script/index';
import { EXAMPLES } from '../../website/js/playground-examples.js';

function boot(source: string, frames: number): C64 {
  const prg = compile(source);
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

describe('playground examples', () => {
  it('has unique ids and non-empty titles', () => {
    expect(EXAMPLES.length).toBeGreaterThanOrEqual(5);
    expect(new Set(EXAMPLES.map((e) => e.id)).size).toBe(EXAMPLES.length);
    for (const e of EXAMPLES) expect(e.title.length).toBeGreaterThan(0);
  });

  it.each(EXAMPLES.map((e) => [e.id, e.source] as const))('%s compiles', (_id, source) => {
    const prg = compile(source);
    expect(prg.length).toBeGreaterThan(2);
  });

  it('rainbow cycles the border colour over time', () => {
    const rainbow = EXAMPLES.find((e) => e.id === 'rainbow')!;
    const seen = new Set<number>();
    for (const frames of [10, 20, 40, 60, 80, 120]) {
      seen.add(boot(rainbow.source, frames).peek(0xd020) & 0x0f);
    }
    expect(seen.size).toBeGreaterThanOrEqual(4);
  });

  it('colors sets border and background', () => {
    const c64 = boot(EXAMPLES.find((e) => e.id === 'colors')!.source, 2);
    expect(c64.peek(0xd020) & 0x0f).toBe(6);
    expect(c64.peek(0xd021) & 0x0f).toBe(14);
  });

  it('hello writes H at row 12, column 15 and continues', () => {
    const c64 = boot(EXAMPLES.find((e) => e.id === 'hello')!.source, 3);
    expect(c64.peek(0x0400 + 495)).toBe(8);
    expect(c64.peek(0x0400 + 503)).toBe(0x34);
  });

  it('sprite moves right across the screen', () => {
    const src = EXAMPLES.find((e) => e.id === 'sprite')!.source;
    const early = boot(src, 10).peek(0xd000);
    const later = boot(src, 30).peek(0xd000);
    expect(later).toBeGreaterThan(early);
  });
});
