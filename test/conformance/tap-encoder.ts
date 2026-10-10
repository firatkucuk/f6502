const SHORT = 0x30;
const MEDIUM = 0x42;
const LONG = 0x56;

function byteInto(out: number[], value: number): void {
  out.push(LONG, MEDIUM); // new-byte marker
  let parity = 1;
  for (let i = 0; i < 8; i++) {
    const bit = (value >> i) & 1;
    parity ^= bit;
    if (bit) out.push(MEDIUM, SHORT);
    else out.push(SHORT, MEDIUM);
  }
  if (parity) out.push(MEDIUM, SHORT);
  else out.push(SHORT, MEDIUM);
}

function block(out: number[], payload: number[], repeat: boolean, leader: number): void {
  for (let i = 0; i < leader; i++) out.push(SHORT); // pilot: short pulses
  const count = repeat
    ? [0x09, 0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01]
    : [0x89, 0x88, 0x87, 0x86, 0x85, 0x84, 0x83, 0x82, 0x81];
  for (const c of count) byteInto(out, c);
  let checksum = 0;
  for (const b of payload) {
    byteInto(out, b);
    checksum ^= b;
  }
  byteInto(out, checksum);
  out.push(LONG, SHORT); // end of data
}

/** A standard KERNAL tape: header block (type 3, absolute) and data block, each recorded twice. */
export function encodeKernalTap(name: string, program: Uint8Array): Uint8Array {
  const start = program[0]! | (program[1]! << 8);
  const data = Array.from(program.subarray(2));
  const end = start + data.length;
  const header = [0x03, start & 0xff, start >> 8, end & 0xff, end >> 8];
  const padded = name.toUpperCase().padEnd(16, ' ').slice(0, 16);
  for (const c of padded) header.push(c.charCodeAt(0));
  while (header.length < 192) header.push(0x20);
  const pulses: number[] = [];
  block(pulses, header, false, 0x6a00); // first header block: long pilot
  block(pulses, header, true, 0x4f); // repeated block: short pilot
  for (let i = 0; i < 80; i++) pulses.push(SHORT); // gap
  block(pulses, data, false, 0x1a00);
  block(pulses, data, true, 0x4f);
  const out = new Uint8Array(20 + pulses.length);
  out.set(new TextEncoder().encode('C64-TAPE-RAW'), 0);
  out[12] = 0;
  out[16] = pulses.length & 0xff;
  out[17] = (pulses.length >> 8) & 0xff;
  out[18] = (pulses.length >> 16) & 0xff;
  out.set(pulses, 20);
  return out;
}
