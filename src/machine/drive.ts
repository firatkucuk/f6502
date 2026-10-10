import { D64Source, directoryProgram, matchName, type FileSource } from './container';
import { DiskError, petscii, toText } from './d64';

export interface DiskDrive {
  readonly device: number;
  readonly present: boolean;
  loadFile(raw: Uint8Array): { data: Uint8Array } | { error: number };
  saveFile(raw: Uint8Array, data: Uint8Array): number;
  open(channel: number, raw: Uint8Array): void;
  read(channel: number): { byte: number; eof: boolean };
  write(channel: number, byte: number): void;
  close(channel: number): void;
  closeAll(): void;
  statusText(): string;
}

export const DOS_MESSAGES: Record<number, string> = {
  0: ' OK',
  1: ' FILES SCRATCHED',
  26: 'WRITE PROTECT ON',
  30: 'SYNTAX ERROR',
  31: 'SYNTAX ERROR',
  33: 'SYNTAX ERROR',
  34: 'SYNTAX ERROR',
  61: 'FILE NOT OPEN',
  62: 'FILE NOT FOUND',
  63: 'FILE EXISTS',
  64: 'FILE TYPE MISMATCH',
  70: 'NO CHANNEL',
  72: 'DISK FULL',
  73: 'CBM DOS V2.6 1541',
  74: 'DRIVE NOT READY',
};

export interface ParsedName {
  name: Uint8Array;
  pattern: Uint8Array;
  replace: boolean;
  dir: boolean;
  type: number | null;
  mode: 'r' | 'w' | 'a' | null;
}

const TYPE_LETTERS: Record<number, number> = { 0x44: 0, 0x53: 1, 0x50: 2, 0x55: 3, 0x4c: 4 };

/** `[@][0]:NAME[,TYPE[,MODE]]`, `$`, `$[0]:PATTERN`. */
export function parseFilename(raw: Uint8Array): ParsedName {
  let b = Array.from(raw);
  let replace = false;
  if (b[0] === 0x40) {
    replace = true;
    b = b.slice(1);
  }
  const dir = b[0] === 0x24;
  if (dir) b = b.slice(1);
  const colon = b.indexOf(0x3a);
  if (colon >= 0 && colon <= 2) b = b.slice(colon + 1);
  else if (b[0] !== undefined && b[0] >= 0x30 && b[0] <= 0x39 && b[1] === 0x3a) b = b.slice(2);
  const parts: number[][] = [[]];
  for (const c of b) {
    if (c === 0x2c) parts.push([]);
    else parts[parts.length - 1]!.push(c);
  }
  let type: number | null = null;
  let mode: 'r' | 'w' | 'a' | null = null;
  for (const p of parts.slice(1)) {
    const c = p[0];
    if (c === undefined) continue;
    if (c === 0x52 && type === null && p.length === 1 && mode === null) mode = 'r';
    else if (c === 0x57 && p.length === 1) mode = 'w';
    else if (c === 0x41 && p.length === 1) mode = 'a';
    else if (TYPE_LETTERS[c] !== undefined && type === null) type = TYPE_LETTERS[c]!;
  }
  const name = Uint8Array.from(parts[0]!);
  return { name, pattern: name, replace, dir, type, mode };
}

type Channel =
  | { kind: 'read'; data: Uint8Array; pos: number }
  | { kind: 'write'; name: Uint8Array; type: number; replace: boolean; bytes: number[] }
  | { kind: 'error' }
  | { kind: 'command' };

export class ImageDrive implements DiskDrive {
  source: FileSource | null = null;
  private readonly channels = new Map<number, Channel>();
  private status = { code: 0, a: 0, b: 0 };
  private statusBytes: Uint8Array | null = null;
  private statusPos = 0;

  constructor(readonly device: number) {}

  get present(): boolean {
    return this.source !== null;
  }

  mount(source: FileSource): void {
    this.closeAll();
    this.source = source;
    this.setStatus(73, 0, 0);
  }

  unmount(): void {
    this.closeAll();
    this.source = null;
  }

  exportD64(): Uint8Array {
    if (!(this.source instanceof D64Source))
      throw new DiskError(26, 'the mounted image is not a D64');
    return this.source.image.export();
  }

  private setStatus(code: number, a = 0, b = 0): void {
    this.status = { code, a, b };
    this.statusBytes = null;
    this.statusPos = 0;
  }

  statusText(): string {
    const { code, a, b } = this.status;
    const two = (n: number) => String(n).padStart(2, '0');
    const message = DOS_MESSAGES[code] ?? 'UNKNOWN ERROR';
    return `${two(code)},${message},${two(a)},${two(b)}\r`;
  }

  // ---- whole-file API (LOAD / SAVE) ----------------------------------------

  loadFile(raw: Uint8Array): { data: Uint8Array } | { error: number } {
    if (!this.source) return { error: 74 };
    const p = parseFilename(raw);
    if (p.dir)
      return { data: directoryProgram(this.source, p.pattern.length ? p.pattern : undefined) };
    const hit = this.source.read(p.name);
    if (!hit) {
      this.setStatus(62, 0, 0);
      return { error: 62 };
    }
    this.setStatus(0);
    return { data: hit.data };
  }

  saveFile(raw: Uint8Array, data: Uint8Array): number {
    if (!this.source) return 74;
    const code = this.store(parseFilename(raw), 2, data);
    this.setStatus(code);
    return code;
  }

  private store(p: ParsedName, defaultType: number, data: Uint8Array): number {
    if (!(this.source instanceof D64Source)) return 26;
    const image = this.source.image;
    const existing = image
      .entries()
      .find((e) => matchName(p.name, e.name) && p.name.length === e.name.length);
    if (existing) {
      if (!p.replace) return 63;
      // Do not delete the original unless the replacement is going to fit.
      const need = Math.max(1, Math.ceil(data.length / 254));
      if (need > image.freeBlocks() + existing.blocks) return 72;
      image.scratch(existing);
    }
    try {
      image.writeFile(p.name, p.type ?? defaultType, data);
      return 0;
    } catch (e) {
      return e instanceof DiskError ? e.code : 71;
    }
  }

  // ---- channels --------------------------------------------------------------

  open(channel: number, raw: Uint8Array): void {
    this.closeChannel(channel);
    if (channel === 15) {
      this.channels.set(15, { kind: 'command' });
      if (raw.length > 0) this.command(raw);
      return;
    }
    if (!this.source) {
      this.setStatus(74);
      this.channels.set(channel, { kind: 'error' });
      return;
    }
    const p = parseFilename(raw);
    if (channel === 0 || (p.dir && p.mode === null)) {
      const r = this.loadFile(raw);
      this.channels.set(
        channel,
        'data' in r ? { kind: 'read', data: r.data, pos: 0 } : { kind: 'error' },
      );
      return;
    }
    const writing = channel === 1 || p.mode === 'w' || p.mode === 'a';
    if (writing) {
      if (!(this.source instanceof D64Source)) {
        this.setStatus(26);
        this.channels.set(channel, { kind: 'error' });
        return;
      }
      const exists = this.source.image
        .entries()
        .some((e) => e.name.length === p.name.length && e.name.every((c, i) => c === p.name[i]));
      if (exists && !p.replace && p.mode !== 'a') {
        this.setStatus(63);
        this.channels.set(channel, { kind: 'error' });
        return;
      }
      if (p.mode === 'a') {
        const entry = this.source.image
          .entries()
          .find((e) => e.name.length === p.name.length && e.name.every((c, i) => c === p.name[i]));
        if (!entry) {
          this.setStatus(62);
          this.channels.set(channel, { kind: 'error' });
          return;
        }
        this.channels.set(channel, {
          kind: 'write',
          name: p.name,
          type: p.type ?? entry.type,
          replace: true,
          bytes: Array.from(this.source.image.readFile(entry)),
        });
        return;
      }
      this.channels.set(channel, {
        kind: 'write',
        name: p.name,
        type: p.type ?? (channel === 1 ? 2 : 1),
        replace: p.replace,
        bytes: [],
      });
      return;
    }
    const hit = this.source.read(p.name);
    if (!hit) {
      this.setStatus(62);
      this.channels.set(channel, { kind: 'error' });
      return;
    }
    this.setStatus(0);
    this.channels.set(channel, { kind: 'read', data: hit.data, pos: 0 });
  }

  read(channel: number): { byte: number; eof: boolean } {
    const ch = this.channels.get(channel);
    if (!ch) {
      this.setStatus(61);
      return { byte: 0x0d, eof: true };
    }
    if (ch.kind === 'command' || (channel === 15 && ch.kind === 'error')) {
      if (!this.statusBytes) {
        this.statusBytes = petscii(this.statusText().replace(/\r$/, '')).slice();
        const withCr = new Uint8Array(this.statusBytes.length + 1);
        withCr.set(this.statusBytes);
        withCr[this.statusBytes.length] = 0x0d;
        this.statusBytes = withCr;
        this.statusPos = 0;
      }
      const byte = this.statusBytes[this.statusPos++]!;
      const eof = this.statusPos >= this.statusBytes.length;
      if (eof) this.setStatus(0);
      return { byte, eof };
    }
    if (ch.kind !== 'read') return { byte: 0x0d, eof: true };
    if (ch.pos >= ch.data.length) return { byte: 0x0d, eof: true };
    const byte = ch.data[ch.pos++]!;
    return { byte, eof: ch.pos >= ch.data.length };
  }

  write(channel: number, byte: number): void {
    const ch = this.channels.get(channel);
    if (!ch) {
      this.setStatus(61);
      return;
    }
    if (ch.kind === 'write') {
      ch.bytes.push(byte & 0xff);
    } else if (ch.kind === 'command') {
      // CBM DOS executes the command when the line is terminated (UNLISTEN / carriage return).
      if ((byte & 0xff) === 0x0d) {
        const cmd = Uint8Array.from(this.pendingCommand);
        this.pendingCommand = [];
        if (cmd.length > 0) this.command(cmd);
      } else {
        this.pendingCommand.push(byte & 0xff);
      }
    }
  }

  private pendingCommand: number[] = [];

  close(channel: number): void {
    this.closeChannel(channel);
  }

  private closeChannel(channel: number): void {
    const ch = this.channels.get(channel);
    this.channels.delete(channel);
    if (!ch) return;
    if (ch.kind === 'write') {
      const code = this.store(
        {
          name: ch.name,
          pattern: ch.name,
          replace: ch.replace,
          dir: false,
          type: ch.type,
          mode: 'w',
        },
        ch.type,
        Uint8Array.from(ch.bytes),
      );
      this.setStatus(code);
    } else if (ch.kind === 'command' && this.pendingCommand.length > 0) {
      const cmd = Uint8Array.from(this.pendingCommand);
      this.pendingCommand = [];
      this.command(cmd);
    }
  }

  closeAll(): void {
    for (const c of [...this.channels.keys()]) this.closeChannel(c);
    this.pendingCommand = [];
  }

  // ---- DOS commands ------------------------------------------------------------

  private command(raw: Uint8Array): void {
    const text = toText(raw).replace(/\r$/, '');
    if (!this.source) return this.setStatus(74);
    const letter = text[0] ?? '';
    const colon = text.indexOf(':');
    const arg = colon >= 0 ? text.slice(colon + 1) : text.slice(1);
    const needsWrite = 'SNVRC'.includes(letter);
    if (needsWrite && !(this.source instanceof D64Source)) return this.setStatus(26);
    const image = this.source instanceof D64Source ? this.source.image : null;
    switch (letter) {
      case 'S': {
        let count = 0;
        for (const part of arg.split(',')) {
          const pat = petscii(part.replace(/^\d*:?/, ''));
          for (const e of image!.entries()) {
            if (matchName(pat, e.name) && !e.locked) {
              image!.scratch(e);
              count++;
            }
          }
        }
        return this.setStatus(1, count, 0);
      }
      case 'N': {
        const [name = '', id] = arg.split(',');
        image!.format(name, id);
        return this.setStatus(0);
      }
      case 'V':
        image!.validate();
        return this.setStatus(0);
      case 'I':
        return this.setStatus(0);
      case 'R': {
        const [to = '', from = ''] = arg.split('=');
        const entry = image!.entries().find((e) => matchName(petscii(from), e.name));
        if (!entry) return this.setStatus(62);
        if (image!.entries().some((e) => matchName(petscii(to), e.name))) return this.setStatus(63);
        image!.rename(entry, petscii(to));
        return this.setStatus(0);
      }
      case 'C': {
        const [to = '', from = ''] = arg.split('=');
        const entry = image!.entries().find((e) => matchName(petscii(from), e.name));
        if (!entry) return this.setStatus(62);
        const data = image!.readFile(entry);
        const code = this.store(
          {
            name: petscii(to),
            pattern: petscii(to),
            replace: false,
            dir: false,
            type: entry.type,
            mode: 'w',
          },
          entry.type,
          data,
        );
        return this.setStatus(code);
      }
      default:
        return this.setStatus(31);
    }
  }
}
