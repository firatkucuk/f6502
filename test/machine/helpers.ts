import type { RomSet } from '../../src/machine/memory';

export function filled(size: number, value: number): Uint8Array {
  return new Uint8Array(size).fill(value);
}

/** ROMs whose bytes identify the image: kernal 0x4B, basic 0xBA, chargen 0xCC. */
export function markerRoms(): RomSet {
  return { kernal: filled(8192, 0x4b), basic: filled(8192, 0xba), chargen: filled(4096, 0xcc) };
}

export function stubChip(value: number) {
  const writes: Array<[number, number]> = [];
  return {
    writes,
    read: (): number => value,
    peek: (): number => value,
    write: (reg: number, v: number): void => {
      writes.push([reg, v]);
    },
  };
}
