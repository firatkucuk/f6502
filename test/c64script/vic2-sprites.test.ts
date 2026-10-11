import { describe, expect, it } from 'vitest';
import { boot } from './helpers';

describe('VIC2 sprite registers 0..7', () => {
  it('position and colour registers sit at their hardware addresses', () => {
    const body = Array.from(
      { length: 8 },
      (_, i) =>
        `VIC2.sprite${i}x = ${10 + i}; VIC2.sprite${i}y = ${20 + i}; VIC2.sprite${i}color = ${i + 1};`,
    ).join('\n');
    const c = boot(`program @ 0x0810 {\n${body}\nloop {}\n}`, 2);
    for (let i = 0; i < 8; i++) {
      expect(c.peek(0xd000 + 2 * i)).toBe(10 + i);
      expect(c.peek(0xd001 + 2 * i)).toBe(20 + i);
      expect(c.peek(0xd027 + i) & 15).toBe(i + 1);
    }
  });
});
