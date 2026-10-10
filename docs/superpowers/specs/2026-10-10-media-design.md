# f6502 sub-project 6: media (D64/T64/PRG disks via a KERNAL trap, TAP datasette)

Date: 2026-10-10
Status: draft, awaiting review
Parent: the project decomposition in `docs/superpowers/specs/2026-10-10-6502-core-design.md`
section 1 (this is sub-project 6 of 6). Builds on the machine layer (CIA1 FLAG line, 6510 port,
`C64.loadPrg`) and the browser layer.

## 1. Goal and context

Let programs be loaded from disk images and tapes in the browser: "disk games load". Disks are
served at the KERNAL level (a trap), tape is emulated at the pulse level (a datasette feeding
CIA1), and both are attachable from the browser layer with write-back via export.

### Decisions made

- **Disks:** KERNAL-level trap on the documented indirect vectors; no 1541 CPU/VIA/GCR emulation.
  The drive sits behind a small `DiskDrive` interface so a real 1541 can replace it later.
  Rationale: works with any KERNAL (OpenROMs), needs no drive ROM (never bundled), and keeps the
  demo site usable out of the box.
- **Tape:** real datasette emulation from TAP pulses (CIA1 FLAG, port sense and motor bits); the
  machine reports `warp` while the motor runs so the browser layer can pace faster than real time.
- **Scope:** D64 read and write in memory with export; T64/PRG/P00 read-only; no G64/D71/D81;
  no tape recording.
- **Verification:** unit tests plus independent fixtures from the pinned VICE-testprogs
  (`vdrive/`, `tape/tap204060`), end-to-end on the OpenROMs boot, and a real-browser run.

## 2. Scope

In scope: D64 (35/40 tracks, optional error-info bytes) read/write; T64, P00 and raw PRG as a
read-only virtual directory; `LOAD`, `VERIFY`, `SAVE`, directory listing (`LOAD"$",8`),
`OPEN`/`CLOSE`/`CHKIN`/`CKOUT`/`CHRIN`/`CHROUT`/`CLRCHN`/`CLALL` for the drive's device number;
command/error channel (15); TAP v0/v1/v2 playback; datasette controls and counter; browser attach
and export; autostart.

Out of scope: a real 1541 (drive CPU, VIAs, GCR, rotation), fast loaders and copy protection that
bypass the KERNAL, REL file writes (REL read is unsupported and reports an error), G64/D71/D81,
tape recording, cartridges, CI and the Pages site.

## 3. Code layout

| File | Responsibility |
|---|---|
| `src/machine/d64.ts` | D64 image: sector access, BAM, directory, file read/write, error bytes, export |
| `src/machine/t64.ts`, `src/machine/p00.ts` | read-only containers exposed as a virtual directory |
| `src/machine/drive.ts` | `DiskDrive` interface and the image-backed unit: files, channels, command channel, errors |
| `src/machine/kernal-traps.ts` | reads the KERNAL vectors, detects trap points, runs the handlers |
| `src/machine/datasette.ts` | TAP parser, pulse player, play/stop/rewind, counter, motor/sense |
| `src/machine/c64.ts` | holds the drives and the datasette; `tickChips` clocks the tape; instruction loop checks traps; `warp` |
| `src/browser/player.ts` and friends | attach by URL/file/drop, export, tape controls, warp pacing and SID mute |

`core/` is untouched. `machine/` stays free of DOM and Web APIs.

## 4. KERNAL trap

- After boot (and on every reset) the machine reads the vectors `$031A` (OPEN), `$031C` (CLOSE),
  `$031E` (CHKIN), `$0320` (CKOUT), `$0322` (CLRCHN), `$0324` (CHRIN), `$0326` (CHROUT), `$032C`
  (CLALL), `$0330` (LOAD) and `$0332` (SAVE) and registers their targets as trap points. A vector
  is re-read when a trap point is first missed, so a program that restores the vectors keeps working.
- Before executing an instruction at a trap point the machine runs the handler. If the call is not
  for one of our devices (device number `$BA`, or the logical file's device), the handler does
  nothing and the ROM runs unchanged, so tape and unknown devices keep working.
- A handled call returns as the KERNAL does: carry clear and registers/zero page set, or carry set
  with the error code in `A`, status in `$90`, and the PC set to the return address popped from the
  stack (the routine is exited with an `RTS` equivalent).
- A trap is only taken when the CPU is at an instruction boundary reached by normal flow; the
  per-instruction cost is one comparison against the set of trap addresses.

## 5. Disk behaviour

- **Directory:** `LOAD"$",8` returns the listing as a BASIC program in the real format (header,
  block counts, quoted names, type, `BLOCKS FREE.`), with `*`/`?` patterns and `$:A*` filters.
- **Files:** PRG, SEQ, USR; the type letter and mode in the open string (`name,S,W`); `@:` replace.
- **LOAD/VERIFY/SAVE:** secondary address 0 relocates to the BASIC pointer, 1 loads to the file's
  own address; `SEARCHING FOR` and `LOADING`/`SAVING` are printed in direct mode; errors map to
  the KERNAL's (`FILE NOT FOUND`, `DEVICE NOT PRESENT`, `MISSING FILE NAME`, ...).
- **Channels:** sequential files on channels 2-14 with `ST` end-of-file semantics.
- **Command channel (15):** `S:`, `N:`, `V:`, `I:`, `R:`, `C:` and `00, OK,00,00` style status.
- **Allocation:** BAM updates follow the 1541's first-free-sector and interleave rules; disk full
  is `72, DISK FULL`. Images written here must be readable by standard D64 tools.
- No motor, head or rotation timing is modelled: operations complete instantly.

## 6. Tape behaviour

- TAP v0 (pulse length * 8 cycles, 0 = overflow), v1 (zero followed by a 24-bit length) and v2
  (half-waves) are parsed into a pulse list; each pulse edge is delivered to CIA1's FLAG pin.
- The 6510 port sense bit (bit 4) reads 0 while PLAY is pressed; the motor bit (bit 5, 0 = on)
  gates the playback clock; the write line is ignored.
- `play()`, `stop()`, `rewind()`, position and length for a counter; `warp` is true while the motor
  runs and PLAY is down. When the tape ends, the motor-gated clock simply stops.

## 7. Public API

```ts
c64.drive(8).mount(bytes: Uint8Array, opts: { kind: 'd64' | 't64' | 'prg' | 'p00' }): void
c64.drive(8).unmount(): void
c64.drive(8).exportD64(): Uint8Array
c64.tape.insert(bytes: Uint8Array): void
c64.tape.play() / stop() / rewind(): void
c64.tape.position / length / motor: number | boolean
c64.warp: boolean
// browser
start({ ..., disk?: Source, tape?: Source, autostart?: boolean })
player.mountDisk(source) / player.insertTape(source) / player.exportDisk(): Uint8Array
```
`autostart` types `LOAD"*",8,1` and `RUN` for a disk, and for a tape `LOAD` then presses PLAY.

## 8. Verification

- **Unit (exact):** D64 parsing, BAM allocation and interleave, directory create/delete/scratch,
  wildcard matching, SAVE then LOAD round trip, a golden hash for an image the code creates,
  error-channel strings, LOAD/SAVE register conventions (carry, X/Y, `$90`), TAP v0/v1/v2 pulse
  decoding, FLAG edge timing, motor/sense gating.
- **Independent fixtures (pinned, fetched, never vendored):** VICE-testprogs `vdrive/test.d64`
  and its PRG/BASIC programs (`displaydir`, `seqfiledemo`, `filelen`, `sa-check`, `extrachkin`)
  and `tape/tap204060` for the datasette.
- **End to end on the OpenROMs boot:** mount, `LOAD"$",8` + `LIST` compared with the expected
  listing, load and run a PRG, save a file and read it back, a TAP loaded by the KERNAL tape routine.
- **Browser:** a real-browser run mounting a D64 and loading a program, with a screenshot.

## 9. Definition of done

1. Unit, boundary rules, `lint`, `typecheck` and `build` are clean; no ROM or GPL image is vendored.
2. LOAD/SAVE/OPEN/CLOSE/CHRIN/CHROUT work for the drive on OpenROMs and the directory matches the
   real format.
3. A TAP loads through the real KERNAL tape routine.
4. Images written by the drive re-parse and keep a consistent BAM.
5. Throughput does not drop below the SID-era baseline (traps cost one PC compare).
6. README status updated.

## 10. Risks and open items for planning

- OpenROMs may route some calls differently from the stock KERNAL (messages, status handling);
  the trap points are taken from the vectors, but the printed messages must be checked on both.
- The `warp` pacing interacts with the `FrameClock` and the SID drain; it needs a bound so a
  runaway tape does not freeze the tab.
- REL files and the less common DOS commands are deliberately incomplete; unsupported commands
  must report the matching error rather than silently succeed.
- BAM/allocation fidelity is verified against fixtures, not a real drive; edge cases (full disk,
  directory growth to a second track) need explicit tests.
