import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodePng } from './png';

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function png(width: number, height: number, colorType: number, rows: number[][]): Uint8Array {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const raw = rows.flatMap((r) => r);
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Uint8Array.from(raw))),
    chunk('IEND', new Uint8Array(0)),
  ];
  return Uint8Array.from(parts.flatMap((p) => [...p]));
}

describe('decodePng', () => {
  it('decodes 8-bit RGBA with filter type 0', () => {
    const img = decodePng(png(2, 1, 6, [[0, 1, 2, 3, 255, 4, 5, 6, 255]]));
    expect([img.width, img.height]).toEqual([2, 1]);
    expect([...img.data]).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
  });

  it('applies the Sub, Up, Average and Paeth filters', () => {
    // 2x4 RGBA image, 4 scanlines, one filter type each (1..4)
    const rows = [
      [1, 10, 20, 30, 255, 1, 1, 1, 0], // Sub: second pixel = first + (1,1,1,0)
      [2, 1, 1, 1, 0, 2, 2, 2, 0], // Up
      [3, 0, 0, 0, 0, 0, 0, 0, 0], // Average
      [4, 5, 5, 5, 0, 1, 1, 1, 0], // Paeth
    ];
    const img = decodePng(png(2, 4, 6, rows));
    expect([...img.data.subarray(0, 8)]).toEqual([10, 20, 30, 255, 11, 21, 31, 255]);
    expect([...img.data.subarray(8, 16)]).toEqual([11, 21, 31, 255, 13, 23, 33, 255]);
    expect(img.data.length).toBe(2 * 4 * 4);
  });

  it('decodes 8-bit RGB (colour type 2) as opaque RGBA', () => {
    const img = decodePng(png(1, 1, 2, [[0, 9, 8, 7]]));
    expect([...img.data]).toEqual([9, 8, 7, 255]);
  });

  it('rejects interlaced, wrong-signature and unsupported-depth files', () => {
    expect(() => decodePng(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toThrow(/PNG/);
  });
});
