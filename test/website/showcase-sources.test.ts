import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compile } from '../../src/c64script/index';
import { C64 } from '../../src/machine/index';
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

  it('centres its second line (26 characters from column 7 to column 32)', () => {
    const c = boot(source('rainbow-border'), 3);
    const row = Array.from({ length: 40 }, (_, col) => c.peek(0x0400 + 13 * 40 + col));
    const used = row.map((v, col) => (v !== 0x20 ? col : -1)).filter((col) => col >= 0);
    expect(used[0]).toBe(7);
    expect(used[used.length - 1]).toBe(32);
  });
});

describe('showcase: character-art', () => {
  const c = boot(source('character-art'), 30); // 1000 cells painted by loops take ~20 frames
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
      'showcase-hint',
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

describe('showcase thumbnails', () => {
  const cards = readFileSync('website/showcases.html', 'utf8');

  it('every live showcase card shows a screenshot that exists', async () => {
    const { SHOWCASES } = await import('../../website/js/showcase-list.js');
    for (const s of SHOWCASES) {
      expect(cards).toContain(`src="img/showcases/${s.id}.png"`);
      expect(() => readFileSync(`website/img/showcases/${s.id}.png`)).not.toThrow();
    }
  });

  it('no trace of the removed Nyan Cat demo is left on the site or in CI', () => {
    expect(cards).not.toMatch(/nyan/i);
    expect(readFileSync('.github/workflows/pages.yml', 'utf8')).not.toMatch(/nyan/i);
    expect(readFileSync('AGENTS.md', 'utf8')).not.toMatch(/nyan/i);
  });
});

describe('showcases page header', () => {
  it('its main button opens the playground, not the home page demo', () => {
    const cards = readFileSync('website/showcases.html', 'utf8');
    expect(cards).toMatch(
      /<a class="btn btn-primary" href="playground\.html">[^<]*playground<\/a>/,
    );
    expect(cards).not.toMatch(/index\.html#demo/);
  });
});

describe('showcase: flappy-bird', () => {
  // A character ROM whose block character ($A0) is solid, so the VIC-II can see a pipe.
  function newGame() {
    const chargen = new Uint8Array(4096);
    chargen.fill(0xff, 0xa0 * 8, 0xa0 * 8 + 8);
    const c = new C64({
      kernal: new Uint8Array(8192).fill(0xea),
      basic: new Uint8Array(8192),
      chargen,
    });
    const prg = compile(source('flappy-bird'));
    for (let i = 2; i < prg.length; i++) c.pokeRam(0x0810 + i - 2, prg[i]!);
    c.cpu.regs.pc = 0x0810;
    return c;
  }
  type Game = ReturnType<typeof newGame>;

  const BIRD_COL = 7;
  const cell = (c: Game, r: number, col: number) => c.peek(0x0400 + r * 40 + col);
  const text = (c: Game, r: number, col: number, len: number) =>
    Array.from({ length: len }, (_, i) => cell(c, r, col + i))
      .map((v) =>
        v >= 1 && v <= 26 ? String.fromCharCode(64 + v) : v === 32 ? ' ' : v === 0xa0 ? '#' : '?',
      )
      .join('');
  const y = (c: Game) => c.peek(0xd001);
  const score = (c: Game) => (cell(c, 0, 38) - 0x30) * 10 + (cell(c, 0, 39) - 0x30);
  const run = (c: Game, frames: number) => {
    for (let i = 0; i < frames; i++) c.runFrame();
  };
  /** Runs until the title is on screen (the loops paint the sky and ground first). */
  const toTitle = (c: Game) => {
    for (let i = 0; i < 120 && text(c, 11, 14, 11) !== 'PRESS SPACE'; i++) c.runFrame();
    run(c, 2); // the game is now waiting for a fresh press
  };
  const tap = (c: Game) => {
    c.keyDown('SPACE');
    run(c, 3);
    c.keyUp('SPACE');
  };
  /** The first pipe column at or right of the bird, and the rows of its hole. */
  const nextHole = (c: Game): { col: number; first: number; last: number } | null => {
    for (let col = BIRD_COL; col < 40; col++) {
      if (cell(c, 1, col) === 0xa0 || cell(c, 21, col) === 0xa0) {
        const open = [...Array(21).keys()]
          .map((r) => r + 1)
          .filter((r) => cell(c, r, col) !== 0xa0);
        if (open.length > 0) return { col, first: open[0]!, last: open[open.length - 1]! };
      }
    }
    return null;
  };
  /** Presses space when the bird is below the middle of the next hole. */
  const autopilot = (
    c: Game,
    frames: number,
    aim = (h: { first: number; last: number }) => 50 + 8 * h.first + 22,
  ) => {
    for (let i = 0; i < frames; i++) {
      const hole = nextHole(c);
      const target = hole === null ? 110 : aim(hole);
      // tap: SPACE is down on every other frame, because only a fresh press flaps
      if (y(c) > target && i % 2 === 0) c.keyDown('SPACE');
      else c.keyUp('SPACE');
      c.runFrame();
    }
    c.keyUp('SPACE');
  };

  it('opens on a title: sky, ground, a waiting bird', () => {
    const c = newGame();
    toTitle(c);
    expect(text(c, 11, 14, 11)).toBe('PRESS SPACE');
    expect(text(c, 7, 14, 11)).toBe('FLAPPY BIRD');
    expect(c.peek(0xd021) & 15).toBe(14);
    expect(c.peek(0xd015)).toBe(1);
    expect(c.peek(0xd000)).toBe(80);
    expect(y(c)).toBe(100);
    expect(cell(c, 22, 0)).toBe(0xa0);
    expect(cell(c, 24, 39)).toBe(0xa0);
    expect(c.peek(0xd800 + 22 * 40) & 15).toBe(9); // brown ground
    expect(c.peek(0xd800 + 5 * 40 + 20) & 15).toBe(5); // green everywhere else
    expect(c.peek(0x07f8)).toBe(128); // sprite data at $2000
  });

  it('waits for SPACE: the bird does not move until it is pressed', () => {
    const c = newGame();
    run(c, 90);
    expect(y(c)).toBe(100);
    expect(text(c, 11, 14, 11)).toBe('PRESS SPACE');
  });

  it('flaps up, then falls faster and faster', () => {
    const c = newGame();
    toTitle(c);
    c.keyDown('SPACE');
    run(c, 2);
    c.keyUp('SPACE');
    const climb: number[] = [];
    for (let i = 0; i < 40; i++) {
      c.runFrame();
      climb.push(y(c));
    }
    const top = Math.min(...climb);
    expect(top).toBeLessThan(100 - 20);
    const peak = climb.indexOf(top);
    const steps = climb.slice(peak + 1).map((v, i, a) => (i === 0 ? v - top : v - a[i - 1]!));
    expect(steps.every((s) => s >= 0)).toBe(true);
    expect(steps[steps.length - 1]).toBeGreaterThan(steps[0]!);
  });

  it('the ceiling is safe: the VIC-II border idle byte at $3FFF is clear', () => {
    const c = newGame();
    c.pokeRam(0x3fff, 0xff); // a machine that powers up with it set
    toTitle(c);
    tap(c);
    // keep climbing: tap every 12 frames, the bird reaches the ceiling and stays alive
    for (let f = 0; f < 120; f++) {
      if (f % 12 === 0) c.keyDown('SPACE');
      else if (f % 12 === 2) c.keyUp('SPACE');
      c.runFrame();
    }
    expect(c.peek(0x3fff)).toBe(0);
    expect(y(c)).toBeLessThan(70);
    expect(text(c, 9, 15, 9)).not.toBe('GAME OVER');
  });

  it('each tap of SPACE is one flap, holding it is not a flap per frame', () => {
    const c = newGame();
    toTitle(c);
    c.keyDown('SPACE');
    run(c, 60);
    expect(y(c)).toBeGreaterThan(100); // held: one flap only, then it fell
  });

  it('draws pipes with an 8-row hole, scrolling in from the right', () => {
    const c = newGame();
    toTitle(c);
    tap(c);
    autopilot(c, 70);
    const hole = nextHole(c);
    expect(hole).not.toBeNull();
    expect(hole!.last - hole!.first).toBe(7);
    expect(hole!.first).toBeGreaterThanOrEqual(3);
    expect(hole!.first).toBeLessThanOrEqual(10);
    // the column is solid outside the hole, from row 1 down to the ground; row 0 is the score
    for (let r = 1; r < 22; r++) {
      const inHole = r >= hole!.first && r <= hole!.last;
      expect(cell(c, r, hole!.col)).toBe(inHole ? 0x20 : 0xa0);
    }
    expect(cell(c, 22, hole!.col)).toBe(0xa0); // ground untouched
    expect(cell(c, 0, hole!.col)).not.toBe(0xa0);
  });

  it('a pipe that is flown through scores a point', () => {
    const c = newGame();
    toTitle(c);
    tap(c);
    autopilot(c, 900);
    expect(text(c, 9, 15, 9)).not.toBe('GAME OVER');
    expect(score(c)).toBeGreaterThanOrEqual(3);
    for (const col of [38, 39]) {
      expect(cell(c, 0, col)).toBeGreaterThanOrEqual(0x30);
      expect(cell(c, 0, col)).toBeLessThanOrEqual(0x39);
    }
  });

  it('falling to the ground ends the game', () => {
    const c = newGame();
    toTitle(c);
    tap(c);
    run(c, 120);
    expect(text(c, 9, 15, 9)).toBe('GAME OVER');
    expect(text(c, 11, 13, 14)).toBe('SPACE TO RETRY');
  });

  it('flying into a pipe ends the game, in mid-air', () => {
    const c = newGame();
    toTitle(c);
    tap(c);
    // hug the ceiling: every hole starts below row 3, so the first pipe is solid there
    autopilot(c, 400, () => 56);
    expect(text(c, 9, 15, 9)).toBe('GAME OVER');
    expect(y(c)).toBeLessThan(150);
  });

  it('the game over screen waits for SPACE, then a fresh game starts at once', () => {
    const c = newGame();
    toTitle(c);
    tap(c);
    autopilot(c, 400, () => 56);
    expect(text(c, 9, 15, 9)).toBe('GAME OVER');
    run(c, 200); // it stays
    expect(text(c, 9, 15, 9)).toBe('GAME OVER');
    tap(c);
    run(c, 4);
    expect(text(c, 9, 15, 9)).toBe('         '); // cleared
    expect(text(c, 11, 14, 11)).toBe('           '); // and no title the second time
    run(c, 30); // the loops repaint the sky and ground, then the new game is under way
    expect(score(c)).toBe(0);
    expect(y(c)).toBeGreaterThan(60);
    expect(y(c)).toBeLessThan(150);
    expect(text(c, 9, 15, 9)).not.toBe('GAME OVER'); // flying again
    expect(c.peek(0xd015)).toBe(1);
  });
});

describe('showcases are written in plain C64Script', () => {
  for (const id of [
    'character-art',
    'sprite-dance',
    'flappy-bird',
    'rainbow-border',
    'space-invaders',
  ]) {
    it(`${id} has no inline assembly`, () => {
      expect(source(id)).not.toMatch(/\basm\b\s*(clobbers\s*\([^)]*\)\s*)?\{/);
    });
  }
});

describe('showcase: space-invaders', () => {
  const BLOCK = 0xa0;
  const SHOT = 0x2a;
  const cell = (c: C64, r: number, col: number) => c.peek(0x0400 + r * 40 + col);
  const colour = (c: C64, r: number, col: number) => c.peek(0xd800 + r * 40 + col) & 15;
  const run = (c: C64, frames: number) => {
    for (let i = 0; i < frames; i++) c.runFrame();
  };
  const tap = (c: C64, key: 'A' | 'D' | 'SPACE', frames = 1) => {
    c.keyDown(key);
    run(c, frames);
    c.keyUp(key);
  };
  /** Holds the cursor key, with LEFT SHIFT too for the browser's left arrow. */
  const holdArrow = (c: C64, left: boolean, frames: number) => {
    c.keyDown('CRSR_RIGHT');
    if (left) c.keyDown('LSHIFT');
    run(c, frames);
    c.keyUp('CRSR_RIGHT');
    if (left) c.keyUp('LSHIFT');
  };
  /** The game on screen after SPACE starts it from the title. */
  const started = (): C64 => {
    const c = boot(source('space-invaders'), 10);
    tap(c, 'SPACE', 3);
    run(c, 2);
    return c;
  };
  const blocks = (c: C64, rows: number[]) =>
    rows.reduce(
      (n, r) =>
        n +
        Array.from({ length: 40 }, (_, col) => col).filter((col) => cell(c, r, col) === BLOCK)
          .length,
      0,
    );
  const cannonCentre = (c: C64) => {
    const left = Array.from({ length: 40 }, (_, col) => col).find(
      (col) => cell(c, 22, col) === BLOCK,
    );
    return left === undefined ? -1 : left + 1;
  };
  const score = (c: C64) => (cell(c, 0, 38) - 0x30) * 10 + (cell(c, 0, 39) - 0x30);
  const INVADER_ROWS = [3, 5, 7, 9, 11];

  it('draws five rows of eight invaders, each row in its own colour, and the cannon', () => {
    const c = boot(source('space-invaders'), 10);
    expect(blocks(c, INVADER_ROWS)).toBe(120);
    expect(cell(c, 3, 0)).toBe(BLOCK);
    expect(cell(c, 3, 2)).toBe(BLOCK);
    expect(cell(c, 3, 3)).toBe(0x20); // the gap after an invader
    expect(colour(c, 3, 0)).toBe(2); // red
    expect(colour(c, 5, 0)).toBe(8); // orange
    expect(colour(c, 11, 0)).toBe(3); // cyan
    expect(blocks(c, [22])).toBe(3); // the cannon: three block characters
    expect(colour(c, 22, 20)).toBe(5); // green
  });

  it('shows the title until SPACE starts the game', () => {
    const c = boot(source('space-invaders'), 10);
    expect(cell(c, 13, 12)).toBe(19); // S of SPACE INVADERS
    expect(cell(c, 15, 12)).toBe(16); // P of PRESS SPACE
    tap(c, 'SPACE', 3);
    run(c, 2);
    expect(cell(c, 13, 12)).toBe(0x20);
    expect(cell(c, 15, 12)).toBe(0x20);
  });

  it('marches the block sideways and the cannon follows A and D', () => {
    const c = started();
    const row3 = () => Array.from({ length: 40 }, (_, col) => cell(c, 3, col)).join();
    const before = row3();
    run(c, 30);
    expect(row3()).not.toBe(before);

    const x = cannonCentre(c);
    tap(c, 'A', 8);
    const left = cannonCentre(c);
    expect(left).toBeLessThan(x);
    tap(c, 'D', 8);
    expect(cannonCentre(c)).toBeGreaterThan(left);
  });

  it('moves the cannon with the arrow keys as well as A and D', () => {
    const c = started();
    const x = cannonCentre(c);
    holdArrow(c, true, 8);
    const left = cannonCentre(c);
    expect(left).toBeLessThan(x);
    holdArrow(c, false, 8);
    expect(cannonCentre(c)).toBeGreaterThan(left);
  });

  it('fires one bullet at a time and the bullet climbs', () => {
    const c = started();
    const shots = () => {
      let n = 0;
      for (let r = 1; r < 22; r++)
        for (let col = 0; col < 40; col++) if (cell(c, r, col) === SHOT) n++;
      return n;
    };
    c.keyDown('SPACE');
    run(c, 1);
    c.keyUp('SPACE');
    run(c, 1);
    expect(shots()).toBe(1);
    c.keyDown('SPACE');
    run(c, 5); // holding SPACE does not add bullets while one is in flight
    c.keyUp('SPACE');
    expect(shots()).toBe(1);
  });

  it('a shot that hits an invader removes it and adds to the score', () => {
    const c = started();
    let hit = false;
    for (let attempt = 0; attempt < 40 && !hit; attempt++) {
      const bottom = Array.from({ length: 40 }, (_, col) => col).find(
        (col) => cell(c, 11, col) === BLOCK,
      );
      if (bottom === undefined) break;
      for (let i = 0; i < 60 && cannonCentre(c) !== bottom + 1; i++) {
        tap(c, cannonCentre(c) < bottom + 1 ? 'D' : 'A');
      }
      const before = score(c);
      const alive = blocks(c, INVADER_ROWS);
      tap(c, 'SPACE');
      run(c, 22); // the bullet has climbed off the top by now
      hit = score(c) > before;
      if (hit) expect(blocks(c, INVADER_ROWS)).toBeLessThan(alive);
    }
    expect(hit).toBe(true);
    expect(score(c)).toBeGreaterThanOrEqual(1);
  });

  it('loses when the block reaches the cannon, shows GAME OVER and restarts on SPACE', () => {
    const c = started();
    let frames = 0;
    while (cell(c, 13, 14) !== 7 && frames < 4000) {
      run(c, 50);
      frames += 50;
    }
    expect(cell(c, 13, 14)).toBe(7); // G of GAME OVER
    expect(cell(c, 13, 15)).toBe(1); // A
    run(c, 130); // the message stays for a while, then the game waits for SPACE
    tap(c, 'SPACE');
    run(c, 8); // the new block is drawn over a few frames, before its first step
    expect(cell(c, 13, 14)).toBe(0x20);
    expect(blocks(c, INVADER_ROWS)).toBe(120); // a fresh block of 40
    expect(score(c)).toBe(0);
  });
});
