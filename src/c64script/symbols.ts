import { C64ScriptTypeError as TypeError } from './errors';

export type SymbolKind =
  | { tag: 'var'; zpAddr: number | null; absAddr: number | null; isConst: boolean }
  | { tag: 'fn'; isInline: boolean }
  | { tag: 'hardware'; base: number }
  | { tag: 'struct' }
  | { tag: 'color'; value: number };

export interface C64Symbol {
  name: string;
  sym: SymbolKind;
  line: number;
}

export class SymbolTable {
  private readonly scopes: Map<string, C64Symbol>[] = [new Map()];

  push(): void {
    this.scopes.push(new Map());
  }
  pop(): void {
    if (this.scopes.length > 1) this.scopes.pop();
  }

  define(sym: C64Symbol): void {
    const top = this.scopes[this.scopes.length - 1]!;
    if (top.has(sym.name)) throw new TypeError(`'${sym.name}' already defined`, sym.line, 0);
    top.set(sym.name, sym);
  }

  resolve(name: string): C64Symbol | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const found = this.scopes[i]!.get(name);
      if (found) return found;
    }
    return undefined;
  }
}

// ZP: $00-$01 CPU port, $02-$F7 usable (246 bytes), $F8-$FF ABI reserved
const ZP_START = 0x02;
const ZP_ABI_LO = 0xf8;

export class ZpAllocator {
  private next = ZP_START;
  private _used = 0;

  alloc(bytes: number, line = 0): number {
    const addr = this.next;
    if (addr + bytes >= ZP_ABI_LO) {
      throw new TypeError(
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
