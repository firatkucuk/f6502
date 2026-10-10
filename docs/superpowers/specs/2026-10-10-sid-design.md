# f6502 sub-project 5: SID sound (6581/8580, headless model + browser audio)

Date: 2026-10-10
Status: draft, awaiting review
Parent: the project decomposition in `docs/superpowers/specs/2026-10-10-6502-core-design.md`
section 1 (this is sub-project 5 of 6). Builds on the machine layer from
`docs/superpowers/specs/2026-10-10-c64-machine-skeleton-design.md` (SID is a stub at
`$D400-$D7FF` today) and the browser layer.

## 1. Goal and context

Replace the SID stub with a reference-grade SID model that plays C64 music correctly in the browser.
The chip is a pure, headless model that produces samples; only the browser layer touches WebAudio.

### Decisions made

- **Fidelity:** reference-grade, as a sample-accurate model clocked per CPU cycle and resampled to
  the output rate. Not a cycle-exact analogue simulation.
- **Licence:** the repository is Apache-2.0 and reSID/libsidplayfp/VICE are GPL. The model is
  written clean-room from the datasheet and public hardware analyses. No GPL code or measured
  tables are copied. GPL material (VICE-testprogs, reference data) is used only as a pinned,
  fetched, never vendored test oracle, like the VICE VIC-II tests.
- **Clocking:** video-driven. The emulator keeps running from `FrameClock`; the browser layer
  moves samples through an adaptive queue and absorbs drift by resampling. The machine layer only
  exposes the samples produced so far.
- **Verification:** exact where digital, measured where analogue (section 7).
- **Models:** 6581 and 8580, selectable at construction and at runtime, default 6581.

## 2. Scope

In scope: three voices (oscillator, waveforms, sync, ring mod, test bit), noise LFSR, envelope
generators, the multi-mode filter, mixer and volume, the register file and read-backs, 6581/8580
model differences, the resampler, the `AudioWorklet` output path, a pinned SID test subset and its
harness, a browser acceptance run.

Out of scope: analogue noise and distortion, the audio-input pin, 6581 external-filter cap
variants, NTSC clocking, stereo/multi-SID, SID file (`.sid`) players and PSID loading (a later
convenience), disk/tape (sub-project 6), CI and the Pages site.

## 3. Code layout

| File | Responsibility |
|---|---|
| `src/machine/sid.ts` | register file, three voices, mixer; `tick()` once per CPU cycle; `IoChip` for `$D400-$D7FF` (32 registers mirrored) |
| `src/machine/sid-voice.ts` | 24-bit oscillator, waveforms, sync, ring mod, noise LFSR |
| `src/machine/sid-envelope.ts` | rate counter, exponential counter, ADSR state machine incl. the ADSR delay bug |
| `src/machine/sid-model.ts` | 6581 / 8580 differences: filter curve, combined-waveform approximation, DC level |
| `src/machine/sid-output.ts` | band-limited downsampling from the cycle clock to the sample rate into a `Float32` ring |
| `src/browser/audio.ts` | `AudioWorklet` loader, queue and adaptive resampling, hidden-tab handling |

`C64` gains `sid` and a `sid` option (`model`, `sampleRate`). `core` and `machine` stay free of DOM
and WebAudio (the ESLint boundaries cover it).

## 4. Chip behaviour

Oscillator and envelope are exact per cycle; the filter and mixer are approximate at the output rate.

### 4.1 Oscillator (per voice, every cycle)

- 24-bit accumulator advanced by the 16-bit `FREQ` each cycle; a write lands on the next cycle.
- Waveforms: triangle (accumulator bit 23 XOR-folded, ring mod XORs the MSB of the neighbouring
  voice), sawtooth, pulse (12-bit compare against `PW`, both directions fixed by the test bit),
  noise (23-bit LFSR, taps bits 17 and 22, clocked when accumulator bit 19 rises).
- Combined waveforms use a documented analytical approximation per model (no measured tables); the
  noise register is corrupted by the write-back behaviour when noise is combined with another
  waveform.
- Hard sync resets the accumulator when the neighbouring voice's MSB rises. The TEST bit holds the
  accumulator at zero and resets the noise LFSR after its documented delay.
- OSC3 (`$D41B`) returns the top 8 bits of voice 3's waveform output.

### 4.2 Envelope (per voice, every cycle)

- 15-bit rate counter compared with the 16-entry rate period table, reset only when the compare
  matches; changing the rate does not reset the counter, which gives the ADSR delay bug (the counter
  wraps through `$7FFF`).
- Exponential counter with period thresholds at envelope values 93, 54, 26, 14 and 6 in decay and
  release; sustain compares against the 4-bit sustain value replicated into 8 bits.
- Gate on enters attack; gate off enters release; ENV3 (`$D41C`) returns voice 3's envelope.

### 4.3 Filter and mixer (output rate)

- Two-pole state-variable filter: LP, BP, HP and their sums, 11-bit `FC`, 4-bit resonance, per-voice
  routing, voice 3 off, master volume.
- 6581: non-linear cutoff curve (an approximation of public measurements). 8580: linear. Each model
  has its own DC level and mix gain.
- The voice outputs are averaged over each output sample interval (box filter) before the filter
  runs; the resampler is band-limited.

### 4.4 Registers

- 32 registers, mirrored every 32 bytes up to `$D7FF`.
- `$D419` / `$D41A` (paddles) read `$FF`.
- Write-only registers read the last value on the SID data bus, decaying to 0 after about 8192
  cycles (the 6581 behaviour; documented simplification for the 8580).

## 5. Public API

```ts
interface SidOptions {
  model?: '6581' | '8580'; // default '6581'
  sampleRate?: number; // default 48000
}
class C64 {
  readonly sid: {
    model: '6581' | '8580'; // switchable at runtime
    readonly sampleRate: number;
    drainSamples(out: Float32Array): number; // returns the number of samples written
  };
}
// browser
start({ ..., audio?: boolean | { model?, sampleRate? } })
```

Nothing is allocated without `audio` in the browser layer; headless users call `drainSamples`.

## 6. Browser audio

- Starts only after a user gesture (autoplay policy). An `AudioWorklet` plays from a ring buffer;
  after each emulated frame the `Player` drains the SID samples and posts them to the worklet.
- Target queue fill is about 60 ms. The resampling ratio is nudged by at most +/-0.5 % to hold the
  target; underruns repeat the last sample.
- Muted while the tab is hidden or the `Player` is paused. `destroy()` closes the context.
- An `AudioEnv` seam lets headless tests use a fake worklet.

## 7. Verification

**Exact (Node, no audio):** the pinned `vicetests` source gains the `SID/*` PRGs and their
reference data. A harness runs each program on the machine and compares the digital results (the
screen or memory contents and `reference.bin` / `.dat` data) to the references. Targets: `envelope`,
`env_test`, `oscinit`, `noiselfsrinit`, `ringmod`, `osc3-wave0`, `writedelay`, `zerolevel`,
`waveforms`, `wb_testsuite`, `bitfade`. Known-fails carry an exact differing count and a tracking
issue, as in #43. The harness restores the same start-up state conventions as the VICE harness
where needed.

**Measured (own tests):** tone frequency from zero crossings; an envelope timing table; filter
cutoff and slope per model; mixer level and DC offset; determinism (same register stream gives the
same samples). Golden hashes only as own regression.

**Browser:** a real-browser run of a small tone-playing PRG with a level/spectrum check from an
`AnalyserNode`.

## 8. Definition of done

1. SID unit tests pass, boundary rules hold, `lint`, `typecheck`, `build` are clean.
2. A curated SID subset of at least 10 reference tests passes exactly, the rest are pinned
   known-fails with a tracking issue.
3. The 6581 and 8580 models are selectable; `start({ audio })` plays in a real browser.
4. Headless throughput is at least 10x real time with SID active (and the SP4 baseline of the VIC
   with 8 sprites is not regressed below it).
5. README status updated; no GPL material is vendored; the pinned references are fetched only.

## 9. Risks and open items for planning

- The combined waveforms and the 6581 filter curve are approximations; the spec makes no
  bit-exactness claim for them. Some reference tests (`waveforms-*`) will be known-fails.
- Several VICE SID tests assume exact bus timing (`writedelay`, `bitfade`); they may need the
  per-cycle write latency of sub-project 4 and may end up known-fail.
- Throughput margin is thin (9.8x at the end of sub-project 4 under light load); per-cycle voice
  and envelope work must be written allocation-free and measured early.
- Autoplay and `AudioWorklet` availability differ per browser; the fallback is silence plus a
  console notice, never an exception.
