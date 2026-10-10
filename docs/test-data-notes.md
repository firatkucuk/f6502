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
