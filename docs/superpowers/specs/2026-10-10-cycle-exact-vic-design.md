# f6502 sub-project 4: cycle-exact VIC-II (BA/AEC stalls, badlines, borders, sprite quirks)

Date: 2026-10-10
Status: draft, awaiting review
Parent: the project decomposition in `docs/superpowers/specs/2026-10-10-6502-core-design.md`
section 1 (this is sub-project 4 of 6). Builds on
`docs/superpowers/specs/2026-10-10-vic-ii-complete-design.md` and carries over the items tracked
in issue #34.

## 1. Goal and context

Make the VIC-II cycle-exact for PAL (6569): the CPU is held on read cycles when the VIC takes the
bus (badlines and sprite DMA), every VIC access happens in its documented cycle, the border is
produced by the real flip-flop rules (so border opening works), and the sprite quirks that demos
rely on (crunch, MCBASE behaviour) are reproduced. The work must be verified against independent
references, not only against the document it implements.

### Decisions made

- **Approach A:** a faithful per-cycle schedule built from Bauer's cycle table plus a small optional
  CPU `rdy` hook in `core/`. The CPU idles on read cycles while BA is low; writes proceed (the real
  6510 behaviour, which gives the "three write cycles after BA low" rule for free).
- **Verification (option 1):** our own timing tests plus a curated third-party subset with
  reference screenshots (VICE testprogs), compared through a small PNG-based harness.
- PAL only. Target chip behaviour: 6569R3.

## 2. Scope

In scope:
- `CpuHooks.rdy()` in `core/` and its stall semantics.
- A per-cycle access schedule table, the BA signal (badline and sprite DMA), c-access/g-access
  timing, and VIC register write latency.
- Per-cycle badline condition evaluation (FLD, FLI, DMA delay), sequencer corrections.
- Border main/vertical flip-flops (side and top/bottom border opening).
- Sprite crunch, MCBASE 6-bit counter and power-on value, shifter and border-collision fixes from
  #34, raster IRQ cycle exactness.
- CIA corner cases only where a selected reference test needs them.
- A pinned, selectively fetched VICE test subset and the harness to compare against its reference
  images.

Out of scope: NTSC and 6567/8565 differences, light pen, DRAM refresh, sub-cycle (phi1/phi2) sprite
collision timing, SID, media, CI, the Pages site.

## 3. The CPU stall model (core change)

```ts
interface CpuHooks {
  onCycle?(): void;
  /** Return false while the CPU must be held (BA low). Consulted before every bus READ. */
  rdy?(): boolean;
}
```

Inside `MOS6502.read()`, before issuing a read, while `rdy()` is false the CPU performs an idle
cycle: no bus access, `cycles++`, `onCycle()` is called, the interrupt lines are sampled as at the
end of any cycle. Then the read happens. Writes never wait. Every read is held, including the
dummy reads of indexed and RMW instructions, vector fetches, stack pulls and the opcode fetch.

- `step()` returns the cycles consumed including stalls, so `cpu.cycles` is the true cycle count.
- If `rdy()` stays false for more than 4096 consecutive cycles the CPU proceeds anyway (a guard
  against a machine bug hanging a frame).
- With no hook the core behaves exactly as before: all existing CPU unit tests, the Klaus test and
  the SingleStepTests vectors pass unmodified.
- The machine passes `rdy: () => !vic.baLow`; the VIC computes BA for the *next* cycle at the end
  of its `tick()`.

## 4. Access schedule, BA and register timing

PAL cycle schedule (one table, `src/machine/vic-schedule.ts`):

| Cycles | Access |
|---|---|
| 1-10 | sprite pointer/data fetch for sprites 3-7 (2 cycles each: 1-2, 3-4, 5-6, 7-8, 9-10) |
| 11-15 | DRAM refresh (not modelled) |
| 15-54 | c-access (video matrix + colour RAM) while a badline is active |
| 16-55 | g-access |
| 58-63 | sprite fetch for sprites 0-2 (58-59, 60-61, 62-63) |

BA for the upcoming cycle:
- **Badline:** if the badline condition is true at a cycle in 12-54 and BA is not already low, BA
  goes low then and stays low through cycle 54. c-accesses start 3 cycles after BA went low, never
  before cycle 15. A badline costs a read-only CPU 43 cycles (40 when it is inside a run of three
  writes).
- **Sprites:** a sprite with DMA on holds BA low from 3 cycles before its first access to its last:
  s0 55-59, s1 57-61, s2 59-63, s3 61-2, s4 63-4, s5 2-6, s6 4-8, s7 6-10 (windows wrap across the
  line boundary). BA is the union of all windows.

Register timing: a CPU write lands in phi2 of its cycle and the VIC sees it in phi1 of the next, so
VIC register writes are latched and applied after the current cycle's logic. A CPU read sees the
state after the previous cycle.

Raster IRQ: the raster counter and compare flag change at the first cycle of a line (cycle 2 for
line 0); the edge semantics from earlier sub-projects stay.

## 5. Graphics sequencer (Bauer 3.7)

- The badline condition is evaluated every cycle: raster in `$30-$F7`, `raster & 7 == YSCROLL`,
  and DEN was set at some cycle of line `$30`.
- `VC` is loaded from `VCBASE` and `VMLI` cleared at cycle 14; `RC` is reset there only if the
  condition is true in that cycle. A condition appearing later leaves `RC` alone.
- Display state is entered the moment a condition occurs (any cycle) and left at cycle 58 if
  `RC == 7` with no condition active; `VCBASE = VC` happens there.
- c-data is stored at `VMLI`; the g-access reads it from the same position. The c-access leads the
  g-access by one cycle. In a delayed start the line buffer still holds the previous line's data.
- The foreground flag is defined wherever the sequencer outputs pixels (cycles 16-55),
  independent of the border (this supersedes the sub-project 3 text that suppressed it in the
  border and in idle state; amended and pinned by tests).
- Invalid modes 6 and 7 apply the ECM address mask (`addr &= ~$600`) like the idle access.

## 6. Border flip-flops (Bauer 3.9)

Evaluated per pixel and at cycle 63; the flip-flops persist across lines.

| Rule | Effect |
|---|---|
| X reaches right compare (344 with CSEL=1, 335 with CSEL=0) | set the main border flip-flop |
| X reaches left compare (24 / 31) and the vertical flip-flop is not set | reset the main flip-flop |
| Y reaches bottom compare (251 RSEL=1, 247 RSEL=0) at cycle 63 | set the vertical flip-flop |
| Y reaches top compare (51 / 55) at cycle 63 and DEN set | reset the vertical flip-flop |
| X reaches left compare and Y reaches bottom / top compare | set / reset the vertical flip-flop |

These replace the sub-project 2 window-rectangle logic. Toggling CSEL/RSEL at the right cycle
opens the side and top/bottom borders. Static pictures are unchanged and the existing window tests
must still pass.

## 7. Sprite quirks

- `expandFF` is evaluated every cycle (set whenever the Y-expand bit is clear); the MCBASE `+2` at
  cycle 15 and `+1` at cycle 16 use the live flip-flop. A `$D017` write between those cycles
  produces sprite crunch.
- A started shifter runs its full 24 (48) pixels regardless of the display flag and is not reset at
  the line boundary (fixes the two shifter items of #34).
- MCBASE is a 6-bit counter cleared when sprite DMA turns on (Bauer 3.8 rule 3; VICE's
  `turn_sprite_dma_on` does the same). *Amended during implementation.* The 6569 power-on anomaly
  described by VICE-testprogs `VICII/spritemcbase/readme.txt` (MCBASE about `$3F` until the sprite's
  first DMA, a one-frame glitch, absent on the 8565) is not modelled: that test has no reference
  image (so the fetch script never listed it), VICE does not model it, and it is unobservable after
  a sprite's first DMA. The `spritedma/d017-*` references do not discriminate between the variants
  (all pass), so they are not evidence for either rule. The literal "clear at display end (cycle 58)"
  reading is ruled out by `spriteenable3` (Y changed at cycle 57 gives DMA without display; 332
  versus 546 differing pixels). A reference-neutral way to add the anomaly later: power-on `$3F`,
  cleared when MCBASE reaches 63 at cycle 16.

## 8. Verification

Own timing tests (deterministic, unit suite): stolen cycles on badlines (43 / 40) and for lone,
adjacent and all-eight sprites; BA waveforms including wrapping windows; border opening, FLD, DMA
delay and sprite crunch with exact pixels; interrupt timing across a stall.

Third-party subset (independent references):
- `fetch-test-data` gains a pinned `vicetests` source (`libsidplayfp/VICE-testprogs`), a selective
  file list (the `.prg`, source, and reference screenshots). Nothing is vendored.
- `test/conformance/vice-tests.json` lists, per test: PRG, reference image, frames to run,
  crop/offset, expectation `pass` or `known-fail:<reason>`. Known-fail tests are reported, not
  silently skipped, and a known-fail that unexpectedly passes fails the suite.
- The harness decodes PNG with Node's `zlib`, maps each reference pixel to the nearest of the 16
  C64 colours and compares colour indices with our frame.
- Selection: PAL 6569 variants only, one test per behaviour (DMA delay, sprite crunch, MCBASE,
  collision clear, border opening, FLD, sprite DMA), at least 10 tests, skipping NTSC and 8565.
  *Amended:* `spritemcbase` has no reference image and is not fetched, and the manifest holds every PAL test with a
  reference screenshot (137) rather than one per behaviour; the 10 passing ones are the gate.

## 9. Definition of done

1. The core `rdy` hook exists; the existing core suites pass unmodified.
2. The schedule/BA/badline/DMA-delay/border/sprite-quirk unit tests pass; earlier VIC tests pass,
   with any expectation that encoded the old approximation updated and ledgered.
3. The curated third-party subset (at least 10 tests) passes against the reference images, with any
   known-fails listed with a reason and tracked in an issue.
4. The OpenROMs boot, typing and `graphics-test.prg` conformance tests pass on the new stall model.
5. Headless throughput is at least 10x real time with 8 sprites (reported).
6. Browser acceptance: the example page boots, types and runs a VICE reference test, with a
   committed screenshot.
7. `lint`, `typecheck`, `build` are clean; no public API change beyond the optional
   `CpuHooks.rdy`.

## 10. Risks and open items for planning

- Reference images may need per-test crop/offset; the manifest carries it.
- A failing reference test can reveal a misreading of Bauer; each costs analysis, a fix and a unit
  test, and cannot be bounded in advance.
- 6569 revision differences (R1/R3/8565): R3 behaviour is the target, references are chosen to
  match.
- Throughput margin is thin (11x with 8 sprites at the end of sub-project 3); per-cycle schedule
  work must not regress it below the 10x guard.
- The MCBASE power-on anomaly rests on one VICE readme and cannot be checked against a reference image; it is not modelled (see section 7).
