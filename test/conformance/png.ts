import { inflateSync } from 'node:zlib';

export interface DecodedPng {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  data: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Minimal PNG decoder: 8-bit, non-interlaced, colour types 2 (RGB), 3 (palette) and 6 (RGBA). */
export function decodePng(bytes: Uint8Array): DecodedPng {
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) {
    throw new Error('not a PNG file (bad signature)');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  let palette: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (pos + 8 <= bytes.length) {
    const length = view.getUint32(pos);
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    const body = bytes.subarray(pos + 8, pos + 8 + length);
    pos += 12 + length;
    if (type === 'IHDR') {
      const header = new DataView(body.buffer, body.byteOffset, body.byteLength);
      width = header.getUint32(0);
      height = header.getUint32(4);
      const depth = body[8]!;
      colorType = body[9]!;
      if (depth !== 8) throw new Error(`unsupported PNG bit depth ${depth}`);
      if (body[12] !== 0) throw new Error('interlaced PNG is not supported');
    } else if (type === 'PLTE') {
      palette = Uint8Array.from(body);
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 3 ? 1 : 0;
  if (channels === 0) throw new Error(`unsupported PNG colour type ${colorType}`);

  const compressed = Uint8Array.from(idat.flatMap((c) => [...c]));
  const raw = inflateSync(compressed);
  const stride = width * channels;
  const pixels = new Uint8Array(stride * height);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = Uint8Array.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels]! : 0;
      const b = prev[i]!;
      const c = i >= channels ? prev[i - channels]! : 0;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = (line[i]! + add) & 0xff;
    }
    pixels.set(line, y * stride);
    prev = line;
  }

  const data = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    if (colorType === 6) {
      data.set(pixels.subarray(p * 4, p * 4 + 4), p * 4);
    } else if (colorType === 2) {
      data.set(pixels.subarray(p * 3, p * 3 + 3), p * 4);
      data[p * 4 + 3] = 255;
    } else {
      const index = pixels[p]!;
      if (!palette) throw new Error('palette PNG without PLTE');
      data[p * 4] = palette[index * 3]!;
      data[p * 4 + 1] = palette[index * 3 + 1]!;
      data[p * 4 + 2] = palette[index * 3 + 2]!;
      data[p * 4 + 3] = 255;
    }
  }
  return { width, height, data };
}
