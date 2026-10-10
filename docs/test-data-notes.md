# Test data notes

Third-party test data is never vendored. `npm run fetch-test-data` downloads it from
commit SHAs pinned in `scripts/test-data.json` (SHA-256 per file) into the git-ignored
`.testdata/` folder. `node scripts/fetch-test-data.mjs --pin` re-resolves HEAD and rewrites
the manifest.

## Klaus Dormann 6502 functional tests

- Repo: `Klaus2m5/6502_65C02_functional_tests`, GPL-3.0 (hence not vendored).
- Upstream ships a prebuilt binary **only for the functional test**
  (`bin_files/6502_functional_test.bin` plus its `.lst`).
- The decimal and interrupt tests are source-only (`.a65`, AS65 syntax). The bundled `as65`
  is a 32-bit Linux ELF and could not be executed on the development machine (no 32-bit
  loader). Their runners are therefore optional: assemble them with AS65
  (`-l -m -s2 -w -h0`, see each source header) and place `6502_decimal_test.bin` /
  `6502_interrupt_test.bin` in `.testdata/klaus/bin_files/` to enable them.
- Decimal-mode correctness is covered independently by the SingleStepTests (random `P`
  including the `D` flag); interrupt timing by `test/core/interrupts.test.ts`.

## SingleStepTests/65x02

- Repo: `SingleStepTests/65x02`, licence MIT, directory `6502/v1/`.
- 256 files (`00.json` ... `ff.json`), 10,000 tests each, about 1.1 GB total on disk.
- Each test gives initial/final CPU and RAM state and the per-cycle bus trace.
- The README documents no unstable-opcode exceptions; any opcode skipped by the runner must
  be justified in `test/conformance/singlestep-skip.json`.

## OpenROMs (MEGA65/open-roms)

- Used for the C64 boot/typing/PRG conformance tests and as the default ROMs of the demo.
- Pinned in `scripts/test-data.json`; fetched files: `bin/kernal_generic.rom` (8192 B),
  `bin/basic_generic.rom` (8192 B), `bin/chargen_openroms.rom` (4096 B), plus `LICENSE`/`COPYING`.
- Licence: GNU LGPL v3 or later (copyright Paul Gardner-Stephen 2019, Roman Standzikowski 2019-2021;
  see the fetched `LICENSE`). Redistributing the binaries is permitted under the LGPL provided the
  licence notice travels with them and the corresponding source is available (the pinned upstream
  commit). The binaries are still **not vendored** in this repository; the demo-site phase must
  include the notice and a link to the pinned source when it hosts them.
- Use the generic KERNAL with the generic BASIC; the CHARGEN image is interchangeable.

## VICE test programs (libsidplayfp/VICE-testprogs)

- Source of the VIC-II reference-screenshot tests used by `test/conformance/vice.test.ts`.
- Pinned in `scripts/test-data.json`. The file list (PAL `VICII/<dir>/<name>.prg` and the matching
  `VICII/<dir>/references/<name>.prg.png`, NTSC variants excluded) is resolved at pin time through
  the GitHub contents API (token from `GITHUB_TOKEN` or `gh auth token`) and stored in the manifest,
  so verification needs no listing. About 137 reference images, 1.7 MB in total.
- References are 384x272 RGB(A) in the Pepto palette, which our framebuffer uses, so frames compare
  exactly. Selection and expectations live in `test/conformance/vice-tests.json`.
- Licence: the programs are distributed with VICE (GPL-2.0-or-later). They are **not vendored**;
  only fetched into the git-ignored `.testdata/`.
