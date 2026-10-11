import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compile } from '../../src/c64script/index';

// A program that compiles must be a program that works: the compiler used to accept sources
// whose code overran their own data blocks. Every shipped .c64s must stay compilable.
describe('shipped C64Script examples', () => {
  const files = readdirSync('website/showcases').filter((f) => f.endsWith('.c64s'));

  it('there are showcase sources to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`website/showcases/${file} compiles and loads at $0810`, () => {
      const prg = compile(readFileSync(`website/showcases/${file}`, 'utf8'));
      expect(prg[0]! | (prg[1]! << 8)).toBe(0x0810);
      expect(prg.length).toBeGreaterThan(2);
    });
  }
});
