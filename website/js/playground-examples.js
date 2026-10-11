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
    source: `// Write HELLO C64 into screen RAM (screen codes) and colour it white
program @ 0x0810 {
  clrscr();
  VIC2.borderColor = BLACK;
  VIC2.bgColor0 = BLACK;

  poke(0x0400 + 495, 8);    // H   row 12, column 15
  poke(0x0400 + 496, 5);    // E
  poke(0x0400 + 497, 12);   // L
  poke(0x0400 + 498, 12);   // L
  poke(0x0400 + 499, 15);   // O
  poke(0x0400 + 501, 3);    // C
  poke(0x0400 + 502, 0x36); // 6
  poke(0x0400 + 503, 0x34); // 4

  poke(0xD800 + 495, WHITE);
  poke(0xD800 + 496, WHITE);
  poke(0xD800 + 497, WHITE);
  poke(0xD800 + 498, WHITE);
  poke(0xD800 + 499, WHITE);
  poke(0xD800 + 501, WHITE);
  poke(0xD800 + 502, WHITE);
  poke(0xD800 + 503, WHITE);
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
