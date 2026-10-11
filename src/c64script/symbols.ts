import { C64ScriptTypeError } from './errors';

// ZP: $00-$01 CPU port, $02-$F7 usable (246 bytes), $F8-$FF ABI reserved
const ZP_START = 0x02;
const ZP_ABI_LO = 0xf8;

export class ZpAllocator {
  private next = ZP_START;
  private _used = 0;

  alloc(bytes: number, line = 0): number {
    const addr = this.next;
    if (addr + bytes >= ZP_ABI_LO) {
      throw new C64ScriptTypeError(
        `zero-page budget exhausted: need ${bytes} byte(s) at $${addr.toString(16).toUpperCase()}, ` +
          `but $F8 is the ABI boundary`,
        line,
        0,
      );
    }
    this.next += bytes;
    this._used += bytes;
    return addr;
  }

  used(): number {
    return this._used;
  }
}
