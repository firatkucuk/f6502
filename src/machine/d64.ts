export const BLOCK = 256;
const DIR_TRACK = 18;
const FILE_INTERLEAVE = 10;
const DIR_INTERLEAVE = 3;

export class DiskError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'DiskError';
  }
}

export function sectorsInTrack(track: number): number {
  return track <= 17 ? 21 : track <= 24 ? 19 : track <= 30 ? 18 : 17;
}

export function petscii(s: string): Uint8Array {
  return Uint8Array.from(s.toUpperCase(), (c) => c.charCodeAt(0) & 0xff);
}

/** Trailing-$A0-trimmed bytes to text (shifted letters $C1-$DA map to A-Z). */
export function toText(name: Uint8Array): string {
  let s = '';
  for (const b of name) {
    if (b === 0xa0) break;
    s += String.fromCharCode(b >= 0xc1 && b <= 0xda ? b - 0x80 : b);
  }
  return s;
}

export interface DirEntry {
  slot: number;
  name: Uint8Array;
  /** 0 DEL, 1 SEQ, 2 PRG, 3 USR, 4 REL */
  type: number;
  closed: boolean;
  locked: boolean;
  track: number;
  sector: number;
  blocks: number;
}

const SIZES: Record<number, { tracks: 35 | 40; errors: boolean }> = {
  174848: { tracks: 35, errors: false },
  175531: { tracks: 35, errors: true },
  196608: { tracks: 40, errors: false },
  197376: { tracks: 40, errors: true },
};

export class D64 {
  readonly tracks: 35 | 40;
  private readonly data: Uint8Array;
  private readonly errors: Uint8Array | null;
  private readonly trackStart: number[] = [0];

  constructor(bytes: Uint8Array) {
    const info = SIZES[bytes.length];
    if (!info) throw new DiskError(74, `not a D64 image (size ${bytes.length})`);
    this.tracks = info.tracks;
    let total = 0;
    for (let t = 1; t <= this.tracks; t++) {
      this.trackStart[t] = total;
      total += sectorsInTrack(t);
    }
    this.data = bytes.slice(0, total * BLOCK);
    this.errors = info.errors ? bytes.slice(total * BLOCK) : null;
  }

  static format(name: string, id: string, tracks: 35 | 40 = 35): D64 {
    let total = 0;
    for (let t = 1; t <= tracks; t++) total += sectorsInTrack(t);
    const d = new D64(new Uint8Array(total * BLOCK));
    d.format(name, id);
    return d;
  }

  /** Reinitialise the BAM and the directory; keeps the old id when `id` is omitted. */
  format(name: string, id?: string): void {
    const keepId = id === undefined ? this.diskId().slice() : petscii(id);
    this.data.fill(0);
    this.errors?.fill(0);
    const bam = this.sector(DIR_TRACK, 0);
    bam[0] = DIR_TRACK;
    bam[1] = 1;
    bam[2] = 0x41;
    bam.fill(0xa0, 0x90, 0xab);
    this.setHeader(name, keepId);
    for (let t = 1; t <= this.tracks; t++) {
      for (let s = 0; s < sectorsInTrack(t); s++) this.setFree(t, s, true);
    }
    this.setFree(DIR_TRACK, 0, false);
    this.setFree(DIR_TRACK, 1, false);
    const dir = this.sector(DIR_TRACK, 1);
    dir[0] = 0;
    dir[1] = 0xff;
  }

  private setHeader(name: string, id: Uint8Array): void {
    const bam = this.sector(DIR_TRACK, 0);
    bam.fill(0xa0, 0x90, 0xab);
    const n = petscii(name).slice(0, 16);
    bam.set(n, 0x90);
    bam[0xa2] = id[0] ?? 0x30;
    bam[0xa3] = id[1] ?? 0x30;
    bam[0xa5] = 0x32;
    bam[0xa6] = 0x41;
  }

  diskName(): Uint8Array {
    return this.sector(DIR_TRACK, 0).slice(0x90, 0xa0);
  }

  diskId(): Uint8Array {
    return this.sector(DIR_TRACK, 0).slice(0xa2, 0xa4);
  }

  private sector(track: number, sector: number): Uint8Array {
    if (track < 1 || track > this.tracks || sector < 0 || sector >= sectorsInTrack(track)) {
      throw new DiskError(66, `illegal track and sector ${track}/${sector}`);
    }
    const o = (this.trackStart[track]! + sector) * BLOCK;
    return this.data.subarray(o, o + BLOCK);
  }

  // ---- BAM ---------------------------------------------------------------

  private bamEntry(track: number): number {
    const base = this.trackStart[DIR_TRACK]! * BLOCK;
    return base + (track <= 35 ? 4 + 4 * (track - 1) : 0xc0 + 4 * (track - 36));
  }

  isFree(track: number, sector: number): boolean {
    const o = this.bamEntry(track);
    return ((this.data[o + 1 + (sector >> 3)]! >> (sector & 7)) & 1) === 1;
  }

  private setFree(track: number, sector: number, free: boolean): void {
    const o = this.bamEntry(track);
    const idx = o + 1 + (sector >> 3);
    const bit = 1 << (sector & 7);
    const was = (this.data[idx]! & bit) !== 0;
    if (free === was) return;
    if (free) {
      this.data[idx]! |= bit;
      this.data[o]!++;
    } else {
      this.data[idx]! &= ~bit;
      this.data[o]!--;
    }
  }

  freeBlocks(): number {
    let n = 0;
    for (let t = 1; t <= this.tracks; t++) if (t !== DIR_TRACK) n += this.data[this.bamEntry(t)]!;
    return n;
  }

  /** Tracks ordered by distance from the directory track: 17, 19, 16, 20, ... */
  private trackOrder(): number[] {
    const order: number[] = [];
    for (let d = 1; d < this.tracks; d++) {
      if (DIR_TRACK - d >= 1) order.push(DIR_TRACK - d);
      if (DIR_TRACK + d <= this.tracks) order.push(DIR_TRACK + d);
    }
    return order;
  }

  private findOnTrack(track: number, from: number): number {
    const n = sectorsInTrack(track);
    for (let i = 0; i < n; i++) {
      const s = (from + i) % n;
      if (this.isFree(track, s)) return s;
    }
    return -1;
  }

  /** Next data sector: stays on the current track while it has room, else the nearest track. */
  private allocData(prev: { t: number; s: number } | null): { t: number; s: number } | null {
    if (prev) {
      const s = this.findOnTrack(prev.t, (prev.s + FILE_INTERLEAVE) % sectorsInTrack(prev.t));
      if (s >= 0) return { t: prev.t, s };
    }
    for (const t of this.trackOrder()) {
      const s = this.findOnTrack(t, 0);
      if (s >= 0) return { t, s };
    }
    return null;
  }

  // ---- directory -----------------------------------------------------------

  /** Directory sectors in chain order (guarded against loops). */
  private dirSectors(): Array<{ t: number; s: number }> {
    const out: Array<{ t: number; s: number }> = [];
    const seen = new Set<number>();
    let t = DIR_TRACK;
    let s = 1;
    while (t !== 0 && out.length < 64) {
      const key = t * 64 + s;
      if (seen.has(key)) break;
      seen.add(key);
      let sec: Uint8Array;
      try {
        sec = this.sector(t, s);
      } catch {
        break;
      }
      out.push({ t, s });
      t = sec[0]!;
      s = sec[1]!;
    }
    return out;
  }

  entries(): DirEntry[] {
    const out: DirEntry[] = [];
    let slot = 0;
    for (const { t, s } of this.dirSectors()) {
      const sec = this.sector(t, s);
      for (let i = 0; i < 8; i++, slot++) {
        const o = i * 32;
        const typeByte = sec[o + 2]!;
        if (typeByte === 0) continue;
        out.push({
          slot,
          name: this.trimName(sec.subarray(o + 5, o + 21)),
          type: typeByte & 7,
          closed: (typeByte & 0x80) !== 0,
          locked: (typeByte & 0x40) !== 0,
          track: sec[o + 3]!,
          sector: sec[o + 4]!,
          blocks: sec[o + 28]! | (sec[o + 29]! << 8),
        });
      }
    }
    return out;
  }

  private trimName(raw: Uint8Array): Uint8Array {
    let n = raw.length;
    while (n > 0 && raw[n - 1] === 0xa0) n--;
    return raw.slice(0, n);
  }

  private slotRef(slot: number): { sec: Uint8Array; o: number } | null {
    const sectors = this.dirSectors();
    const s = sectors[slot >> 3];
    if (!s) return null;
    return { sec: this.sector(s.t, s.s), o: (slot & 7) * 32 };
  }

  private freeSlot(): { sec: Uint8Array; o: number; slot: number } {
    const sectors = this.dirSectors();
    for (let si = 0; si < sectors.length; si++) {
      const sec = this.sector(sectors[si]!.t, sectors[si]!.s);
      for (let i = 0; i < 8; i++)
        if (sec[i * 32 + 2] === 0) return { sec, o: i * 32, slot: si * 8 + i };
    }
    // grow the directory: new sector on the directory track, interleave 3
    const last = sectors[sectors.length - 1]!;
    const s = this.findOnTrack(DIR_TRACK, (last.s + DIR_INTERLEAVE) % sectorsInTrack(DIR_TRACK));
    if (s < 0) throw new DiskError(72, 'disk full (directory)');
    this.setFree(DIR_TRACK, s, false);
    this.sector(last.t, last.s)[0] = DIR_TRACK;
    this.sector(last.t, last.s)[1] = s;
    const sec = this.sector(DIR_TRACK, s);
    sec.fill(0);
    sec[1] = 0xff;
    return { sec, o: 0, slot: sectors.length * 8 };
  }

  // ---- files ---------------------------------------------------------------

  readFile(e: DirEntry): Uint8Array {
    const chunks: Uint8Array[] = [];
    const seen = new Set<number>();
    let t = e.track;
    let s = e.sector;
    let total = 0;
    while (t !== 0 && total < BLOCK * 800) {
      const key = t * 64 + s;
      if (seen.has(key)) break;
      seen.add(key);
      let sec: Uint8Array;
      try {
        sec = this.sector(t, s);
      } catch {
        break;
      }
      const nt = sec[0]!;
      const ns = sec[1]!;
      const chunk = nt !== 0 ? sec.subarray(2, 256) : sec.subarray(2, Math.max(2, ns) + 1);
      chunks.push(chunk);
      total += chunk.length;
      t = nt;
      s = ns;
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }

  private find(name: Uint8Array): DirEntry | undefined {
    return this.entries().find(
      (e) => e.name.length === name.length && e.name.every((b, i) => b === name[i]),
    );
  }

  writeFile(name: Uint8Array, type: number, data: Uint8Array): DirEntry {
    const trimmed = this.trimName(name.slice(0, 16));
    if (trimmed.length === 0) throw new DiskError(34, 'syntax error: empty name');
    if (this.find(trimmed)) throw new DiskError(63, 'file exists');
    const need = Math.max(1, Math.ceil(data.length / 254));
    if (need > this.freeBlocks()) throw new DiskError(72, 'disk full');
    // The slot may grow the directory by one (empty, linked) sector even if the data then does
    // not fit; the data blocks themselves are rolled back on failure.
    const slotInfo = this.freeSlot();
    const chain: Array<{ t: number; s: number }> = [];
    let prev: { t: number; s: number } | null = null;
    for (let i = 0; i < need; i++) {
      const next = this.allocData(prev);
      if (!next) {
        for (const c of chain) this.setFree(c.t, c.s, true);
        throw new DiskError(72, 'disk full');
      }
      this.setFree(next.t, next.s, false);
      chain.push(next);
      prev = next;
    }
    for (let i = 0; i < chain.length; i++) {
      const sec = this.sector(chain[i]!.t, chain[i]!.s);
      sec.fill(0);
      const chunk = data.subarray(i * 254, (i + 1) * 254);
      sec.set(chunk, 2);
      if (i < chain.length - 1) {
        sec[0] = chain[i + 1]!.t;
        sec[1] = chain[i + 1]!.s;
      } else {
        sec[0] = 0;
        sec[1] = chunk.length + 1;
      }
    }
    const { sec, o } = slotInfo;
    sec.fill(0, o + 3, o + 32);
    sec[o + 2] = 0x80 | (type & 7);
    sec[o + 3] = chain[0]!.t;
    sec[o + 4] = chain[0]!.s;
    sec.fill(0xa0, o + 5, o + 21);
    sec.set(trimmed, o + 5);
    sec[o + 28] = chain.length & 0xff;
    sec[o + 29] = chain.length >> 8;
    return {
      slot: slotInfo.slot,
      name: trimmed,
      type: type & 7,
      closed: true,
      locked: false,
      track: chain[0]!.t,
      sector: chain[0]!.s,
      blocks: chain.length,
    };
  }

  scratch(e: DirEntry): void {
    const seen = new Set<number>();
    let t = e.track;
    let s = e.sector;
    while (t !== 0 && !seen.has(t * 64 + s)) {
      seen.add(t * 64 + s);
      let sec: Uint8Array;
      try {
        sec = this.sector(t, s);
      } catch {
        break;
      }
      this.setFree(t, s, true);
      t = sec[0]!;
      s = sec[1]!;
    }
    const ref = this.slotRef(e.slot);
    if (ref) ref.sec[ref.o + 2] = 0;
  }

  rename(e: DirEntry, name: Uint8Array): void {
    const ref = this.slotRef(e.slot);
    if (!ref) return;
    ref.sec.fill(0xa0, ref.o + 5, ref.o + 21);
    ref.sec.set(this.trimName(name.slice(0, 16)), ref.o + 5);
  }

  /** Rebuild the BAM (bitmaps and counts) from the directory and the file chains. */
  validate(): void {
    const used = new Set<number>();
    const mark = (t: number, s: number) => used.add(t * 64 + s);
    mark(DIR_TRACK, 0);
    for (const d of this.dirSectors()) mark(d.t, d.s);
    for (const e of this.entries()) {
      const seen = new Set<number>();
      let t = e.track;
      let s = e.sector;
      while (t !== 0 && !seen.has(t * 64 + s)) {
        seen.add(t * 64 + s);
        let sec: Uint8Array;
        try {
          sec = this.sector(t, s);
        } catch {
          break;
        }
        mark(t, s);
        t = sec[0]!;
        s = sec[1]!;
      }
    }
    for (let t = 1; t <= this.tracks; t++) {
      const o = this.bamEntry(t);
      this.data.fill(0, o, o + 4);
      let free = 0;
      for (let s = 0; s < sectorsInTrack(t); s++) {
        if (!used.has(t * 64 + s)) {
          this.data[o + 1 + (s >> 3)]! |= 1 << (s & 7);
          free++;
        }
      }
      this.data[o] = free;
    }
  }

  export(): Uint8Array {
    if (!this.errors) return this.data.slice();
    const out = new Uint8Array(this.data.length + this.errors.length);
    out.set(this.data, 0);
    out.set(this.errors, this.data.length);
    return out;
  }
}
