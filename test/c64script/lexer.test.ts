import { describe, expect, it } from 'vitest';
import { LexError } from '../../src/c64script/errors';

describe('errors', () => {
  it('LexError carries line/col', () => {
    const e = new LexError('bad char', 3, 7);
    expect(e.line).toBe(3);
    expect(e.col).toBe(7);
    expect(e.message).toContain('[3:7]');
  });
});
