// The showcases that run from C64Script source: website/showcases/<id>.c64s, opened by
// showcase.html?id=<id>. test/website/showcase-sources.test.ts compiles and runs each one.
//
// blurb    — what the program is, shown under the title.
// hint     — one line under the screen: how a game starts and restarts, or what sound needs.
// controls — [keys, what they do] rows listed under the hint. The games draw no key help
//            on the C64 screen; this list is the only place the controls are explained.
export const SHOWCASES = [
  {
    id: 'rainbow-border',
    author: 'firatkucuk',
    title: 'Rainbow Border',
    blurb:
      'The simplest C64Script program: one register, one loop. The border walks through all 16 hardware colours.',
  },
  {
    id: 'character-art',
    author: 'firatkucuk',
    title: 'Character Mode Art',
    blurb:
      'A sunset painted in character mode: one solid-block character and a colour per row, filled across the 40 × 25 screen with two nested loops.',
  },
  {
    id: 'sprite-dance',
    author: 'firatkucuk',
    title: 'Sprite Dance',
    blurb:
      'Eight hardware sprites share one shape and chase each other around a figure of eight. The path is read from a sine table with wave[i].',
  },
  {
    id: 'flappy-bird',
    author: 'firatkucuk',
    title: 'Flappy Bird',
    blurb:
      'Fly through the gaps. The bird is a hardware sprite, the pipes are columns of solid characters, and the VIC-II reports the crash.',
    hint: 'Press SPACE to start; after a crash, SPACE starts again.',
    controls: [['SPACE', 'flap (a fresh press each time)']],
  },
  {
    id: 'space-invaders',
    author: 'firatkucuk',
    title: 'Space Invaders',
    blurb:
      'Shoot the marching block before it reaches your cannon. The invaders are solid characters, the score is drawn on the top row, and one bullet is in the air at a time.',
    hint: 'Press SPACE to start, and again after GAME OVER or YOU WIN.',
    controls: [
      ['A / D or ← →', 'move the cannon'],
      ['SPACE', 'fire'],
    ],
  },
  {
    id: 'asteroid-run',
    author: 'firatkucuk',
    title: 'Asteroid Run',
    blurb:
      'Steer through the field, break apart asteroids and keep your ship from drifting away. You have three lives, and the rocks get faster as the run continues.',
    hint: 'Press SPACE once the prompt appears under the title; SPACE also starts the next run.',
    controls: [
      ['← →', 'turn'],
      ['↑', 'thrust'],
      ['SPACE', 'fire'],
    ],
  },
  {
    id: 'bot-hop',
    author: 'nuricanozturk01',
    title: 'Bot Hop',
    blurb:
      'Nine-level platformer with a surprise at the end. Collect three coins, stomp or shoot the bugs and walk through the green door. Later levels get faster.',
    hint: 'Press SPACE to start, and again to play after GAME OVER.',
    controls: [
      ['A / D or ← →', 'walk'],
      ['SPACE', 'jump (land on a bug to stomp it)'],
      ['F', 'shoot'],
    ],
  },
  {
    id: 'snake',
    author: 'nuricanozturk01',
    title: 'Snake',
    blurb:
      'Eat the red blocks to grow without hitting the walls or yourself. The snake speeds up as it gets longer, and reaching length 100 wins. The body is a circular buffer of row and column pairs.',
    hint: 'Press SPACE to start, and again to play after the game ends.',
    controls: [['W A S D or arrows', 'steer']],
  },
  {
    id: 'blast-maze',
    author: 'nuricanozturk01',
    title: 'Blast Maze',
    blurb:
      'Plant bombs to blast bricks and bugs in a grid maze, and stay out of the flames. Pick up R for more range and B for more bombs, clear every bug to finish a stage. Six stages, three lives.',
    hint: 'Press SPACE to start, and again to play after the game ends.',
    controls: [
      ['W A S D or arrows', 'move'],
      ['SPACE', 'plant a bomb'],
    ],
  },
  {
    id: 'crystal-climb',
    author: 'firatkucuk',
    title: 'Crystal Climb',
    blurb:
      'Climb the cave, collect four gems and reach the exit. Jump between stone ledges, clear the patrolling crawler and keep out of the lava. Three lives, one summit, all in C64Script.',
    hint: 'Press SPACE to start, and again to replay. Collecting every gem opens the exit.',
    controls: [
      ['A / D or ← →', 'walk'],
      ['SPACE', 'jump'],
    ],
  },
  {
    id: 'turbo-sprint',
    author: 'firatkucuk',
    title: 'Turbo Sprint',
    blurb:
      'Race down the highway, dodge traffic and score every overtake. The cars get faster as your score climbs, so keep steering to stay in the race.',
    hint: 'Press SPACE to start; after a crash, SPACE restarts the race.',
    controls: [['A / D or ← →', 'steer']],
  },
  {
    id: 'music-box',
    author: 'firatkucuk',
    title: 'Music Box',
    blurb:
      'A four-bar tune on all three SID voices: a pulse lead, a triangle bass and a sawtooth arpeggio. The notes come from tables read with t[i], and each voice lights up its own lane.',
    hint: 'Click the page or press a key to start the sound.',
    sound: true,
  },
  {
    id: 'street-fighter',
    author: 'nuricanozturk01',
    title: 'Street Fighter',
    blurb:
      'A one-on-one fighting game with four fighters, each with a special move. Multicolor expanded sprites, character-mode stages, SID sound effects and an AI opponent. Play against the computer or a friend on the same keyboard.',
    hint: 'Press 1 for one player or 2 for two, then walk to a fighter card and punch to pick it. Click the page first to start the sound.',
    controls: [
      ['Player 1', 'A / D walk, W jump, S crouch, F punch, G kick'],
      ['Player 2', 'J / L walk, I jump, K crouch, O punch, P kick'],
      ['Block', 'hold back, away from the opponent'],
      ['Special', 'down, forward, punch'],
    ],
    sound: true,
  },
];
