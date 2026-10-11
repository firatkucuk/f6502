// Programs offered in the playground's example dropdown. The first one is the default.
// Every entry is compiled (and the behavioural ones executed) by test/website/examples.test.ts.

export const EXAMPLES = [
  {
    id: 'slideshow',
    title: 'Slideshow',
    source: `// Slideshow: one slide every 3 seconds.
let slide: u8 = 0;

program @ 0x0810 {
  loop {
    clrscr();

    if (slide == 0) {
      VIC2.borderColor = COLOR_BLUE;
      puts(8, 17, "F6502", COLOR_WHITE);
      puts(11, 5, "A COMMODORE 64 IN YOUR BROWSER", COLOR_LIGHT_BLUE);
      puts(14, 7, "CYCLE ACCURATE TYPESCRIPT", COLOR_LIGHT_GREY);
    } else if (slide == 1) {
      VIC2.borderColor = COLOR_PURPLE;
      puts(6, 14, "WHAT IT RUNS", COLOR_WHITE);
      puts(10, 12, "VIC II GRAPHICS", COLOR_YELLOW);
      puts(12, 12, "SID SOUND", COLOR_YELLOW);
      puts(14, 12, "CIA TIMERS", COLOR_YELLOW);
      puts(16, 12, "DISKS AND TAPES", COLOR_YELLOW);
    } else if (slide == 2) {
      VIC2.borderColor = COLOR_GREEN;
      puts(7, 15, "C64SCRIPT", COLOR_WHITE);
      puts(11, 5, "A SMALL LANGUAGE THAT COMPILES", COLOR_LIGHT_GREEN);
      puts(13, 8, "TO 6502 MACHINE CODE", COLOR_LIGHT_GREEN);
      puts(15, 7, "RIGHT IN YOUR BROWSER", COLOR_LIGHT_GREEN);
    } else if (slide == 3) {
      VIC2.borderColor = COLOR_ORANGE;
      puts(8, 13, "THIS SLIDESHOW", COLOR_WHITE);
      puts(11, 7, "IS A FEW LINES OF C64SCRIPT", COLOR_YELLOW);
      puts(13, 9, "SEE THE SOURCE BESIDE IT", COLOR_YELLOW);
    } else {
      VIC2.borderColor = COLOR_RED;
      puts(8, 12, "TRY IT YOURSELF", COLOR_WHITE);
      puts(11, 10, "OPEN THE PLAYGROUND", COLOR_LIGHT_RED);
      puts(13, 13, "PRESS RUN", COLOR_LIGHT_RED);
    }

    // Hold the slide: wait for 150 video frames (3 seconds).
    for (let n: u8 = 0; n < 150; n++) {
      while (VIC2.rasterLine != 200) {}
      while (VIC2.rasterLine == 200) {}
    }

    slide++;
    if (slide == 5) { slide = 0; }
  }
}
`,
  },
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
  puts(14, 9, "WRITTEN IN C64SCRIPT", COLOR_LIGHT_BLUE);

  // A single character: poke it and its colour.
  poke(screen(10, 19), 'H');
  poke(color(10, 19), COLOR_YELLOW);
  loop {}
}
`,
  },
  {
    id: 'asm',
    title: 'Inline assembly',
    source: `// asm {} drops to raw 6502. \${name} brings in program variables and constants.
let @zp ticks: u8 = 0;

program @ 0x0810 {
  // Once: solid blocks everywhere, in eight colour stripes that repeat every 8 columns.
  asm {
    ldx #0
  paint:
    lda #$A0
    sta \${screen(0, 0)},x
    sta \${screen(0, 0) + 256},x
    sta \${screen(0, 0) + 512},x
    sta \${screen(0, 0) + 744},x
    txa
    and #$07          // 0..7 ...
    ora #$08          // ... becomes colours 8..15
    sta \${color(0, 0)},x
    sta \${color(0, 0) + 256},x
    sta \${color(0, 0) + 512},x
    sta \${color(0, 0) + 744},x
    inx
    bne paint
  }

  loop {
    // Change the border only while the beam is below the picture (line 251),
    // so nothing tears.
    while (VIC2.rasterLine != 251) {}
    asm {
      inc \${ticks}
      lda \${ticks}
      lsr a
      lsr a
      and #$0F
      sta $D020
    }
    while (VIC2.rasterLine == 251) {}
  }
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
