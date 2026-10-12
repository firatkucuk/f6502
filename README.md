# f6502

A browser-based 6502 / Commodore 64 emulator in TypeScript. No backend, no runtime dependencies.

Status: the cycle-accurate 6502 core, the C64 machine (memory map, CIAs, keyboard), a PAL VIC-II
(all graphics modes, sprites, badline and sprite-DMA CPU stalls, border opening, sprite crunch), a
clean-room SID (6581 and 8580 models) with `AudioWorklet` playback via `start({ audio: true })`,
disk and tape media, and the browser layer are implemented. Disks are D64 (read and write, with
export), T64, P00 and PRG, served by a KERNAL-level trap on device 8 (`LOAD`, `SAVE`, directory
listing, sequential files, the DOS command channel); fast loaders and copy protection that bypass
the KERNAL do not work, and there is no REL support. Tapes are TAP files played pulse by pulse into
CIA1 (the standard KERNAL loader is verified end to end; turbo loaders are untested), with warp while
the motor runs; there is no tape recording.
The VIC-II is checked against VICE reference screenshots (14 of 137 match pixel for pixel, the rest
are tracked in #43) and the SID against the VICE SID test programs (17 self-checking programs pass;
the rest are tracked in #52). Combined waveforms and the 6581 filter curve are documented
approximations. The showcase site is served from `website/` and deployed to GitHub Pages.

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

## Creating C64Script games

Scaffold and verify a playable game with the repo's CLI:

```sh
npm run c64script -- new games/my-game --template sprite
npm run c64script -- check games/my-game/game.c64s
npm run c64script -- run games/my-game/game.c64s --frames 120
npm run c64script -- test games/my-game/game.c64s --scenario games/my-game/game.scenario.json
```

Run `npm run build` first in a clean checkout. See [the C64Script game guide](docs/c64script-games.md)
for scenario authoring, JSON output, and browser preview.

## Scripts

| Script                           | What it does                                                                      |
| -------------------------------- | --------------------------------------------------------------------------------- |
| `npm test`                       | unit tests                                                                        |
| `npm run fetch-test-data`        | download pinned third-party test data into `.testdata/`                           |
| `npm run test:conformance`       | Klaus Dormann functional test + SingleStepTests (`SST_FULL=1` for the full set)   |
| `npm run build`                  | ESM (`dist/index.js`) + IIFE (`dist/f6502.min.js`, global `F6502`) + `.d.ts`      |
| `npm run lint`                   | ESLint (incl. the `core/` boundary rule) + Prettier check                         |
| `npm run typecheck`              | `tsc --noEmit`                                                                    |
| `npm run bench`                  | throughput of the core on the Klaus functional test (needs `build` and test data) |
| `npm run example`                | serve the repo so `examples/basic.html` can load the fetched ROMs                 |
| `npm run c64script -- <command>` | scaffold, compile, run, and behavior-test C64Script games                         |

## Licence

Apache-2.0. Third-party test data is downloaded at test time and not redistributed.
