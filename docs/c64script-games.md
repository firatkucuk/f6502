# Building games with C64Script

This guide is the supported workflow for creating, checking, and testing C64Script games with an
AI agent or a human author. It uses the repo's compiler, stub ROMs, deterministic runner, and
scenario format; no extra packages are required.

## Start a game

From the repository root, scaffold a starter game:

```sh
npm run c64script -- new games/my-game --template sprite
```

The command creates `game.c64s` and `game.scenario.json`. It refuses to overwrite either file.
The starter is a small keyboard game with its important state exposed at documented memory
addresses. Use it as a runnable reference, then change the gameplay and its scenario together.

Build the library and check the source before running it:

```sh
npm run build
npm run c64script -- check games/my-game/game.c64s
```

`check` compiles the program and reports its byte count and load address. Compiler errors include
their source location. The game runner expects the usual showcase load address, `$0810`.

## Build, run, and test

Create a PRG for a real C64 or another emulator:

```sh
npm run c64script -- build games/my-game/game.c64s --out games/my-game/game.prg
```

Run the game for 60 frames (or pass `--frames N`) on the deterministic emulator:

```sh
npm run c64script -- run games/my-game/game.c64s --frames 120
```

Run the behavior scenario:

```sh
npm run c64script -- test games/my-game/game.c64s --scenario games/my-game/game.scenario.json
```

All commands accept `--json` for structured output. A missing build output produces an actionable
`npm run build` message. `npm test` builds first and includes the runner, scenario, CLI, and starter
game tests.

## Write deterministic scenarios

A scenario is JSON with version 1, a total frame budget, and an ordered list of steps:

```json
{
  "version": 1,
  "maxFrames": 240,
  "steps": [
    { "waitForText": { "contains": "TITLE", "maxFrames": 5 } },
    { "keyDown": "SPACE" },
    { "frames": 2 },
    { "keyUp": "SPACE" },
    { "assertMemory": { "address": 3840, "equals": 1 } },
    { "assertText": { "contains": "PLAYING" } }
  ]
}
```

Supported steps are `frames`, `keyDown`, `keyUp`, `waitForText`, `assertText`, and `assertMemory`.
Key names are the `C64Key` names in `src/machine/keyboard.ts` (for example `SPACE`, `A`, and `D`).
Pair each `keyDown` with a `keyUp`; a key stays held across frame steps. Every wait has a local
frame limit and every scenario has a total `maxFrames` limit. Assertions inspect the current state
without advancing time. Put game mode, player position, score, or other useful state in documented
fixed RAM locations outside the compiled code and any data tables. Screen text assertions make
failures easier to understand; memory assertions make state transitions precise.

The scenario runner uses the committed stub ROMs and the same READY/SYS startup path as the website.
It verifies behavior, not rendered pixels. Use the website preview for a visual smoke test:

```sh
npm run example
```

Open `http://127.0.0.1:8080/`, then use the C64Script editor/preview. For a new showcase, also add
its source, list entry, showcase card and screenshot, and a focused test as described in
`AGENTS.md`.

## C64Script authoring notes

- Start the only program block at `program @ 0x0810`.
- Read `website/c64script.html` for supported syntax and the `website/showcases/` programs for
  complete examples. `flappy-bird.c64s` shows keyboard input and sprite motion;
  `space-invaders.c64s` demonstrates keyboard-matrix scanning and collision checks;
  `crystal-climb.c64s` shows more involved platform movement; `sprite-dance.c64s` demonstrates
  sprites and lookup tables.
- Keep fixed data and state outside the emitted code. The build command reports code size; reserve
  address ranges deliberately and keep sprite data 64-byte aligned below `$4000`.
- The stub character set includes A–Z, digits, spaces, `*`, `.`, and solid block `$A0`. Use screen
  and colour RAM for block art.
- Synchronize real-time animation to the raster, typically by waiting for line 200 and then waiting
  for it to pass.
- For movement and collisions, update coordinates once per frame and check bounds before changing
  screen or sprite state. Keep collision results in a small state flag when a scenario needs to
  assert them. Write a bounds check as one condition, `if (x + 18 > ex && x < er) { … }`, rather
  than nested `if` statements; `&&`, `||` and `!` short-circuit and compile to the same branches.
- Avoid runtime multiplication; use additions and lookup tables. Use `asm {}` only when the
  compiler's supported language cannot express a needed instruction sequence.
