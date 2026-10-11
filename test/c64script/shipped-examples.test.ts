import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compile } from '../../src/c64script/index';

// A program that compiles must be a program that works: the compiler used to accept sources
// whose code overran their own data blocks. Every shipped .c64s must stay compilable.
describe('shipped C64Script examples', () => {
  it('examples/nyancat.c64s compiles and keeps its sprite data', () => {
    const prg = compile(readFileSync('examples/nyancat.c64s', 'utf8'));
    const load = prg[0]! | (prg[1]! << 8);
    expect(load).toBe(0x0810);
    // First byte of frame A (ear tips, row 0) sits at $0E00.
    expect(prg[2 + 0x0e00 - 0x0810]).not.toBe(undefined);
    expect(prg.length).toBeGreaterThan(2 + 0x0e00 - 0x0810 + 63 - 1);
  });
});
