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
    id: 'crystal-climb',
    title: 'Crystal Climb',
    blurb:
      'Climb the cave, collect four gems and reach the exit. Jump between stone ledges, clear the patrolling crawler and keep out of the lava. Three lives, one summit, all in C64Script.',
    hint: 'Press SPACE to start or jump. A, D or the left/right arrow keys move. Collect every gem to open the exit.',
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
