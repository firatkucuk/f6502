import { describe, expect, it } from 'vitest';
import { D64, DiskError, petscii } from '../../src/machine/d64';
import {
  D64Source,
  PrgSource,
  directoryProgram,
  matchName,
  openSource,
} from '../../src/machine/container';

describe('matchName', () => {
  const m = (p: string, n: string) => matchName(petscii(p), petscii(n));
  it('supports exact names, ? and * (and a lone *)', () => {
    expect(m('HELLO', 'HELLO')).toBe(true);
    expect(m('HELLO', 'HELLO2')).toBe(false);
    expect(m('H?LLO', 'HELLO')).toBe(true);
    expect(m('HE*', 'HELLO')).toBe(true);
    expect(m('*', 'ANYTHING')).toBe(true);
    expect(m('*', '')).toBe(true);
    expect(m('A*B', 'AXXB')).toBe(true); // everything after * is ignored, as in CBM DOS
  });
});

describe('directoryProgram', () => {
  function listing(prg: Uint8Array): string[] {
    expect(prg[0]).toBe(0x01);
    expect(prg[1]).toBe(0x04); // $0401
    const lines: string[] = [];
    let p = 2;
    while (p + 4 < prg.length) {
      const link = prg[p]! | (prg[p + 1]! << 8);
      if (link === 0) break;
      const num = prg[p + 2]! | (prg[p + 3]! << 8);
      let text = '';
      p += 4;
      while (prg[p] !== 0) text += String.fromCharCode(prg[p++]!);
      p++;
      lines.push(`${num} ${text}`);
    }
    return lines;
  }

  it('lists header, files and BLOCKS FREE in the real format', () => {
    const d = D64.format('TEST DISK', '01');
    d.writeFile(petscii('HELLO'), 2, new Uint8Array(300));
    d.writeFile(petscii('DATA'), 1, new Uint8Array(10));
    const lines = listing(directoryProgram(new D64Source(d)));
    expect(lines[0]).toBe('0 \u0012"TEST DISK       " 01 2A');
    expect(lines[1]).toMatch(/^2 +"HELLO" +PRG/);
    expect(lines[1]).toContain('"HELLO"');
    expect(lines[2]).toMatch(/^1 +"DATA" +SEQ/);
    expect(lines[3]).toBe(`${664 - 3} BLOCKS FREE.             `);
  });

  it('applies a pattern', () => {
    const d = D64.format('X', '01');
    d.writeFile(petscii('AAA'), 2, new Uint8Array(1));
    d.writeFile(petscii('BBB'), 2, new Uint8Array(1));
    const lines = listing(directoryProgram(new D64Source(d), petscii('A*')));
    expect(lines.some((l) => l.includes('"AAA"'))).toBe(true);
    expect(lines.some((l) => l.includes('"BBB"'))).toBe(false);
  });
});

describe('sources', () => {
  function t64(): Uint8Array {
    const b = new Uint8Array(64 + 32 + 4);
    b.set(new TextEncoder().encode('C64S tape image file'), 0);
    b[0x20] = 0x01; // version
    b[0x22] = 1; // max entries
    b[0x24] = 1; // used entries
    const e = 0x40;
    b[e] = 1; // normal file
    b[e + 1] = 0x82; // PRG
    b[e + 2] = 0x01;
    b[e + 3] = 0x08; // start $0801
    b[e + 4] = 0x03;
    b[e + 5] = 0x08; // end $0803
    b[e + 8] = 0x60; // offset 96
    b.fill(0x20, e + 16, e + 32);
    b.set(petscii('GAME'), e + 16);
    b[96] = 0xaa;
    b[97] = 0xbb;
    b[98] = 0xcc;
    return b;
  }

  it('T64 exposes its entries as PRG files with the address prepended', () => {
    const src = openSource(t64());
    expect(src.writable).toBe(false);
    const f = src.read(petscii('GA*'));
    expect(f).not.toBeNull();
    expect([...f!.data]).toEqual([0x01, 0x08, 0xaa, 0xbb]);
  });

  it('a raw PRG is a single file that matches any name', () => {
    const src = new PrgSource(Uint8Array.from([0x01, 0x08, 1, 2, 3]), 'PROG');
    expect(src.read(petscii('*'))?.data.length).toBe(5);
    expect(src.read(petscii('OTHER'))).toBeNull();
  });

  it('openSource rejects junk with a DiskError and accepts D64 by size', () => {
    expect(() => openSource(new Uint8Array(1))).toThrow(DiskError);
    expect(() => openSource(new Uint8Array(10), 'd64')).toThrow(DiskError);
    expect(openSource(D64.format('X', '01').export()).writable).toBe(true);
  });
});
