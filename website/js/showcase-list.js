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
];
