import { describe, expect, it } from 'vitest';
import { C64Bus } from '../../src/machine/bus';
import { CpuPort } from '../../src/machine/cpu-port';
import { RomError, validateRoms } from '../../src/machine/memory';
import { filled, markerRoms, stubChip } from './helpers';

function makeBus() {
  const vic = stubChip(0x77);
  const cia1 = stubChip(0x11);
  const cia2 = stubChip(0x22);
  const sid = stubChip(0x33);
  const ref: { bus?: C64Bus } = {};
  const port = new CpuPort(() => ref.bus?.rebuild());
  const bus = new C64Bus(markerRoms(), { vic, cia1, cia2, sid }, port);
  ref.bus = bus;
  return { bus, port, vic, cia1, cia2, sid };
}

function setBanking(bus: C64Bus, bits: number) {
  bus.write(0x00, 0x07); // DDR: bits 0-2 are outputs
  bus.write(0x01, bits);
}

describe('ROM validation', () => {
  it('rejects wrong sizes naming image, expected and actual', () => {
    const roms = markerRoms();
    expect(() => validateRoms({ ...roms, basic: filled(100, 0) })).toThrow(RomError);
    expect(() => validateRoms({ ...roms, basic: filled(100, 0) })).toThrow(/basic.*8192.*100/);
    try {
      validateRoms({ ...roms, basic: filled(100, 0) });
    } catch (error) {
      expect(error).toMatchObject({ image: 'basic', expected: 8192, actual: 100 });
    }
  });
});

describe('PLA banking', () => {
  // [CHAREN HIRAM LORAM] -> expected byte at $A000, $D000, $E000
  const RAM = 0x11;
  const BASIC = 0xba;
  const KERNAL = 0x4b;
  const CHARGEN = 0xcc;
  const IO = 0x77; // VIC stub
  const cases: Array<[number, number, number, number]> = [
    [0b000, RAM, RAM, RAM],
    [0b001, RAM, RAM, RAM],
    [0b010, RAM, CHARGEN, KERNAL],
    [0b011, BASIC, CHARGEN, KERNAL],
    [0b100, RAM, RAM, RAM],
    [0b101, RAM, IO, RAM],
    [0b110, RAM, IO, KERNAL],
    [0b111, BASIC, IO, KERNAL],
  ];
  it.each(cases)('port bits %i maps $A000/$D000/$E000', (bits, a000, d000, e000) => {
    const { bus } = makeBus();
    bus.ram[0xa000] = RAM;
    bus.ram[0xd000] = RAM;
    bus.ram[0xe000] = RAM;
    setBanking(bus, bits);
    expect(bus.read(0xa000)).toBe(a000);
    expect(bus.read(0xd000)).toBe(d000);
    expect(bus.read(0xe000)).toBe(e000);
  });

  it('power-on (DDR=0) reads as all-ones banking: BASIC, I/O, KERNAL visible', () => {
    const { bus } = makeBus();
    expect(bus.read(0xa000)).toBe(0xba);
    expect(bus.read(0xd000)).toBe(0x77);
    expect(bus.read(0xe000)).toBe(0x4b);
  });

  it('writes under ROM land in RAM', () => {
    const { bus } = makeBus();
    bus.write(0xa000, 0x5a);
    bus.write(0xe000, 0x5b);
    expect(bus.ram[0xa000]).toBe(0x5a);
    expect(bus.ram[0xe000]).toBe(0x5b);
    expect(bus.read(0xa000)).toBe(0xba); // ROM still visible
    setBanking(bus, 0b000); // all RAM
    expect(bus.read(0xa000)).toBe(0x5a);
  });

  it('writes to chargen-shadowed $D000 go to RAM', () => {
    const { bus } = makeBus();
    setBanking(bus, 0b011); // CHAREN=0: chargen visible
    bus.write(0xd123, 0x99);
    expect(bus.ram[0xd123]).toBe(0x99);
    expect(bus.read(0xd123)).toBe(0xcc);
  });
});

describe('6510 port', () => {
  it('CPU writes to $00/$01 do not touch the RAM underneath', () => {
    const { bus } = makeBus();
    bus.ram[0] = 0xaa;
    bus.ram[1] = 0xbb;
    bus.write(0x00, 0x2f);
    bus.write(0x01, 0x37);
    expect(bus.ram[0]).toBe(0xaa);
    expect(bus.ram[1]).toBe(0xbb);
    expect(bus.read(0x00)).toBe(0x2f);
  });

  it('reads back output bits from data and input bits as 1 (bit 4 sense = 1, bits 6-7 = 0)', () => {
    const { bus } = makeBus();
    bus.write(0x00, 0x2f); // bits 0-3,5 outputs; bit 4 input
    bus.write(0x01, 0x00);
    expect(bus.read(0x01)).toBe(0x10); // only the input bit 4 reads 1
  });
});

describe('I/O window', () => {
  it('mirrors VIC every 64 bytes and CIAs every 16 bytes', () => {
    const { bus, vic, cia1, cia2 } = makeBus();
    bus.write(0xd040 + 0x11, 0x1b);
    expect(vic.writes.at(-1)).toEqual([0x11, 0x1b]);
    bus.write(0xdc00 + 0x1e, 0x01);
    expect(cia1.writes.at(-1)).toEqual([0x0e, 0x01]);
    bus.write(0xdd00 + 0x12, 0x03);
    expect(cia2.writes.at(-1)).toEqual([0x02, 0x03]);
  });

  it('routes $D400-$D7FF to the SID (32 registers mirrored), colour RAM upper nibble reads 1s, expansion reads $FF', () => {
    const { bus, sid } = makeBus();
    expect(bus.read(0xd418)).toBe(0x33);
    bus.write(0xd7e5, 0x99);
    expect(sid.writes).toContainEqual([0x05, 0x99]);
    bus.write(0xd800, 0x05);
    expect(bus.read(0xd800)).toBe(0xf5);
    expect(bus.read(0xde00)).toBe(0xff);
  });
});

describe('VIC memory view', () => {
  it('shows character ROM at $1000-$1FFF in banks 0 and 2 only', () => {
    const { bus } = makeBus();
    bus.ram[0x1000] = 0x11;
    bus.ram[0x5000] = 0x22; // bank 1, offset $1000
    for (const bank of [0, 2]) {
      bus.vicBank = bank;
      expect(bus.vicRead(0x1000)).toBe(0xcc);
    }
    bus.vicBank = 1;
    expect(bus.vicRead(0x1000)).toBe(0x22);
    bus.vicBank = 0;
    expect(bus.vicRead(0x0fff)).toBe(bus.ram[0x0fff]);
  });
});

describe('peek', () => {
  it('returns the CPU-visible byte without side effects', () => {
    const { bus, vic } = makeBus();
    expect(bus.peek(0xd011)).toBe(0x77);
    expect(vic.writes).toHaveLength(0);
    expect(bus.peek(0xa000)).toBe(0xba);
  });
});

describe('power-on RAM', () => {
  it('uses alternating 64-byte blocks of $00 and $FF', () => {
    const { bus } = makeBus();
    bus.powerOn();
    expect(bus.ram[0x0000]).toBe(0x00);
    expect(bus.ram[0x003f]).toBe(0x00);
    expect(bus.ram[0x0040]).toBe(0xff);
    expect(bus.ram[0x007f]).toBe(0xff);
    expect(bus.ram[0x0080]).toBe(0x00);
  });
});
