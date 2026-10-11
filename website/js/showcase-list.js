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
      'A sunset painted in character mode: one solid-block character, a colour per row, and a few lines of inline assembly to fill the 40 × 25 screen.',
  },
  {
    id: 'sprite-dance',
    title: 'Sprite Dance',
    blurb:
      'Eight hardware sprites share one shape and chase each other around a figure of eight. The path is read from a sine table with a few lines of inline assembly.',
  },
  {
    id: 'flappy-bird',
    title: 'Flappy Bird',
    blurb:
      'Fly through the gaps. The bird is a hardware sprite, the pipes are columns of solid characters, and the VIC-II reports the crash.',
    hint: 'Click the screen to give it keyboard focus, then press SPACE to flap.',
  },
];
