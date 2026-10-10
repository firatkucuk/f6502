import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { C64 } from '../../src/machine/c64';
import { D64, petscii } from '../../src/machine/d64';
import { D64Source } from '../../src/machine/container';
import { encodeKernalTap } from './tap-encoder';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '.testdata');
const ROMS = join(ROOT, 'openroms', 'bin');
const read = (n: string) => new Uint8Array(readFileSync(join(ROMS, n)));

function boot(): C64 {
  const c64 = new C64({
    kernal: read('kernal_generic.rom'),
    basic: read('basic_generic.rom'),
    chargen: read('chargen_openroms.rom'),
  });
  expect(c64.runUntilReady(600)).toBe(true);
  return c64;
}

function run(c64: C64, text: string, frames = 40): string {
  c64.type(text);
  for (let i = 0; i < frames; i++) c64.runFrame();
  return c64.screenText().join('\n');
}

/** `10 PRINT"<text>"` as a tokenised BASIC PRG at $0801. */
function basicPrint(text: string): Uint8Array {
  const body = [0x99, 0x22, ...petscii(text), 0x22, 0x00];
  const next = 0x0801 + 4 + body.length;
  return Uint8Array.from([0x01, 0x08, next & 0xff, next >> 8, 0x0a, 0x00, ...body, 0x00, 0x00]);
}

function diskWith(files: Record<string, Uint8Array>): D64 {
  const d = D64.format('TEST DISK', '01');
  for (const [name, data] of Object.entries(files)) d.writeFile(petscii(name), 2, data);
  return d;
}

/** A tiny assembler for KERNAL channel calls (JSR through the jump table). */
class Asm {
  readonly bytes: number[] = [];
  private jsr(addr: number) {
    this.bytes.push(0x20, addr & 0xff, addr >> 8);
  }
  lda(v: number) {
    this.bytes.push(0xa9, v);
  }
  ldx(v: number) {
    this.bytes.push(0xa2, v);
  }
  ldy(v: number) {
    this.bytes.push(0xa0, v);
  }
  open(name: string, lf: number, sa: number) {
    const nameAddr = 0xc100;
    this.lda(name.length);
    this.ldx(nameAddr & 0xff);
    this.ldy(nameAddr >> 8);
    this.jsr(0xffbd); // SETNAM
    this.lda(lf);
    this.ldx(8);
    this.ldy(sa);
    this.jsr(0xffba); // SETLFS
    this.jsr(0xffc0); // OPEN
  }
  ckout(lf: number) {
    this.ldx(lf);
    this.jsr(0xffc9);
  }
  chkin(lf: number) {
    this.ldx(lf);
    this.jsr(0xffc6);
  }
  chrout(ch: number) {
    this.lda(ch);
    this.jsr(0xffd2);
  }
  chrinTo(addr: number) {
    this.jsr(0xffcf);
    this.bytes.push(0x8d, addr & 0xff, addr >> 8); // STA addr
  }
  clrchn() {
    this.jsr(0xffcc);
  }
  close(lf: number) {
    this.lda(lf);
    this.jsr(0xffc3);
  }
  done() {
    this.bytes.push(0x60); // RTS back to BASIC
  }
}

function openProgram(name: string, lf: number, sa: number, body: (a: Asm) => void) {
  const a = new Asm();
  a.open(name, lf, sa);
  body(a);
  a.done();
  return { code: a.bytes, name };
}

function runCode(c64: C64, p: { code: number[]; name: string }): void {
  petscii(p.name).forEach((b, i) => c64.pokeRam(0xc100 + i, b));
  p.code.forEach((b, i) => c64.pokeRam(0xc000 + i, b));
  run(c64, 'SYS49152\r', 20);
}

describe('disk on the OpenROMs boot', () => {
  it('lists the directory with LOAD"$",8 and LIST', () => {
    const c64 = boot();
    const d = diskWith({ HELLO: basicPrint('HI FROM DISK') });
    d.writeFile(petscii('DATA'), 1, new Uint8Array(10));
    c64.drive(8).mount(new D64Source(d));
    let screen = run(c64, 'LOAD"$",8\r');
    expect(screen).toContain('SEARCHING FOR $');
    expect(screen).toContain('LOADING');
    screen = run(c64, 'LIST\r');
    expect(screen).toContain('"TEST DISK');
    expect(screen).toContain('"HELLO"');
    expect(screen).toContain('PRG');
    expect(screen).toContain('"DATA"');
    expect(screen).toContain('SEQ');
    expect(screen).toContain('BLOCKS FREE.');
  });

  it('loads and runs a program', () => {
    const c64 = boot();
    c64.drive(8).mount(new D64Source(diskWith({ HELLO: basicPrint('HI FROM DISK') })));
    let screen = run(c64, 'LOAD"HELLO",8\r');
    expect(screen).toContain('SEARCHING FOR HELLO');
    expect(screen).toContain('LOADING');
    screen = run(c64, 'RUN\r');
    expect(screen).toContain('HI FROM DISK');
  });

  it('reports FILE NOT FOUND for a missing file on a mounted disk', () => {
    const c64 = boot();
    c64.drive(8).mount(new D64Source(diskWith({})));
    const screen = run(c64, 'LOAD"NOPE",8\r');
    expect(screen).toContain('?FILE NOT FOUND');
  });

  it('leaves an unmounted drive to the ROM', () => {
    const c64 = boot();
    const screen = run(c64, 'LOAD"HELLO",8\r');
    expect(screen).toContain('?DEVICE NOT PRESENT');
  });

  it('SAVEs a program that can be loaded again from the exported image', () => {
    const c64 = boot();
    c64.drive(8).mount(new D64Source(D64.format('BLANK', '01')));
    run(c64, '10 PRINT"SAVED"\r');
    const screen = run(c64, 'SAVE"MINE",8\r');
    expect(screen).toContain('SAVING MINE');
    const exported = c64.drive(8).exportD64();
    const c2 = boot();
    c2.drive(8).mount(new D64Source(new D64(exported)));
    run(c2, 'LOAD"MINE",8\r');
    expect(run(c2, 'RUN\r')).toContain('SAVED');
  });

  it('writes and reads a sequential file through the KERNAL channel routines', () => {
    const c64 = boot();
    c64.drive(8).mount(new D64Source(D64.format('BLANK', '01')));
    runCode(
      c64,
      openProgram('DATA,S,W', 2, 2, (a) => {
        a.ckout(2);
        for (const ch of petscii('HELLO')) a.chrout(ch);
        a.clrchn();
        a.close(2);
      }),
    );
    const d = c64.drive(8).loadFile(petscii('DATA'));
    expect('data' in d && String.fromCharCode(...d.data)).toBe('HELLO');
    runCode(
      c64,
      openProgram('DATA,S,R', 3, 2, (a) => {
        a.chkin(3);
        for (let i = 0; i < 5; i++) a.chrinTo(0xc300 + i);
        a.clrchn();
        a.close(3);
      }),
    );
    const got = Array.from({ length: 5 }, (_, i) => String.fromCharCode(c64.peek(0xc300 + i)));
    expect(got.join('')).toBe('HELLO');
  });

  it('exposes the DOS status through channel 15', () => {
    const c64 = boot();
    const d = c64.drive(8);
    d.mount(new D64Source(D64.format('BLANK', '01')));
    d.saveFile(petscii('GONE'), Uint8Array.from([1, 8, 1]));
    runCode(
      c64,
      openProgram('S:GONE', 15, 15, (a) => {
        a.chkin(15);
        for (let i = 0; i < 25; i++) a.chrinTo(0xc300 + i);
        a.clrchn();
        a.close(15);
      }),
    );
    const got = Array.from({ length: 25 }, (_, i) => String.fromCharCode(c64.peek(0xc300 + i)));
    expect(got.join('')).toBe('01, FILES SCRATCHED,01,00');
    expect(d.loadFile(petscii('GONE'))).toEqual({ error: 62 });
  });
});

describe('VICE vdrive fixture', () => {
  const img = join(ROOT, 'vdrive', 'vdrive', 'test.d64');
  it.skipIf(!existsSync(img))(
    'shows the directory of test.d64 consistently with the image model',
    () => {
      const bytes = new Uint8Array(readFileSync(img));
      const model = new D64(bytes);
      const c64 = boot();
      c64.drive(8).mount(new D64Source(model));
      run(c64, 'LOAD"$",8\r');
      const screen = run(c64, 'LIST\r', 60);
      expect(screen).toContain('BLOCKS FREE.');
      for (const e of model.entries().slice(0, 8)) {
        const name = String.fromCharCode(...e.name);
        expect(screen, `directory lists ${name}`).toContain(`"${name}"`);
      }
    },
  );
});

describe('tape on the OpenROMs boot', () => {
  it('loads a standard-format program through the KERNAL tape routine, in warp', () => {
    const c64 = boot();
    c64.tape.insert(encodeKernalTap('HELLO', basicPrint('FROM TAPE')));
    c64.tape.play(); // the OpenROMs dev build checks the sense line instead of asking for PLAY
    c64.type('LOAD"",1\r');
    let sawWarp = false;
    let loaded = false;
    for (let i = 0; i < 3000 && !loaded; i++) {
      c64.runFrame();
      sawWarp ||= c64.warp;
      loaded = !c64.tape.playing;
    }
    expect(sawWarp).toBe(true);
    for (let i = 0; i < 60; i++) c64.runFrame();
    expect(c64.warp).toBe(false);
    expect(run(c64, 'RUN\r')).toContain('FROM TAPE');
  });
});
