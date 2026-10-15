// The showcases that run from C64Script source: website/showcases/<id>.c64s, opened by
// showcase.html?id=<id>. test/website/showcase-sources.test.ts compiles and runs each one.
export const SHOWCASES = [
  {
    id: 'rainbow-border',
    title: 'Rainbow Border',
    blurb:
      'The simplest C64Script program: one register, one loop. The border walks through all 16 hardware colours.',
  },
  {
    id: 'character-art',
    title: 'Character Mode Art',
    blurb:
      'A sunset painted in character mode: one solid-block character and a colour per row, filled across the 40 × 25 screen with two nested loops.',
  },
  {
    id: 'sprite-dance',
    title: 'Sprite Dance',
    blurb:
      'Eight hardware sprites share one shape and chase each other around a figure of eight. The path is read from a sine table with wave[i].',
  },
  {
    id: 'flappy-bird',
    title: 'Flappy Bird',
    blurb:
      'Fly through the gaps. The bird is a hardware sprite, the pipes are columns of solid characters, and the VIC-II reports the crash.',
    hint: 'Press SPACE to flap.',
  },
  {
    id: 'space-invaders',
    title: 'Space Invaders',
    blurb:
      'Shoot the marching block before it reaches your cannon. A, D or the arrow keys move, SPACE fires one bullet at a time. The invaders are solid characters, the score is drawn on the top row.',
    hint: 'Press SPACE to start. A, D or the arrow keys move the cannon.',
  },
  {
    id: 'asteroid-run',
    title: 'Asteroid Run',
    blurb:
      'Steer through the field, break apart asteroids and keep your ship from drifting away. You have three lives, and the rocks get faster as the run continues.',
    hint: 'Press SPACE to start. LEFT/RIGHT turn, UP thrusts, SPACE fires.',
  },
  {
    id: 'bot-hop',
    title: 'Bot Hop',
    blurb:
      'Nine-level platformer with a surprise at the end. Collect three coins, stomp or shoot the bugs and walk through the green door. Later levels get faster.',
    hint: 'Press SPACE to start. A, D or the arrow keys move, SPACE jumps, F shoots.',
  },
  {
    id: 'snake',
    title: 'Snake',
    blurb:
      'Eat the red blocks to grow without hitting the walls or yourself. The snake speeds up as it gets longer, and reaching length 100 wins. The body is a circular buffer of row and column pairs.',
    hint: 'Press SPACE to start. W, A, S, D or the arrow keys steer.',
  },
  {
    id: 'blast-maze',
    title: 'Blast Maze',
    blurb:
      'Plant bombs to blast bricks and bugs in a grid maze. Pick up R for more range and B for more bombs, clear every bug to finish a stage. Six stages, three lives.',
    hint: 'Press SPACE to start. W, A, S, D or the arrow keys move, SPACE plants a bomb.',
  },
  {
    id: 'crystal-climb',
    title: 'Crystal Climb',
    blurb:
      'Climb the cave, collect four gems and reach the exit. Jump between stone ledges, clear the patrolling crawler and keep out of the lava. Three lives, one summit, all in C64Script.',
    hint: 'Press SPACE to start or jump. A, D or the left/right arrow keys move. Collect every gem to open the exit.',
  },
  {
    id: 'turbo-sprint',
    title: 'Turbo Sprint',
    blurb:
      'Race down the highway, dodge traffic and score every overtake. The cars get faster as your score climbs, so keep steering to stay in the race.',
    hint: 'Press SPACE to start or restart. A, D or the left/right arrow keys steer. Dodge traffic and score by overtaking cars.',
  },
  {
    id: 'music-box',
    title: 'Music Box',
    blurb:
      'A four-bar tune on all three SID voices: a pulse lead, a triangle bass and a sawtooth arpeggio. The notes come from tables read with t[i], and each voice lights up its own lane.',
    hint: 'Click the page or press a key to start the sound.',
    sound: true,
  },
];
