import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compile } from '../../src/c64script/index';
import { boot } from '../c64script/helpers';

const source = (id: string): string => readFileSync(`website/showcases/${id}.c64s`, 'utf8');

describe('showcase: rainbow-border', () => {
  it('compiles and steps the border through the colours', () => {
    expect(compile(source('rainbow-border')).length).toBeGreaterThan(2);
    const seen = new Set<number>();
    for (let frames = 10; frames < 400; frames += 10) {
      seen.add(boot(source('rainbow-border'), frames).peek(0xd020) & 15);
    }
    expect(seen.size).toBeGreaterThan(8);
  });

  it('shows its title', () => {
    const c = boot(source('rainbow-border'), 3);
    // "RAINBOW BORDER" starts at row 11, column 13; R = screen code 18
    expect(c.peek(0x0400 + 11 * 40 + 13)).toBe(18);
  });
});

describe('showcase: character-art', () => {
  const c = boot(source('character-art'), 4);
  const cell = (r: number, col: number) => c.peek(0x0400 + r * 40 + col);
  const colour = (r: number, col: number) => c.peek(0xd800 + r * 40 + col) & 15;

  it('fills the screen with solid blocks, except under the title', () => {
    expect(cell(0, 0)).toBe(0xa0);
    expect(cell(24, 39)).toBe(0xa0);
    expect(cell(20, 20)).toBe(0xa0);
    expect(cell(1, 14)).toBe(3); // C
  });

  it('colours every cell of a row alike, with the sky above the sea', () => {
    expect(colour(0, 0)).toBe(6);
    expect(colour(0, 39)).toBe(6);
    expect(colour(14, 20)).toBe(7);
    expect(colour(15, 5)).toBe(8);
    expect(colour(24, 39)).toBe(0);
  });
});

describe('showcase page', () => {
  const page = readFileSync('website/showcase.html', 'utf8');
  const script = readFileSync('website/js/showcase.js', 'utf8');

  it('has the elements the script fills in', () => {
    for (const id of [
      'showcase-canvas',
      'showcase-source',
      'showcase-status',
      'showcase-try',
      'showcase-title',
      'showcase-blurb',
      'showcase-file',
    ]) {
      expect(page).toContain(`id="${id}"`);
      expect(script).toContain(`'${id}'`);
    }
    expect(page).toMatch(/<script type="module" src="js\/showcase\.js">/);
  });

  it('every listed showcase has a source file, and a card on the showcases page', async () => {
    const { SHOWCASES } = await import('../../website/js/showcase-list.js');
    const cards = readFileSync('website/showcases.html', 'utf8');
    expect(SHOWCASES.length).toBeGreaterThan(0);
    for (const s of SHOWCASES) {
      expect(() => readFileSync(`website/showcases/${s.id}.c64s`, 'utf8')).not.toThrow();
      expect(cards).toContain(`href="showcase.html?id=${s.id}"`);
    }
  });
});

describe('showcase: sprite-dance', () => {
  const run = (frames: number) => boot(source('sprite-dance'), frames);
  const pos = (c: ReturnType<typeof run>) =>
    Array.from({ length: 8 }, (_, i) => [c.peek(0xd000 + 2 * i), c.peek(0xd001 + 2 * i)]);

  it('shows all eight sprites with the shared shape and distinct colours', () => {
    const c = run(6);
    expect(c.peek(0xd015)).toBe(0xff);
    for (let i = 0; i < 8; i++) expect(c.peek(0x07f8 + i)).toBe(53);
    const colours = new Set(Array.from({ length: 8 }, (_, i) => c.peek(0xd027 + i) & 15));
    expect(colours.size).toBe(8);
    expect(c.peek(0x0d40)).toBe(0x00); // top row of the circle is narrow
    expect(c.peek(0x0d40 + 30)).toBe(0xff); // the middle row is full
  });

  it('keeps every sprite inside the visible area and spreads them apart', () => {
    const c = run(20);
    const p = pos(c);
    for (const [x, y] of p) {
      expect(x).toBeGreaterThanOrEqual(24);
      expect(x).toBeLessThanOrEqual(255);
      expect(y).toBeGreaterThanOrEqual(50);
      expect(y).toBeLessThanOrEqual(229);
    }
    expect(new Set(p.map(([x, y]) => `${x},${y}`)).size).toBe(8);
  });

  it('moves between frames and returns to the start after the 128-frame loop', () => {
    const a = pos(run(10));
    const b = pos(run(40));
    expect(b).not.toEqual(a);
    expect(pos(run(10 + 128))).toEqual(a);
  });
});
