import { describe, expect, it } from 'vitest';
import { ZpAllocator } from '../../src/c64script/symbols';

describe('ZpAllocator', () => {
  it('starts at $02', () => {
    const zp = new ZpAllocator();
    expect(zp.alloc(1)).toBe(0x02);
  });

  it('allocates sequentially', () => {
    const zp = new ZpAllocator();
    zp.alloc(1);
    expect(zp.alloc(2)).toBe(0x03);
  });

  it('throws when budget exhausted', () => {
    const zp = new ZpAllocator();
    expect(() => zp.alloc(246)).toThrow(); // 246 bytes would exceed $02..$F7 (245 available)
  });

  it('tracks used bytes', () => {
    const zp = new ZpAllocator();
    zp.alloc(3);
    expect(zp.used()).toBe(3);
  });
});
