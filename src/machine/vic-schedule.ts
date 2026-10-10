/** PAL: the cycle (1..63) of each sprite's pointer fetch; the data bytes follow in the next cycle. */
export const SPRITE_P_CYCLE = [58, 60, 62, 1, 3, 5, 7, 9] as const;

/**
 * SPRITE_BA[c] bit n: BA is low in cycle c because sprite n's DMA window covers it (only while
 * that sprite's DMA is on). The window runs from 3 cycles before the pointer fetch to the last
 * data cycle (P-3 .. P+1) and wraps across the line boundary.
 */
export const SPRITE_BA = new Uint8Array(64);
SPRITE_P_CYCLE.forEach((p, n) => {
  for (let k = -3; k <= 1; k++) {
    const c = ((p + k - 1 + 63) % 63) + 1;
    SPRITE_BA[c]! |= 1 << n;
  }
});
