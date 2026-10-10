import { describe, expect, it } from 'vitest';
import { B, C, D, I, N, U, V, Z } from '../../src/core/flags';

describe('status flags', () => {
  it('uses the 6502 P register bit layout', () => {
    expect([C, Z, I, D, B, U, V, N]).toEqual([0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80]);
  });
});
