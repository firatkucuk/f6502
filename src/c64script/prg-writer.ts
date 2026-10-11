export function writePrg(linked: { code: Uint8Array; loadAddr: number }): Uint8Array {
  const prg = new Uint8Array(2 + linked.code.length);
  prg[0] = linked.loadAddr & 0xff;
  prg[1] = (linked.loadAddr >> 8) & 0xff;
  prg.set(linked.code, 2);
  return prg;
}
