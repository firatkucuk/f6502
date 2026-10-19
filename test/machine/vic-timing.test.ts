import { describe, expect, it } from 'vitest';
import { C64 } from '../../src/machine/c64';
import { VicII } from '../../src/machine/vic';
import { filled } from './helpers';
import { PALETTE } from '../../src/machine/palette';
import { vicWorld } from './vic-helpers';

/** Ticks until `raster` becomes R (cycle 1 of line R processed) and records BA for cycles 1..63. */
function recordLine(vic: VicII, raster: number): boolean[] {
  while (vic.raster !== raster) vic.tick();
  const ba: boolean[] = [vic.baLow];
  for (let c = 2; c <= 63; c++) {
    vic.tick();
    ba.push(vic.baLow);
  }
  return ba;
}

const cyclesLow = (ba: boolean[]) => ba.flatMap((v, i) => (v ? [i + 1] : []));
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

function setup() {
  const w = vicWorld();
  w.vic.write(0x11, 0x1b); // DEN, RSEL, YSCROLL 3 -> badlines on rasters 51, 59, ...
  w.vic.write(0x18, 0x12);
  return w;
}

describe('BA waveform', () => {
  it('a plain line has no BA; a badline holds BA low in cycles 12-54', () => {
    const { vic } = setup();
    expect(cyclesLow(recordLine(vic, 50))).toEqual([]);
    expect(cyclesLow(recordLine(vic, 51))).toEqual(range(12, 54));
    expect(cyclesLow(recordLine(vic, 52))).toEqual([]);
  });

  it('DEN is only honoured if it was set during line $30', () => {
    const { vic } = setup();
    vic.write(0x11, 0x0b); // DEN off before line $30
    expect(cyclesLow(recordLine(vic, 51))).toEqual([]);
  });

  it('a DEN write in the last cycle of line $30 counts, one in cycle 1 of line $31 does not', () => {
    // The CPU write of cycle N lands after the VIC processed cycle N; the raster counter moves on
    // in cycle 1, so the last cycle of line $30 is the last write VICE still counts.
    const late = setup();
    late.vic.write(0x11, 0x0b);
    while (!(late.vic.raster === 0x30 && late.vic.debug.cycle === 1)) late.vic.tick();
    late.vic.write(0x11, 0x1b);
    expect(cyclesLow(recordLine(late.vic, 51))).toEqual(range(12, 54));

    const tooLate = setup();
    tooLate.vic.write(0x11, 0x0b);
    while (!(tooLate.vic.raster === 0x31 && tooLate.vic.debug.cycle === 2)) tooLate.vic.tick();
    tooLate.vic.write(0x11, 0x1b);
    expect(cyclesLow(recordLine(tooLate.vic, 51))).toEqual([]);
  });

  it('BA ends as soon as the badline condition goes false (it is re-evaluated every cycle)', () => {
    const { vic } = setup();
    vic.write(0x11, 0x1c); // YSCROLL 4: no badline on raster 51
    while (!(vic.raster === 51 && vic.debug.cycle === 12)) vic.tick();
    const ba: boolean[] = [];
    for (let c = 12; c <= 54; c++) {
      if (c === 12) vic.write(0x11, 0x1b); // badline condition true from cycle 12
      if (c === 31) vic.write(0x11, 0x1c); // and false again from cycle 31
      vic.tick();
      ba.push(vic.baLow);
    }
    expect(ba.map((v, i) => (v ? 12 + i : 0)).filter(Boolean)).toEqual(range(12, 30));
  });

  it('a badline that starts late reads the floating bus for the first c-accesses (FLI bug)', () => {
    const w = setup();
    const { vic, ram } = w;
    ram.fill(0, 0x0400, 0x0800); // screen: code 0 everywhere
    ram[0x0401] = 1; // cell 1: code 1, glyph all zero -> background
    ram.fill(0xff, 0x0800 + 0xff * 8, 0x0800 + 0xff * 8 + 8); // glyph of code $ff: solid
    w.color.fill(0x05);
    vic.write(0x11, 0x1c);
    vic.write(0x16, 0x08);
    vic.write(0x21, 0x06);
    vic.write(0x20, 0x0e);
    while (!(vic.raster === 51 && vic.debug.cycle === 14)) vic.tick();
    vic.write(0x11, 0x1b); // badline condition true from cycle 14: BA low from 14
    // BA low in cycles 14, 15, 16: the c-accesses of cycles 15 and 16 (cells 0 and 1) see the bus
    while (vic.raster === 51) vic.tick();
    const px0 = vic.frame[(51 - 15) * 384 + 32 + 0]!;
    const px1 = vic.frame[(51 - 15) * 384 + 32 + 8]!;
    expect(px0).toBe(PALETTE[15]!); // $ff: solid glyph in colour 15 (low nibble of the bus byte)
    expect(px1).toBe(PALETTE[15]!);
  });

  it('one sprite adds a 5-cycle window; adjacent windows merge; wrapped windows cross the line', () => {
    const w = setup();
    const { vic, ram } = w;
    // sprite 0 only, Y=100 (DMA on at cycle 55 of line 100)
    vic.write(0x15, 0x01);
    vic.write(0x01, 100);
    ram[0x07f8] = 0x40;
    expect(cyclesLow(recordLine(vic, 100))).toEqual(range(55, 59));
    expect(cyclesLow(recordLine(vic, 101))).toEqual(range(55, 59));
  });

  it('all eight sprites: cycles 55-63 on the starting line and 1-10 plus 55-63 afterwards', () => {
    const { vic } = setup();
    vic.write(0x15, 0xff);
    for (let n = 0; n < 8; n++) vic.write(1 + 2 * n, 100);
    expect(cyclesLow(recordLine(vic, 100))).toEqual(range(55, 63));
    expect(cyclesLow(recordLine(vic, 101))).toEqual([...range(1, 10), ...range(55, 63)]);
  });

  it('sprite 3 alone: its window wraps (61-63 of the previous line, 1-2 of the next)', () => {
    const { vic } = setup();
    vic.write(0x15, 0x08);
    vic.write(0x07, 100);
    expect(cyclesLow(recordLine(vic, 100))).toEqual([61, 62, 63]);
    expect(cyclesLow(recordLine(vic, 101))).toEqual([1, 2, 61, 62, 63]);
  });
});

describe('badline start timing', () => {
  it('a condition that appears at cycle 30 starts BA at 30 and holds it through cycle 54', () => {
    const { vic } = setup();
    vic.write(0x11, 0x1c); // YSCROLL 4: no badline on raster 51
    while (vic.raster !== 51) vic.tick();
    const ba: boolean[] = [vic.baLow];
    for (let c = 2; c <= 63; c++) {
      if (c === 30) vic.write(0x11, 0x1b); // YSCROLL 3: seen when cycle 30 is processed
      vic.tick();
      ba.push(vic.baLow);
    }
    expect(cyclesLow(ba)).toEqual(range(30, 54));
  });
});

describe('c-access leads g-access by one cycle', () => {
  it('reads the matrix byte of cell n+1 in the same cycle as the glyph of cell n', () => {
    const reads: number[] = [];
    const ram = new Uint8Array(0x4000);
    const vic = new VicII({
      readMem: (a) => {
        reads.push(a);
        return ram[a]!;
      },
      readColor: () => 0,
    });
    vic.write(0x11, 0x1b);
    vic.write(0x18, 0x12); // matrix $0400, chars $0800
    ram[0x0400] = 5;
    ram[0x0401] = 6;
    while (vic.raster !== 51) vic.tick(); // cycle 1 of line 51 processed
    reads.length = 0;
    for (let c = 2; c <= 17; c++) vic.tick();
    const matrixAndGlyph = reads.filter(
      (a) => a >= 0x0400 && a < 0x0900 && (a < 0x07f8 || a > 0x07ff),
    );
    // cycle 15: matrix[0]; cycle 16: glyph(code 5, row 0) then matrix[1]; cycle 17: glyph(code 6) ...
    expect(matrixAndGlyph.slice(0, 5)).toEqual([0x0400, 0x0828, 0x0401, 0x0830, 0x0402]);
  });
});

describe('machine-level stolen cycles', () => {
  /** A KERNAL that enables the display and then runs NOPs forever. */
  function nopMachine(den: boolean) {
    const kernal = filled(8192, 0xea);
    const prologue = [0xa9, den ? 0x1b : 0x0b, 0x8d, 0x11, 0xd0, 0x4c, 0x08, 0xe0];
    kernal.set(prologue, 0);
    kernal[0x1ffc] = 0x00;
    kernal[0x1ffd] = 0xe0;
    // $E008.. is all NOPs (0xEA); a JMP back near the end of ROM keeps the loop going
    kernal.set([0x4c, 0x08, 0xe0], 0x1000);
    return new C64({ kernal, basic: filled(8192, 0), chargen: filled(4096, 0) });
  }

  function stolenPerFrame(c64: C64): number {
    c64.runFrame(); // settle: DEN seen on line $30
    c64.runFrame();
    const start = c64.cpu.cycles;
    let instructions = 0;
    const end = start + 19_656 * 10;
    while (c64.cpu.cycles < end) {
      c64.cpu.step();
      instructions++;
    }
    const total = c64.cpu.cycles - start;
    return (total - 2 * instructions) / (total / 19_656);
  }

  it('with the display off the CPU is never held', () => {
    expect(stolenPerFrame(nopMachine(false))).toBeLessThan(6); // JMP loop overhead only
  });

  it('with the display on a read-only CPU loses 25 badlines x 43 cycles per frame', () => {
    const stolen = stolenPerFrame(nopMachine(true));
    expect(stolen).toBeGreaterThan(1075 - 14);
    expect(stolen).toBeLessThan(1075 + 14);
  });
});
