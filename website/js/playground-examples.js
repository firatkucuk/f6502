// Programs offered in the playground's example dropdown. The first one is the default.
// Every entry is compiled (and the behavioural ones executed) by test/website/examples.test.ts.

export const EXAMPLES = [
  {
    id: 'rainbow',
    title: 'Rainbow border',
    source: `// Cycle the border through all 16 C64 colours
let @zp color: u8 = 0;
let @zp ticks: u8 = 0;

program @ 0x0810 {
  loop {
    // wait for one video frame
    while (VIC2.rasterLine != 200) {}
    while (VIC2.rasterLine == 200) {}

    ticks = ticks + 1;
    if (ticks == 5) {
      ticks = 0;
      color = color + 1;
      if (color == 16) { color = 0; }
      VIC2.borderColor = color;
    }
  }
}
`,
  },
  {
    id: 'colors',
    title: 'Colour constants',
    source: `// Colour constants compile to immediates
program @ 0x0810 {
  VIC2.borderColor = BLUE;       // LDA #6 ; STA $D020
  VIC2.bgColor0    = LIGHT_BLUE; // LDA #14; STA $D021
  loop {}
}
`,
  },
  {
    id: 'function',
    title: 'Function call',
    source: `// A function without parameters, called from the main loop
let @zp shade: u8 = 0;

fn nextShade(): void {
  shade = shade + 1;
  if (shade == 16) { shade = 0; }
}

program @ 0x0810 {
  loop {
    while (VIC2.rasterLine != 200) {}
    while (VIC2.rasterLine == 200) {}
    nextShade();
    VIC2.bgColor0 = shade;
  }
}
`,
  },
  {
    id: 'hello',
    title: 'Text on screen',
    source: `// Write HELLO C64 into screen RAM (screen codes) and colour it white.
// screen(row, col) / color(row, col) turn a position into an address at compile time.
program @ 0x0810 {
  clrscr();
  VIC2.borderColor = BLACK;
  VIC2.bgColor0 = BLACK;

  poke(screen(12, 15), 8);    // H
  poke(screen(12, 16), 5);    // E
  poke(screen(12, 17), 12);   // L
  poke(screen(12, 18), 12);   // L
  poke(screen(12, 19), 15);   // O
  poke(screen(12, 21), 3);    // C
  poke(screen(12, 22), 0x36); // 6
  poke(screen(12, 23), 0x34); // 4

  poke(color(12, 15), WHITE);
  poke(color(12, 16), WHITE);
  poke(color(12, 17), WHITE);
  poke(color(12, 18), WHITE);
  poke(color(12, 19), WHITE);
  poke(color(12, 21), WHITE);
  poke(color(12, 22), WHITE);
  poke(color(12, 23), WHITE);
  loop {}
}
`,
  },
  {
    id: 'sprite',
    title: 'Moving sprite',
    source: `// A hollow-box sprite crossing the screen
data @addr(0x0D40) {
  box: [u8; 63] = [
    0xFF, 0xFF, 0xFF,
    0x80, 0x00, 0x01,
    0x80, 0x00, 0x01,
    0x80, 0x00, 0x01,
    0x80, 0x00, 0x01,
    0x80, 0x00, 0x01,
    0x80, 0x00, 0x01,
    0x80, 0x00, 0x01,
    0x80, 0x00, 0x01,
    0x80, 0x00, 0x01,
    0x80, 0x00, 0x01,
    0x80, 0x00, 0x01,
    0x80, 0x00, 0x01,
    0x80, 0x00, 0x01,
    0x80, 0x00, 0x01,
    0x80, 0x00, 0x01,
    0x80, 0x00, 0x01,
    0x80, 0x00, 0x01,
    0x80, 0x00, 0x01,
    0x80, 0x00, 0x01,
    0xFF, 0xFF, 0xFF,
  ];
}

let @zp x: u8 = 24;

program @ 0x0810 {
  poke(0x07F8, 53);          // sprite 0 data at $0D40 (53 * 64)
  VIC2.spriteEnable = 1;
  VIC2.sprite0color = YELLOW;
  VIC2.sprite0y = 120;

  loop {
    while (VIC2.rasterLine != 200) {}
    while (VIC2.rasterLine == 200) {}
    VIC2.sprite0x = x;
    x = x + 1;
  }
}
`,
  },
];
