export interface RomSet {
  kernal: Uint8Array;
  basic: Uint8Array;
  chargen: Uint8Array;
}

export class RomError extends Error {
  constructor(
    readonly image: string,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`${image} ROM must be ${expected} bytes, got ${actual}`);
    this.name = 'RomError';
  }
}

export function validateRoms(roms: RomSet): void {
  const sizes: Array<[keyof RomSet, number]> = [
    ['kernal', 8192],
    ['basic', 8192],
    ['chargen', 4096],
  ];
  for (const [name, expected] of sizes) {
    if (roms[name].length !== expected) throw new RomError(name, expected, roms[name].length);
  }
}

/** Standard C64 power-on pattern: alternating 64-byte blocks of $00 and $FF. */
export function powerOnRam(ram: Uint8Array): void {
  for (let i = 0; i < ram.length; i++) ram[i] = i & 0x40 ? 0xff : 0x00;
}
