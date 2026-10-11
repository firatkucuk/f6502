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
  VIC2.borderColor = COLOR_BLUE;       // LDA #6 ; STA $D020
  VIC2.bgColor0    = COLOR_LIGHT_BLUE; // LDA #14; STA $D021
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
    source: `// puts(row, col, "TEXT", colour) writes text at a screen position.
// 'H' and "HELLO" are screen codes (A = 1 ... Z = 26), uppercase only.
program @ 0x0810 {
  clrscr();
  VIC2.borderColor = COLOR_BLACK;
  VIC2.bgColor0 = COLOR_BLACK;

  puts(12, 15, "HELLO C64", COLOR_WHITE);
  puts(14, 14, "WRITTEN IN C64SCRIPT", COLOR_LIGHT_BLUE);

  // A single character: poke it and its colour.
  poke(screen(10, 20), 'H');
  poke(color(10, 20), COLOR_YELLOW);
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
  VIC2.sprite0color = COLOR_YELLOW;
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
