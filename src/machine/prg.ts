export class PrgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrgError';
  }
}

export interface Prg {
  address: number;
  data: Uint8Array;
  /** Exclusive end address. */
  end: number;
}

export function rawProgram(bytes: Uint8Array, address: number): Prg {
  if (!Number.isInteger(address) || address < 0 || address > 0xffff) {
    throw new PrgError(`load address ${address} is outside $0000-$FFFF`);
  }
  if (bytes.length === 0) throw new PrgError('program has no data');
  const end = address + bytes.length;
  if (end > 0x10000) {
    throw new PrgError(
      `program of ${bytes.length} bytes at $${address.toString(16).toUpperCase()} runs past $FFFF`,
    );
  }
  return { address, data: bytes, end };
}

export function parsePrg(bytes: Uint8Array): Prg {
  if (bytes.length < 3) {
    throw new PrgError(
      `a PRG needs a 2-byte load address and at least 1 data byte, got ${bytes.length} bytes`,
    );
  }
  const address = bytes[0]! | (bytes[1]! << 8);
  return rawProgram(bytes.subarray(2), address);
}
