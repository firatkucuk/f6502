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
    hint: 'Click the screen to give it keyboard focus, then press SPACE to flap.',
  },
  {
    id: 'space-invaders',
    title: 'Space Invaders',
    blurb:
      'Shoot the marching block before it reaches your cannon. A and D move, SPACE fires one bullet at a time. The invaders are solid characters, the score is drawn on the top row.',
    hint: 'Click the screen to give it keyboard focus, then press SPACE to start. A and D move the cannon.',
  },
];
