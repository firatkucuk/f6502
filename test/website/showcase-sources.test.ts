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
  // "SCORE 00" ends one column in from the right edge, like the HUD of every other game
  const score = (c: Game) => (cell(c, 0, 37) - 0x30) * 10 + (cell(c, 0, 38) - 0x30);
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
    for (const col of [37, 38]) {
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
    'music-box',
    'crystal-climb',
    'turbo-sprint',
  ]) {
    it(`${id} has no inline assembly`, () => {
      expect(source(id)).not.toMatch(/\basm\b\s*(clobbers\s*\([^)]*\)\s*)?\{/);
    });
  }
});

describe('showcase: turbo-sprint', () => {
  const run = (c: C64, frames: number) => {
    for (let i = 0; i < frames; i++) c.runFrame();
  };
  const cell = (c: C64, row: number, col: number) => c.peek(0x0400 + row * 40 + col);
  const text = (c: C64, row: number, col: number, length: number) =>
    Array.from({ length }, (_, i) => cell(c, row, col + i))
      .map((v) => String.fromCharCode(v >= 1 && v <= 26 ? v + 64 : v))
      .join('');
  const cars = (c: C64) => Array.from({ length: 6 }, (_, i) => c.peek(0xd000 + i));
  const x = (c: C64) => c.peek(0xd000);
  const traffic = (c: C64) => [
    { x: c.peek(0xd002), y: c.peek(0xd003) },
    { x: c.peek(0xd004), y: c.peek(0xd005) },
  ];
  const score = (c: C64) =>
    (cell(c, 0, 29) - 0x30) * 100 + (cell(c, 0, 30) - 0x30) * 10 + cell(c, 0, 31) - 0x30;
  const gear = (c: C64) => cell(c, 0, 38) - 0x30;
  const crashed = (c: C64) => text(c, 10, 17, 5) === 'CRASH'; // 5 characters centred: column 17
  const hold = (c: C64, key: 'A' | 'D' | 'SPACE', frames: number) => {
    c.keyDown(key);
    run(c, frames);
    c.keyUp(key);
  };
  const started = (): C64 => {
    const c = boot(source('turbo-sprint'), 90);
    hold(c, 'SPACE', 3);
    // Drawing the field takes multiple emulated frames. Stop as soon as traffic starts.
    for (let f = 0; f < 90 && c.peek(0xd003) === 62; f++) c.runFrame();
    expect(c.peek(0xd003)).toBeGreaterThan(62);
    return c;
  };
  /** Avoid cars nearing the player; distant cars must not force a cut across closer traffic. */
  const driveFrame = (c: C64) => {
    const occupied = traffic(c).filter((car) => car.y > 120 && car.y < 230);
    const safe = [120, 168, 216].filter((lane) =>
      occupied.every((car) => Math.abs(car.x - lane) >= 18),
    );
    safe.sort((a, b) => Math.abs(a - x(c)) - Math.abs(b - x(c)));
    const target = safe[0]!;
    const key = x(c) < target ? 'D' : x(c) > target ? 'A' : undefined;
    if (key) c.keyDown(key);
    c.runFrame();
    if (key) c.keyUp(key);
  };

  it('draws the road, cars and title, then waits for SPACE', () => {
    const c = boot(source('turbo-sprint'), 90);
    expect(c.peek(0xd015)).toBe(1);
    expect(c.peek(0xd000)).toBe(168);
    expect(c.peek(0xd001)).toBe(210);
    expect(text(c, 7, 14, 12)).toBe('TURBO SPRINT'); // 12 characters centred: column 14
    expect(c.peek(0x0400 + 12 * 40 + 14)).toBe(16); // PRESS SPACE
    expect(text(c, 10, 12, 17)).not.toBe('DODGE THE TRAFFIC'); // the how-to lines are on the page
    expect(text(c, 24, 3, 19)).not.toBe('A D OR ARROWS STEER'); // and so is the key help
    expect(c.peek(0x0400 + 3 * 40 + 12)).toBe(0xa0);
    expect(c.peek(0xd800 + 3 * 40 + 12) & 15).toBe(11);
    expect(c.peek(0xd800 + 3 * 40 + 2) & 15).toBe(5);
    expect(traffic(c)).toEqual([
      { x: 216, y: 62 },
      { x: 120, y: 150 },
    ]);
    expect(score(c)).toBe(0);
    expect(gear(c)).toBe(1);
    const before = cars(c);
    hold(c, 'D', 20);
    expect(cars(c)).toEqual(before);
  });

  it('starts on SPACE, moves traffic, and animates the road markings', () => {
    const c = started();
    expect(c.peek(0xd015)).toBe(7);
    expect(text(c, 12, 14, 11)).not.toBe('PRESS SPACE');
    const before = traffic(c);
    const stripes = () =>
      Array.from({ length: 21 }, (_, i) => c.peek(0xd800 + (i + 2) * 40 + 16) & 15);
    const initialStripes = stripes();
    let changed = false;
    for (let f = 0; f < 8; f++) {
      c.runFrame();
      if (stripes().some((hue, i) => hue !== initialStripes[i])) changed = true;
    }
    expect(traffic(c)[0]!.y).toBeGreaterThan(before[0]!.y);
    expect(traffic(c)[1]!.y).toBeGreaterThan(before[1]!.y);
    expect(changed).toBe(true);
    expect(score(c)).toBe(0);
  });

  it('steers with A/D and both cursor directions', () => {
    const c = started();
    const middle = x(c);
    hold(c, 'A', 4);
    const left = x(c);
    expect(left).toBeLessThan(middle);
    hold(c, 'D', 4);
    expect(x(c)).toBe(middle);
    c.keyDown('CRSR_RIGHT');
    run(c, 4);
    c.keyUp('CRSR_RIGHT');
    expect(x(c)).toBeGreaterThan(middle);
    c.keyDown('LSHIFT');
    c.keyDown('CRSR_RIGHT');
    run(c, 4);
    c.keyUp('CRSR_RIGHT');
    c.keyUp('LSHIFT');
    expect(x(c)).toBe(middle);
    expect(crashed(c)).toBe(false);
  });

  it('clamps steering to both edges of the road', () => {
    const right = started();
    hold(right, 'D', 30);
    expect(x(right)).toBe(232);
    expect(crashed(right)).toBe(false);
    const left = started();
    run(left, 50); // let the car initially in the left lane pass first
    hold(left, 'A', 25);
    expect(x(left)).toBe(112);
    expect(crashed(left)).toBe(false);
  });

  it('eventually catches a car parked between either pair of traffic lanes', () => {
    for (const [key, parkedX] of [
      ['A', 144],
      ['D', 192],
    ] as const) {
      const c = started();
      hold(c, key, 8);
      expect(x(c)).toBe(parkedX);
      for (let f = 0; f < 900 && !crashed(c); f++) c.runFrame();
      expect(crashed(c), `a parked car at X=${parkedX} must face traffic`).toBe(true);
    }
  }, 15000);

  it('scores passed cars, recycles them into lanes and increases speed up to third gear', () => {
    const c = started();
    const initialY = c.peek(0xd003);
    run(c, 5);
    const initialDistance = c.peek(0xd003) - initialY;
    expect(initialDistance).toBeGreaterThanOrEqual(8);
    expect(initialDistance).toBeLessThanOrEqual(12);
    let recycled = false;
    let reachedSecond = false;
    let reachedThird = false;
    for (let f = 0; f < 1600 && score(c) < 16 && !crashed(c); f++) {
      const before = traffic(c);
      driveFrame(c);
      for (const [i, car] of traffic(c).entries()) {
        expect(car.x).toBeGreaterThanOrEqual(112);
        expect(car.x).toBeLessThanOrEqual(232);
        if (car.y < before[i]!.y) {
          recycled = true;
          expect(car.y).toBeGreaterThanOrEqual(58);
          expect(car.y).toBeLessThanOrEqual(62);
        }
      }
      if (score(c) >= 5 && score(c) < 10) {
        reachedSecond = true;
        expect(gear(c)).toBe(2);
      }
      if (score(c) >= 10) {
        reachedThird = true;
        expect(gear(c)).toBe(3);
      }
    }
    expect(crashed(c)).toBe(false);
    expect(recycled).toBe(true);
    expect(reachedSecond).toBe(true);
    expect(reachedThird).toBe(true);
    expect(score(c)).toBeGreaterThanOrEqual(16);
    expect(gear(c)).toBe(3);
    for (const col of [29, 30, 31]) {
      expect(cell(c, 0, col)).toBeGreaterThanOrEqual(0x30);
      expect(cell(c, 0, col)).toBeLessThanOrEqual(0x39);
    }
    // Read one car safely away from its wrap point to measure the final traffic speed.
    const sprite = traffic(c)[0]!.y < 205 ? 0 : 1;
    const before = traffic(c)[sprite]!.y;
    for (let f = 0; f < 5; f++) driveFrame(c);
    expect(traffic(c)[sprite]!.y - before).toBeGreaterThan(initialDistance);
  }, 15000);

  it('freezes on a crash and requires a fresh SPACE press to reset the race', () => {
    const c = started();
    for (let f = 0; f < 800 && score(c) < 5 && !crashed(c); f++) driveFrame(c);
    expect(score(c)).toBeGreaterThanOrEqual(5);
    expect(gear(c)).toBe(2);
    c.keyDown('SPACE'); // a held key must not skip the crash message
    const approaching = traffic(c).sort((a, b) => a.y - b.y)[0]!;
    for (let f = 0; f < 150 && !crashed(c); f++) {
      const key = x(c) < approaching.x ? 'D' : x(c) > approaching.x ? 'A' : undefined;
      if (key) c.keyDown(key);
      c.runFrame();
      if (key) c.keyUp(key);
    }
    run(c, 2); // let both message lines finish drawing
    expect(crashed(c)).toBe(true);
    expect(text(c, 12, 13, 14)).toBe('SPACE TO RETRY');
    expect(c.peek(0xd020) & 15).toBe(2);
    const stopped = cars(c);
    const finalScore = score(c);
    hold(c, 'D', 20);
    expect(cars(c)).toEqual(stopped);
    expect(score(c)).toBe(finalScore);
    expect(crashed(c)).toBe(true);
    c.keyUp('SPACE');
    run(c, 3);
    expect(crashed(c)).toBe(true);
    hold(c, 'SPACE', 3);
    for (let f = 0; f < 90 && (c.peek(0xd015) !== 7 || score(c) !== 0); f++) c.runFrame();
    expect(crashed(c)).toBe(false);
    expect(x(c)).toBe(168);
    expect(c.peek(0xd001)).toBe(210);
    expect(score(c)).toBe(0);
    expect(gear(c)).toBe(1);
    expect(c.peek(0xd020) & 15).not.toBe(2);
    const before = c.peek(0xd003);
    run(c, 5);
    expect(c.peek(0xd003)).toBeGreaterThan(before);
  });
});

describe('showcase: crystal-climb', () => {
  const run = (c: C64, frames: number) => {
    for (let i = 0; i < frames; i++) c.runFrame();
  };
  const cell = (c: C64, r: number, col: number) => c.peek(0x0400 + r * 40 + col);
  const x = (c: C64) => c.peek(0xd000) + ((c.peek(0xd010) & 1) << 8);
  const y = (c: C64) => c.peek(0xd001);
  const gems = (c: C64) => cell(c, 0, 23) - 0x30;
  const lives = (c: C64) => cell(c, 0, 38) - 0x30;
  const hold = (c: C64, key: 'A' | 'D' | 'SPACE', frames: number) => {
    c.keyDown(key);
    run(c, frames);
    c.keyUp(key);
  };
  const started = () => {
    const c = boot(source('crystal-climb'), 90);
    hold(c, 'SPACE', 3);
    run(c, 3);
    return c;
  };
  const jump = (c: C64, key: 'A' | 'D', frames: number) => {
    c.keyDown(key);
    c.keyDown('SPACE');
    run(c, frames);
    c.keyUp(key);
    c.keyUp('SPACE');
    run(c, 30);
  };
  const firstLedge = (c: C64) => {
    hold(c, 'D', 12);
    jump(c, 'D', 30);
  };
  const summit = (c: C64, collectSecond: boolean) => {
    firstLedge(c);
    hold(c, 'D', 13);
    jump(c, 'D', collectSecond ? 35 : 20);
    expect(y(c)).toBe(146);
    hold(c, 'A', collectSecond ? 16 : 1);
    jump(c, 'A', 30);
    expect(y(c)).toBe(114);
    hold(c, 'A', 10);
    jump(c, 'A', 24);
    expect(y(c)).toBe(82);
    hold(c, 'D', 8);
    jump(c, 'D', 38);
    expect(y(c)).toBe(66);
    hold(c, 'D', 12);
    run(c, 3);
  };

  it('waits on the title with platforms, gems and three lives', () => {
    const c = boot(source('crystal-climb'), 90);
    expect(cell(c, 13, 13)).toBe(3); // C of CRYSTAL CLIMB: 13 characters centred start at column 13
    expect(cell(c, 17, 13)).toBe(19); // S of SPACE TO START: 14 characters, column 13
    expect(cell(c, 14, 21)).toBe(0xa0); // the ledge on row 14 is not written over by the prompt
    expect(cell(c, 24, 3)).toBe(0x20); // the key help line is on the showcase page now
    expect(cell(c, 22, 1)).toBe(0xa0);
    expect(cell(c, 18, 10)).toBe(0xa0);
    expect(cell(c, 16, 14)).toBe(42); // first gem
    expect(c.peek(0xd015) & 3).toBe(3);
    expect(gems(c)).toBe(0);
    expect(lives(c)).toBe(3);
    const before = [x(c), y(c)];
    run(c, 20);
    expect([x(c), y(c)]).toEqual(before);
  });

  it('moves with A/D and shifted cursor keys, staying inside the screen', () => {
    const c = started();
    const before = x(c);
    hold(c, 'D', 8);
    expect(x(c)).toBeGreaterThan(before);
    hold(c, 'A', 60);
    expect(x(c)).toBe(32);
    c.keyDown('CRSR_RIGHT');
    run(c, 6);
    c.keyUp('CRSR_RIGHT');
    expect(x(c)).toBeGreaterThan(32);
    c.keyDown('LSHIFT');
    c.keyDown('CRSR_RIGHT');
    run(c, 6);
    c.keyUp('CRSR_RIGHT');
    c.keyUp('LSHIFT');
    expect(x(c)).toBe(32);
  });

  it('jumps once per press, falls, and lands back on the ground', () => {
    const c = started();
    const floor = y(c);
    c.keyDown('SPACE');
    run(c, 8);
    expect(y(c)).toBeLessThan(floor - 20);
    run(c, 60);
    expect(y(c)).toBe(floor);
    run(c, 20);
    expect(y(c)).toBe(floor); // holding cannot auto-jump
    c.keyUp('SPACE');
    run(c, 2);
    hold(c, 'SPACE', 6);
    expect(y(c)).toBeLessThan(floor);
  });

  it('lands on a raised platform and collects a gem only once', () => {
    const c = started();
    hold(c, 'D', 12); // approach the first jump, before the patrol
    c.keyDown('D');
    c.keyDown('SPACE');
    run(c, 30);
    c.keyUp('SPACE');
    c.keyUp('D');
    run(c, 25);
    expect(y(c)).toBe(178); // feet on the platform at Y=194
    expect(gems(c)).toBe(1);
    expect(cell(c, 16, 14)).toBe(32);
    run(c, 30);
    expect(gems(c)).toBe(1);
    expect(lives(c)).toBe(3);
  });

  it('a patrol hit costs a life and respawns the climber', () => {
    const c = started();
    c.keyDown('D');
    for (let f = 0; f < 80 && lives(c) === 3; f++) c.runFrame();
    c.keyUp('D');
    run(c, 3);
    expect(lives(c)).toBe(2);
    expect(x(c)).toBeLessThan(80);
    expect(y(c)).toBe(210);
  });

  it('keeps platforms and movement correct across the ninth sprite X bit', () => {
    const c = started();
    firstLedge(c);
    hold(c, 'D', 13);
    jump(c, 'D', 35);
    hold(c, 'D', 18);
    expect(x(c)).toBe(264);
    expect(c.peek(0xd010) & 1).toBe(1);
    expect(y(c)).toBe(146);
    hold(c, 'D', 60);
    run(c, 30);
    expect(x(c)).toBe(324);
    expect(y(c)).toBe(210); // right-hand ground catches a fall
    expect(lives(c)).toBe(3);
  });

  it('lava costs a life without restoring collected gems; game over can restart', () => {
    const c = started();
    firstLedge(c);
    hold(c, 'D', 35);
    run(c, 30);
    expect(lives(c)).toBe(2);
    expect(gems(c)).toBe(1);
    expect(x(c)).toBe(48);
    expect(y(c)).toBe(210);
    c.keyDown('D');
    run(c, 160);
    c.keyUp('D');
    expect(lives(c)).toBe(0);
    expect(cell(c, 12, 15)).toBe(7); // GAME OVER
    const before = [x(c), y(c)];
    run(c, 20);
    expect([x(c), y(c)]).toEqual(before);
    hold(c, 'SPACE', 3);
    run(c, 90);
    expect(lives(c)).toBe(3);
    expect(gems(c)).toBe(0);
    expect(cell(c, 16, 14)).toBe(42);
    expect(cell(c, 12, 15)).toBe(32);
  });

  it('keeps the exit locked until every gem has been collected', () => {
    const c = started();
    summit(c, false);
    expect(gems(c)).toBe(3);
    expect(c.peek(0xd800 + 2 * 40 + 20) & 15).toBe(9); // brown door
    expect(cell(c, 12, 13)).toBe(32); // no victory message
    const before = x(c);
    hold(c, 'A', 4);
    expect(x(c)).toBeLessThan(before); // still playing
  });

  it('can collect every gem, reach the exit, win, and replay', () => {
    const c = started();
    summit(c, true);
    expect(gems(c)).toBe(4);
    expect(lives(c)).toBe(3);
    expect(c.peek(0xd800 + 2 * 40 + 20) & 15).toBe(13); // green door
    expect(cell(c, 12, 13)).toBe(3); // CAVE COMPLETE
    const before = x(c);
    hold(c, 'A', 10);
    expect(x(c)).toBe(before);
    hold(c, 'SPACE', 3);
    run(c, 90);
    expect(gems(c)).toBe(0);
    expect(lives(c)).toBe(3);
    expect(cell(c, 12, 13)).toBe(32);
    expect(x(c)).toBe(48);
    hold(c, 'SPACE', 8);
    expect(y(c)).toBeLessThan(210);
  });
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
  const score = (c: C64) => (cell(c, 0, 37) - 0x30) * 10 + (cell(c, 0, 38) - 0x30);
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
    // 14 characters centred on 40 columns start at column 13; 11 characters at column 14
    expect(cell(c, 13, 13)).toBe(19); // S of SPACE INVADERS
    expect(cell(c, 15, 14)).toBe(16); // P of PRESS SPACE
    expect(cell(c, 13, 12)).toBe(0x20);
    expect(cell(c, 15, 13)).toBe(0x20);
    tap(c, 'SPACE', 3);
    run(c, 2);
    expect(cell(c, 13, 13)).toBe(0x20);
    expect(cell(c, 15, 14)).toBe(0x20);
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
    while (cell(c, 13, 15) !== 7 && frames < 4000) {
      run(c, 50);
      frames += 50;
    }
    expect(cell(c, 13, 15)).toBe(7); // G of GAME OVER (9 characters centred: column 15)
    expect(cell(c, 13, 16)).toBe(1); // A
    expect(cell(c, 15, 14)).toBe(16); // P of PRESS SPACE
    run(c, 130); // the message stays for a while, then the game waits for SPACE
    tap(c, 'SPACE');
    run(c, 8); // the new block is drawn over a few frames, before its first step
    expect(cell(c, 13, 15)).toBe(0x20);
    expect(blocks(c, INVADER_ROWS)).toBe(120); // a fresh block of 40
    expect(score(c)).toBe(0);
  });

  it('with the bottom row shot away, the game lasts until the next row reaches the cannon', () => {
    const c = started();
    const CYAN = 3;
    const GREEN = 5;
    const cells = Array.from({ length: 40 }, (_, col) => col);
    const cyanLeft = () => {
      for (let r = 3; r < 22; r++)
        for (const col of cells)
          if (cell(c, r, col) === BLOCK && colour(c, r, col) === CYAN) return true;
      return false;
    };
    // The lowest invader row on screen, and the centre column of its leftmost invader.
    const lowestTarget = (): [number, number] | undefined => {
      for (let r = 21; r >= 3; r--) {
        const left = cells.find((col) => cell(c, r, col) === BLOCK);
        if (left !== undefined) return [r, left + 1];
      }
      return undefined;
    };
    for (let attempt = 0; attempt < 60 && cyanLeft(); attempt++) {
      const target = lowestTarget();
      if (target === undefined) break;
      const delta = target[1] - cannonCentre(c);
      if (delta !== 0) tap(c, delta > 0 ? 'D' : 'A', 4 * Math.abs(delta)); // one column per 4 frames
      tap(c, 'SPACE');
      run(c, 12); // the bullet reaches the lowest row, or climbs on after a miss
    }
    expect(cyanLeft()).toBe(false);
    let frames = 0;
    while (cell(c, 13, 15) !== 7 && frames < 4000) {
      run(c, 10);
      frames += 10;
    }
    expect(cell(c, 13, 15)).toBe(7); // G of GAME OVER
    // The row left on the cannon's row is the green one: the block kept coming after its cyan
    // row was gone, and lost only when its lowest live row reached the cannon.
    const bottom = cells.filter((col) => cell(c, 22, col) === BLOCK);
    expect(bottom.length).toBeGreaterThan(0);
    for (const col of bottom) expect(colour(c, 22, col)).toBe(GREEN);
  });
});

describe('showcase: asteroid-run', () => {
  const cell = (c: C64, row: number, col: number) => c.peek(0x0400 + row * 40 + col);

  it('compiles and shows the ASCII title, then the start prompt under it', () => {
    expect(compile(source('asteroid-run')).length).toBeGreaterThan(2);
    const splash = boot(source('asteroid-run'), 5);
    expect(cell(splash, 5, 1)).toBe(0x2a); // '*' in the ASTEROID wordmark
    expect(cell(splash, 20, 14)).toBe(0x20); // no prompt yet

    const prompt = boot(source('asteroid-run'), 65);
    expect(cell(prompt, 5, 1)).toBe(0x2a); // the wordmark stays
    expect(cell(prompt, 20, 14)).toBe(16); // P of PRESS SPACE: 11 characters centred, column 14
    expect(cell(prompt, 11, 9)).toBe(0x20); // the key help (UP THRUST ...) is on the page now
  });

  it('starts on SPACE with three lives on the left and the score ending at column 38', () => {
    const c = boot(source('asteroid-run'), 65);
    c.keyDown('SPACE');
    for (let f = 0; f < 4; f++) c.runFrame();
    c.keyUp('SPACE');
    for (let f = 0; f < 20; f++) c.runFrame();
    expect(cell(c, 0, 1)).toBe(0x2a); // first of three '*' lives
    expect(cell(c, 0, 3)).toBe(0x2a);
    expect(cell(c, 0, 36)).toBe(0x30); // SCORE 000 at columns 36..38
    expect(cell(c, 0, 38)).toBe(0x30);
    expect(cell(c, 0, 39)).toBe(0x20);
    expect(cell(c, 20, 14)).toBe(0x20); // the prompt is gone with the splash
  });
});

describe('showcase: bot-hop', () => {
  const cell = (c: C64, row: number, col: number) => c.peek(0x0400 + row * 40 + col);

  it('compiles and shows the title screen', () => {
    expect(compile(source('bot-hop')).length).toBeGreaterThan(2);
    const c = boot(source('bot-hop'), 400);
    expect(cell(c, 8, 8)).toBe(2); // B of BOT HOP 2
    expect(cell(c, 16, 6)).toBe(16); // P of PRESS SPACE
  });

  it('starts level 1 with three lives and three coins on SPACE', () => {
    const c = boot(source('bot-hop'), 400);
    c.keyDown('SPACE');
    for (let f = 0; f < 5; f++) c.runFrame();
    c.keyUp('SPACE');
    for (let f = 0; f < 200; f++) c.runFrame();
    expect(cell(c, 8, 30)).toBe(0x33); // lives
    expect(cell(c, 12, 30)).toBe(0x31); // level 1
    expect(cell(c, 16, 30)).toBe(0x33); // coins left
  });
});

describe('showcase: snake', () => {
  const cell = (c: C64, row: number, col: number) => c.peek(0x0400 + row * 40 + col);

  it('compiles and shows the title screen', () => {
    expect(compile(source('snake')).length).toBeGreaterThan(2);
    const c = boot(source('snake'), 400);
    expect(cell(c, 9, 17)).toBe(0x13); // S of SNAKE: 5 characters centred start at column 17
    expect(cell(c, 15, 14)).toBe(0x10); // P of PRESS SPACE
    expect(cell(c, 11, 8)).toBe(0x20); // the how-to-play lines live on the showcase page now
    expect(cell(c, 0, 1)).toBe(0x13); // the HUD title starts one column in
    expect(cell(c, 0, 9)).toBe(0x20); // no key help on the HUD line
    expect(cell(c, 0, 38)).toBe(0x30); // SCORE 000 ends one column in from the right edge
    expect(cell(c, 0, 30)).toBe(0x13); // S of SCORE
  });

  it('starts on SPACE and moves the head to the right', () => {
    const c = boot(source('snake'), 400);
    c.keyDown('SPACE');
    for (let f = 0; f < 5; f++) c.runFrame();
    c.keyUp('SPACE');
    for (let f = 0; f < 60; f++) c.runFrame();
    expect(c.peek(0x3080 + 2)).toBe(20); // starting head column
    expect(c.peek(0x3080 + 3)).toBe(21); // moved one cell right
  });

  it('hits the right wall when nobody steers, and centres GAME OVER', () => {
    const c = boot(source('snake'), 400);
    c.keyDown('SPACE');
    for (let f = 0; f < 5; f++) c.runFrame();
    c.keyUp('SPACE');
    for (let f = 0; f < 700; f++) c.runFrame();
    expect(cell(c, 10, 15)).toBe(7); // G of GAME OVER (9 characters: column 15)
    expect(cell(c, 12, 10)).toBe(0x13); // S of SPACE TO PLAY AGAIN (19 characters: column 10)
    expect(cell(c, 12, 28)).toBe(0x0e); // N, its last letter, at column 28
  });
});

describe('showcase: blast-maze', () => {
  const cell = (c: C64, row: number, col: number) => c.peek(0x0400 + row * 40 + col);

  it('compiles and shows the title screen', () => {
    expect(compile(source('blast-maze')).length).toBeGreaterThan(2);
    const c = boot(source('blast-maze'), 400);
    expect(cell(c, 6, 14)).toBe(2); // B of BLAST MAZE
    expect(cell(c, 19, 14)).toBe(16); // P of PRESS SPACE
  });

  it('starts stage 1 and plants a bomb on SPACE', () => {
    const c = boot(source('blast-maze'), 400);
    c.keyDown('SPACE');
    for (let f = 0; f < 5; f++) c.runFrame();
    c.keyUp('SPACE');
    for (let f = 0; f < 500; f++) c.runFrame();
    expect(cell(c, 8, 32)).toBe(0x33); // lives
    expect(cell(c, 12, 32)).toBe(0x31); // stage 1
    expect(c.peek(0x3606)).toBe(0); // no bomb yet
    c.keyDown('SPACE');
    for (let f = 0; f < 3; f++) c.runFrame();
    c.keyUp('SPACE');
    const timer = c.peek(0x3606);
    expect(timer).toBeGreaterThan(0);
    expect(timer).toBeLessThanOrEqual(90);
  });
});

describe('showcase: music-box', () => {
  // The program writes the SID registers. They are write-only on the bus, so the tests read the
  // register file the chip keeps (after letting it catch up with the writes).
  const FRAMES_PER_STEP = 7;
  const SID_CLOCK = 985248;
  /** The SID frequency register for the note `semitones` above F2 (the program's note table). */
  const freq = (semitones: number) =>
    Math.round((87.3071 * 2 ** (semitones / 12) * 16777216) / SID_CLOCK);
  const sidReg = (c: C64, reg: number): number => {
    c.sid.peek(0); // catch up with the queued writes
    return (c.sid as unknown as { regs: Uint8Array }).regs[reg]!;
  };
  const voiceFreq = (c: C64, voice: number) =>
    sidReg(c, voice * 7) | (sidReg(c, voice * 7 + 1) << 8);
  const cell = (c: C64, row: number, col: number) => c.peek(0x0400 + row * 40 + col);
  const colour = (c: C64, row: number, col: number) => c.peek(0xd800 + row * 40 + col) & 15;
  const run = (c: C64, frames: number) => {
    for (let i = 0; i < frames; i++) c.runFrame();
  };
  /** Boots, then runs to the first frame where the lead voice's gate goes on (a step begins). */
  const atFirstStep = (): C64 => {
    const c = boot(source('music-box'), 0);
    for (let i = 0; i < 90 && (sidReg(c, 4) & 1) === 0; i++) c.runFrame();
    return c;
  };

  it('compiles', () => {
    expect(compile(source('music-box')).length).toBeGreaterThan(2);
  });

  it('draws the title and the lane labels', () => {
    const c = boot(source('music-box'), 10);
    const text = (row: number, col: number, len: number) =>
      Array.from({ length: len }, (_, i) => cell(c, row, col + i));
    // S I D, space, M U S I C: screen codes are the letter's place in the alphabet
    expect(text(1, 13, 3)).toEqual([19, 9, 4]);
    expect(cell(c, 5, 0)).toBe(12); // L of LEAD
    expect(cell(c, 10, 0)).toBe(2); // B of BASS
    expect(cell(c, 15, 0)).toBe(1); // A of ARP
  });

  it('sets the volume and the voices up', () => {
    const c = atFirstStep();
    expect(sidReg(c, 0x18) & 15).toBe(15);
    expect(sidReg(c, 0x03)).toBe(0x08); // lead pulse width
    expect(sidReg(c, 4) & 0xf0).toBe(0x40); // pulse wave
    expect(sidReg(c, 11) & 0xf0).toBe(0x10); // bass: triangle
    expect(sidReg(c, 18) & 0xf0).toBe(0x20); // arpeggio: sawtooth
  });

  it('plays the first chord on all three voices', () => {
    const c = atFirstStep();
    expect(voiceFreq(c, 0)).toBe(freq(35)); // lead: E5
    expect(voiceFreq(c, 1)).toBe(freq(4)); // bass: A2
    expect(voiceFreq(c, 2)).toBe(freq(16)); // arpeggio: A3
    for (const ctrl of [4, 11, 18]) expect(sidReg(c, ctrl) & 1).toBe(1);
  });

  it('releases the notes before the next step', () => {
    const c = atFirstStep();
    run(c, 6);
    for (const ctrl of [4, 11, 18]) expect(sidReg(c, ctrl) & 1).toBe(0);
    run(c, FRAMES_PER_STEP - 6 + 1); // the next step starts; the arpeggio never rests
    expect(sidReg(c, 18) & 1).toBe(1);
  });

  it('plays a tune: many different lead notes, and it repeats after 64 steps', () => {
    const c = atFirstStep();
    const first = voiceFreq(c, 0);
    const seen = new Set<number>();
    for (let i = 0; i < 64 * FRAMES_PER_STEP; i++) {
      c.runFrame();
      seen.add(voiceFreq(c, 0));
    }
    expect(seen.size).toBeGreaterThanOrEqual(5);
    expect(voiceFreq(c, 0)).toBe(first);
  });

  it('lights the lead lane at the pitch of the note, and fades it', () => {
    const c = atFirstStep();
    run(c, 2); // the lead lane is drawn one frame after the notes start
    expect(cell(c, 6, 35)).toBe(0xa0); // E5 is note 36: column 35
    expect(colour(c, 6, 35)).toBe(1); // white while fresh
    run(c, 4 * FRAMES_PER_STEP);
    expect(colour(c, 6, 35)).toBe(11); // dark grey trail after a few steps
    run(c, 3 * FRAMES_PER_STEP);
    expect(cell(c, 6, 35)).toBe(0x20); // gone
  });

  it('starts with dark lanes even when RAM holds leftovers', () => {
    const prg = compile(source('music-box'));
    const load = prg[0]! | (prg[1]! << 8);
    const c = new C64({
      kernal: new Uint8Array(8192).fill(0xea),
      basic: new Uint8Array(8192),
      chargen: new Uint8Array(4096),
    });
    for (let i = 2; i < prg.length; i++) c.pokeRam(load + i - 2, prg[i]!);
    for (let i = 0; i < 120; i++) c.pokeRam(0x2200 + i, 0xff); // the lane heat table
    c.cpu.regs.pc = load;
    run(c, 4); // past the set-up, before the first step has drawn anything
    for (const row of [6, 11, 16]) {
      const lit = Array.from({ length: 40 }, (_, col) => cell(c, row, col)).filter(
        (v) => v === 0xa0,
      );
      expect(lit.length).toBeLessThanOrEqual(1);
    }
  });

  it('moves the chord highlight along: Am, then F', () => {
    const c = atFirstStep();
    run(c, 2);
    expect(colour(c, 21, 4)).toBe(1); // AM is white
    expect(colour(c, 21, 14)).toBe(11);
    run(c, 16 * FRAMES_PER_STEP + 2);
    expect(colour(c, 21, 4)).toBe(11);
    expect(colour(c, 21, 14)).toBe(1); // F is white
  });
});

describe('showcase: street-fighter', () => {
  const cell = (c: C64, row: number, col: number) => c.peek(0x0400 + row * 40 + col);

  it('compiles and shows the title screen', () => {
    expect(compile(source('street-fighter')).length).toBeGreaterThan(2);
    const c = boot(source('street-fighter'), 400);
    expect(cell(c, 5, 13)).toBe(0x13); // S of STREET FIGHTER
    expect(cell(c, 8, 12)).toBe(0x10); // P of PRESS 1 OR 2
  });
});
