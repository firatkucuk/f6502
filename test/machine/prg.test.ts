import { describe, expect, it } from 'vitest';
import { parsePrg, PrgError, rawProgram } from '../../src/machine/prg';

describe('parsePrg', () => {
  it('reads the little-endian load address and data', () => {
    const prg = parsePrg(Uint8Array.from([0x01, 0x08, 0xaa, 0xbb]));
    expect(prg.address).toBe(0x0801);
    expect([...prg.data]).toEqual([0xaa, 0xbb]);
    expect(prg.end).toBe(0x0803);
  });

  it('rejects files with no data bytes (2-byte and empty files)', () => {
    expect(() => parsePrg(Uint8Array.from([0x01, 0x08]))).toThrow(PrgError);
    expect(() => parsePrg(new Uint8Array(0))).toThrow(PrgError);
  });

  it('rejects data that runs past $FFFF', () => {
    expect(() => parsePrg(Uint8Array.from([0xff, 0xff, 0x01, 0x02]))).toThrow(/\$FFFF/);
  });

  it('does not restrict a $0801 program to the BASIC area (end above $9FFF is accepted)', () => {
    const bytes = new Uint8Array(2 + 0xa000);
    bytes[0] = 0x01;
    bytes[1] = 0x08;
    expect(parsePrg(bytes).end).toBe(0x0801 + 0xa000);
  });

  it('accepts data that ends exactly at $FFFF', () => {
    const prg = parsePrg(Uint8Array.from([0xff, 0xff, 0x01]));
    expect(prg.end).toBe(0x10000);
  });
});

describe('rawProgram', () => {
  it('wraps a headerless binary at an explicit address', () => {
    const prg = rawProgram(Uint8Array.from([1, 2, 3]), 0xc000);
    expect(prg.address).toBe(0xc000);
    expect(prg.end).toBe(0xc003);
  });

  it('rejects an address outside 0..$FFFF or an overrun', () => {
    expect(() => rawProgram(Uint8Array.from([1]), -1)).toThrow(PrgError);
    expect(() => rawProgram(Uint8Array.from([1, 2]), 0xffff)).toThrow(PrgError);
  });
});
