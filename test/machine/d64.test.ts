import { describe, expect, it } from 'vitest';
import { D64, DiskError, petscii, sectorsInTrack, toText } from '../../src/machine/d64';

const bytes = (n: number, fill = 0xaa) => new Uint8Array(n).fill(fill);

describe('D64 geometry', () => {
  it('has 21/19/18/17 sectors per track zone and 683 sectors on 35 tracks', () => {
    expect([1, 17, 18, 24, 25, 30, 31, 35].map(sectorsInTrack)).toEqual([
      21, 21, 19, 19, 18, 18, 17, 17,
    ]);
    let total = 0;
    for (let t = 1; t <= 35; t++) total += sectorsInTrack(t);
    expect(total).toBe(683);
  });

  it('accepts 35/40-track images with or without error bytes and rejects other sizes', () => {
    for (const size of [174848, 175531, 196608, 197376]) {
      expect(() => new D64(new Uint8Array(size))).not.toThrow();
    }
    expect(() => new D64(new Uint8Array(1000))).toThrow(DiskError);
  });
});

describe('D64 format and directory', () => {
  it('a formatted disk is empty with 664 free blocks and the name/id set', () => {
    const d = D64.format('TEST DISK', '01');
    expect(d.entries()).toEqual([]);
    expect(d.freeBlocks()).toBe(664);
    expect(toText(d.diskName())).toBe('TEST DISK');
    expect(toText(d.diskId())).toBe('01');
  });

  it('a file round-trips and the BAM and directory are updated', () => {
    const d = D64.format('X', '01');
    const data = Uint8Array.from({ length: 600 }, (_, i) => i & 0xff);
    const e = d.writeFile(petscii('HELLO'), 2, data);
    expect(e.blocks).toBe(3); // ceil(600 / 254)
    expect(d.freeBlocks()).toBe(664 - 3);
    const listed = d.entries();
    expect(listed).toHaveLength(1);
    expect(toText(listed[0]!.name)).toBe('HELLO');
    expect(listed[0]!.type).toBe(2);
    expect(listed[0]!.closed).toBe(true);
    expect(d.readFile(listed[0]!)).toEqual(data);
  });

  it('allocates data away from the directory track, near track 18 first, with interleave 10', () => {
    const d = D64.format('X', '01');
    const e = d.writeFile(petscii('A'), 2, bytes(254 * 3));
    expect(e.track).toBe(17);
    // follow the chain: three sectors on track 17, each 10 sectors apart (mod 21)
    const sectors: number[] = [e.sector];
    const raw = d.export();
    const off = (t: number, s: number) => {
      let o = 0;
      for (let i = 1; i < t; i++) o += sectorsInTrack(i) * 256;
      return o + s * 256;
    };
    let t = e.track;
    let s = e.sector;
    for (let i = 0; i < 2; i++) {
      const o = off(t, s);
      t = raw[o]!;
      s = raw[o + 1]!;
      sectors.push(s);
      expect(t).toBe(17);
    }
    expect(sectors).toEqual([0, 10, 20]);
  });

  it('scratch frees the blocks and the entry; names can be reused', () => {
    const d = D64.format('X', '01');
    const e = d.writeFile(petscii('A'), 2, bytes(1000));
    d.scratch(e);
    expect(d.entries()).toEqual([]);
    expect(d.freeBlocks()).toBe(664);
    d.writeFile(petscii('A'), 2, bytes(10));
    expect(d.entries()).toHaveLength(1);
  });

  it('refuses a duplicate name and a full disk without changing the image', () => {
    const d = D64.format('X', '01');
    d.writeFile(petscii('A'), 2, bytes(10));
    const before = d.export();
    expect(() => d.writeFile(petscii('A'), 2, bytes(10))).toThrow(/exists/i);
    expect(() => d.writeFile(petscii('BIG'), 2, bytes(254 * 700))).toThrow(/full/i);
    expect(d.export()).toEqual(before);
  });

  it('grows the directory beyond one sector (8 entries) on track 18', () => {
    const d = D64.format('X', '01');
    for (let i = 0; i < 20; i++) d.writeFile(petscii('F' + i), 2, bytes(5));
    expect(d.entries()).toHaveLength(20);
    expect(d.freeBlocks()).toBe(664 - 20 - 0);
  });

  it('validate rebuilds the BAM from the files', () => {
    const d = D64.format('X', '01');
    d.writeFile(petscii('A'), 2, bytes(2000));
    const raw = d.export();
    raw[0x16500 + 4 + 4 * 16] = 0; // corrupt the BAM entry of track 17 (offset of 18/0 + entry)
    const broken = new D64(raw);
    broken.validate();
    expect(broken.freeBlocks()).toBe(d.freeBlocks());
  });

  it('a chain that loops is read once and does not hang', () => {
    const d = D64.format('X', '01');
    const e = d.writeFile(petscii('A'), 2, bytes(600));
    const raw = d.export();
    let o = 0;
    for (let i = 1; i < e.track; i++) o += sectorsInTrack(i) * 256;
    o += e.sector * 256;
    raw[o] = e.track; // point the first sector at itself
    raw[o + 1] = e.sector;
    const looped = new D64(raw);
    expect(looped.readFile(looped.entries()[0]!).length).toBeLessThan(254 * 700);
  });

  it('export returns a copy', () => {
    const d = D64.format('X', '01');
    const a = d.export();
    d.writeFile(petscii('A'), 2, bytes(10));
    expect(a).not.toEqual(d.export());
    expect(a.length).toBe(174848);
  });
});
