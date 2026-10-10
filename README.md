# f6502

A browser-based 6502 / Commodore 64 emulator in TypeScript. No backend, no runtime dependencies.

Status: the cycle-accurate 6502 core, the C64 machine (memory map, CIAs, keyboard) and a PAL
VIC-II with all graphics modes, sprites, collisions, badline and sprite-DMA CPU stalls, border
opening and sprite crunch, plus the browser layer, are implemented. The VIC-II is checked against
VICE reference screenshots: 10 of the 137 PAL reference tests match pixel for pixel, the others are
tracked in issue #43. Sound, disk/tape media and the demo site are planned (see
`docs/superpowers/specs/`).

## Browser usage

```html
<canvas id="screen"></canvas>
<script src="f6502.min.js"></script>
<script>
  F6502.start({
    canvas: '#screen',
    roms: { kernal: 'kernal.rom', basic: 'basic.rom', chargen: 'chargen.rom' },
    program: 'game.prg', // optional
  });
</script>
```

ROMs are never bundled: supply your own or the free [OpenROMs](https://github.com/MEGA65/open-roms)
(`npm run fetch-test-data` downloads them to `.testdata/openroms/`). Cross-origin URLs need CORS
headers. Try it locally with `npm run build && npm run example`, then open
`http://127.0.0.1:8080/examples/basic.html`.

## Core usage

```ts
import { MOS6502, type Bus } from 'f6502';

const mem = new Uint8Array(0x10000);
const bus: Bus = {
  read: (addr) => mem[addr]!,
  write: (addr, value) => {
    mem[addr] = value;
  },
};

mem[0xfffc] = 0x00;
mem[0xfffd] = 0x02; // reset vector -> $0200
mem.set([0xa9, 0x42, 0x8d, 0x00, 0x03], 0x0200); // LDA #$42 ; STA $0300

const cpu = new MOS6502(bus, {
  onCycle: () => {
    /* tick other chips */
  },
});
cpu.reset();
cpu.step();
cpu.step();
console.log(mem[0x0300]!.toString(16)); // 42
```

Every `bus.read` / `bus.write` call is exactly one CPU cycle.

## Scripts

| Script                     | What it does                                                                      |
| -------------------------- | --------------------------------------------------------------------------------- |
| `npm test`                 | unit tests                                                                        |
| `npm run fetch-test-data`  | download pinned third-party test data into `.testdata/`                           |
| `npm run test:conformance` | Klaus Dormann functional test + SingleStepTests (`SST_FULL=1` for the full set)   |
| `npm run build`            | ESM (`dist/index.js`) + IIFE (`dist/f6502.min.js`, global `F6502`) + `.d.ts`      |
| `npm run lint`             | ESLint (incl. the `core/` boundary rule) + Prettier check                         |
| `npm run typecheck`        | `tsc --noEmit`                                                                    |
| `npm run bench`            | throughput of the core on the Klaus functional test (needs `build` and test data) |
| `npm run example`          | serve the repo so `examples/basic.html` can load the fetched ROMs                 |

## Licence

Apache-2.0. Third-party test data is downloaded at test time and not redistributed.
