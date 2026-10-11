import { D64, DiskError, petscii, type DirEntry } from './d64';

export interface SourceFile {
  name: Uint8Array;
  type: number;
  blocks: number;
  closed: boolean;
  locked: boolean;
}

export interface FileSource {
  readonly writable: boolean;
  label(): { name: Uint8Array; id: Uint8Array };
  list(): SourceFile[];
  /** First file whose name matches the pattern (`*`, `?`); the data is a PRG (address first). */
  read(name: Uint8Array): { file: SourceFile; data: Uint8Array } | null;
  blocksFree(): number;
}

/** CBM DOS matching: `?` matches one character, `*` matches the rest. */
export function matchName(pattern: Uint8Array, name: Uint8Array): boolean {
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i]!;
    if (p === 0x2a) return true;
    if (i >= name.length) return false;
    if (p !== 0x3f && p !== name[i]) return false;
  }
  return pattern.length === name.length;
}

export class D64Source implements FileSource {
  readonly writable = true;
  constructor(readonly image: D64) {}

  label() {
    return { name: this.image.diskName(), id: this.image.diskId() };
  }

  private mapped(): Array<{ file: SourceFile; entry: DirEntry }> {
    return this.image.entries().map((entry) => ({
      entry,
      file: {
        name: entry.name,
        type: entry.type,
        blocks: entry.blocks,
        closed: entry.closed,
        locked: entry.locked,
      },
    }));
  }

  list(): SourceFile[] {
    return this.mapped().map((m) => m.file);
  }

  read(name: Uint8Array) {
    const hit = this.mapped().find((m) => matchName(name, m.file.name));
    return hit ? { file: hit.file, data: this.image.readFile(hit.entry) } : null;
  }

  blocksFree(): number {
    return this.image.freeBlocks();
  }
}

const NAME_PAD = 0x20;

function trimSpaces(raw: Uint8Array): Uint8Array {
  let n = raw.length;
  while (n > 0 && (raw[n - 1] === NAME_PAD || raw[n - 1] === 0x00)) n--;
  return raw.slice(0, n);
}

class ListSource implements FileSource {
  readonly writable = false;
  constructor(
    private readonly files: Array<{ file: SourceFile; data: Uint8Array }>,
    private readonly title: string,
  ) {}

  label() {
    return { name: petscii(this.title).slice(0, 16), id: petscii('00') };
  }

  list(): SourceFile[] {
    return this.files.map((f) => f.file);
  }

  read(name: Uint8Array) {
    return this.files.find((f) => matchName(name, f.file.name)) ?? null;
  }

  blocksFree(): number {
    return 0;
  }
}

function blocksOf(len: number): number {
  return Math.max(1, Math.ceil(len / 254));
}

export class T64Source extends ListSource {
  constructor(bytes: Uint8Array) {
    if (bytes.length < 0x60 || !new TextDecoder().decode(bytes.subarray(0, 3)).startsWith('C64')) {
      throw new DiskError(74, 'not a T64 image');
    }
    const used = bytes[0x24]! | (bytes[0x25]! << 8);
    const max = bytes[0x22]! | (bytes[0x23]! << 8);
    const count = Math.min(Math.max(used, 0), Math.max(max, used), 1000);
    const files: Array<{ file: SourceFile; data: Uint8Array }> = [];
    for (let i = 0; i < count; i++) {
      const e = 0x40 + i * 32;
      if (e + 32 > bytes.length || bytes[e] === 0) continue;
      const start = bytes[e + 2]! | (bytes[e + 3]! << 8);
      const end = bytes[e + 4]! | (bytes[e + 5]! << 8);
      const off =
        bytes[e + 8]! | (bytes[e + 9]! << 8) | (bytes[e + 10]! << 16) | (bytes[e + 11]! << 24);
      const wanted = Math.max(0, end - start);
      const avail = Math.max(0, Math.min(wanted, bytes.length - off));
      const data = new Uint8Array(2 + avail);
      data[0] = start & 0xff;
      data[1] = start >> 8;
      data.set(bytes.subarray(off, off + avail), 2);
      files.push({
        file: {
          name: trimSpaces(bytes.subarray(e + 16, e + 32)),
          type: 2,
          blocks: blocksOf(data.length),
          closed: true,
          locked: false,
        },
        data,
      });
    }
    super(files, 'T64');
  }
}

export class P00Source extends ListSource {
  constructor(bytes: Uint8Array) {
    if (bytes.length < 26 || new TextDecoder().decode(bytes.subarray(0, 7)) !== 'C64File') {
      throw new DiskError(74, 'not a P00 file');
    }
    const name = trimSpaces(bytes.subarray(8, 24));
    const data = bytes.slice(26);
    super(
      [
        {
          file: { name, type: 2, blocks: blocksOf(data.length), closed: true, locked: false },
          data,
        },
      ],
      'P00',
    );
  }
}

export class PrgSource extends ListSource {
  private readonly single: { file: SourceFile; data: Uint8Array };
  constructor(bytes: Uint8Array, name = 'PROGRAM') {
    const file = {
      name: petscii(name).slice(0, 16),
      type: 2,
      blocks: blocksOf(bytes.length),
      closed: true,
      locked: false,
    };
    super([{ file, data: bytes }], name);
    this.single = { file, data: bytes };
  }

  override read(name: Uint8Array) {
    return name.length === 1 && name[0] === 0x2a ? this.single : super.read(name);
  }
}

export function openSource(
  bytes: Uint8Array,
  kind?: 'd64' | 't64' | 'prg' | 'p00',
  name?: string,
): FileSource {
  const sniff = kind ?? detect(bytes);
  switch (sniff) {
    case 'd64':
      return new D64Source(new D64(bytes));
    case 't64':
      return new T64Source(bytes);
    case 'p00':
      return new P00Source(bytes);
    default:
      if (bytes.length < 2) throw new DiskError(74, 'program is shorter than its load address');
      return new PrgSource(bytes, name);
  }
}

function detect(bytes: Uint8Array): 'd64' | 't64' | 'p00' | 'prg' {
  if ([174848, 175531, 196608, 197376].includes(bytes.length)) return 'd64';
  const head = new TextDecoder().decode(bytes.subarray(0, 8));
  if (head.startsWith('C64File')) return 'p00';
  if (head.startsWith('C64S') || head.startsWith('C64 tape') || head.startsWith('C64')) {
    if (bytes.length >= 0x60) return 't64';
  }
  if (bytes.length >= 2) return 'prg';
  throw new DiskError(74, 'unrecognised disk or program image');
}

const TYPE_NAMES = ['DEL', 'SEQ', 'PRG', 'USR', 'REL'];

/**
 * The directory as a BASIC program (what `LOAD"$",8` returns): load address $0401, links computed
 * for that address (BASIC re-links after a relocated LOAD).
 */
export function directoryProgram(src: FileSource, pattern?: Uint8Array): Uint8Array {
  const out: number[] = [0x01, 0x04];
  let addr = 0x0401;
  const line = (num: number, text: number[]) => {
    const len = 2 + 2 + text.length + 1;
    addr += len;
    out.push(addr & 0xff, addr >> 8, num & 0xff, num >> 8, ...text, 0);
  };
  const { name, id } = src.label();
  const head: number[] = [0x12, 0x22];
  const label = name.indexOf(0xa0) >= 0 ? name.slice(0, name.indexOf(0xa0)) : name;
  for (let i = 0; i < 16; i++) head.push(i < label.length ? label[i]! : 0x20);
  head.push(0x22, 0x20, id[0] ?? 0x30, id[1] ?? 0x30, 0x20, 0x32, 0x41);
  line(0, head);
  for (const f of src.list()) {
    if (pattern && pattern.length > 0 && !matchName(pattern, f.name)) continue;
    const text: number[] = [];
    const pad = f.blocks < 10 ? 3 : f.blocks < 100 ? 2 : f.blocks < 1000 ? 1 : 0;
    for (let i = 0; i < pad; i++) text.push(0x20);
    text.push(0x22, ...f.name, 0x22);
    for (let i = f.name.length; i < 17; i++) text.push(0x20);
    text.push(...new TextEncoder().encode(TYPE_NAMES[f.type] ?? 'PRG'));
    if (!f.closed) text.push(0x2a);
    else if (f.locked) text.push(0x3c);
    else text.push(0x20);
    while (text.length < 25) text.push(0x20);
    line(f.blocks, text);
  }
  const tail = [...new TextEncoder().encode('BLOCKS FREE.'), ...new Array<number>(13).fill(0x20)];
  line(src.blocksFree(), tail);
  out.push(0, 0);
  return Uint8Array.from(out);
}
