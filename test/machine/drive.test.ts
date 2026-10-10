import { describe, expect, it } from 'vitest';
import { D64, petscii } from '../../src/machine/d64';
import { D64Source, PrgSource } from '../../src/machine/container';
import { ImageDrive, parseFilename } from '../../src/machine/drive';

function drive() {
  const d = new ImageDrive(8);
  d.mount(new D64Source(D64.format('DISK', '01')));
  return d;
}
const text = (s: string) => petscii(s);
const prg = (...b: number[]) => Uint8Array.from([0x01, 0x08, ...b]);

describe('parseFilename', () => {
  it('handles drive prefixes, @ replace, type and mode suffixes and directories', () => {
    const p = (s: string) => parseFilename(text(s));
    expect(p('HELLO').name).toEqual(text('HELLO'));
    expect(p('0:HELLO').name).toEqual(text('HELLO'));
    expect(p('@0:HELLO').replace).toBe(true);
    expect(p('DATA,S,W')).toMatchObject({ type: 1, mode: 'w' });
    expect(p('$').dir).toBe(true);
    expect(p('$:A*').pattern).toEqual(text('A*'));
    expect(p('$0:A*').pattern).toEqual(text('A*'));
  });
});

describe('ImageDrive files', () => {
  it('saves and loads a program (PRG with its load address)', () => {
    const d = drive();
    expect(d.saveFile(text('GAME'), prg(1, 2, 3))).toBe(0);
    const r = d.loadFile(text('GAME'));
    expect('data' in r && [...r.data]).toEqual([1, 8, 1, 2, 3]);
  });

  it('LOAD "$" returns the directory listing; a missing file is error 62', () => {
    const d = drive();
    d.saveFile(text('A'), prg(0));
    const dir = d.loadFile(text('$'));
    expect('data' in dir && dir.data[0]).toBe(1);
    expect(d.loadFile(text('NOPE'))).toEqual({ error: 62 });
  });

  it('refuses to overwrite without @ and replaces with @', () => {
    const d = drive();
    d.saveFile(text('A'), prg(1));
    expect(d.saveFile(text('A'), prg(2))).toBe(63);
    expect(d.saveFile(text('@0:A'), prg(2))).toBe(0);
    const r = d.loadFile(text('A'));
    expect('data' in r && r.data[2]).toBe(2);
  });

  it('reports disk full and write protect (T64/PRG sources)', () => {
    const d = drive();
    expect(d.saveFile(text('BIG'), new Uint8Array(254 * 700))).toBe(72);
    const ro = new ImageDrive(8);
    ro.mount(new PrgSource(prg(1), 'P'));
    expect(ro.saveFile(text('X'), prg(1))).toBe(26);
  });

  it('an unmounted drive reports DRIVE NOT READY', () => {
    expect(new ImageDrive(8).loadFile(text('A'))).toEqual({ error: 74 });
    expect(new ImageDrive(8).present).toBe(false);
  });
});

describe('ImageDrive channels', () => {
  it('writes a sequential file through a channel and reads it back', () => {
    const d = drive();
    d.open(2, text('DATA,S,W'));
    for (const c of text('HELLO')) d.write(2, c);
    d.close(2);
    d.open(3, text('DATA,S,R'));
    const got: number[] = [];
    for (let i = 0; i < 5; i++) got.push(d.read(3).byte);
    expect(String.fromCharCode(...got)).toBe('HELLO');
    expect(d.read(3).eof).toBe(true);
    d.close(3);
  });

  it('reading a missing file sets the error channel and returns end of file', () => {
    const d = drive();
    d.open(2, text('NOPE'));
    expect(d.read(2).eof).toBe(true);
    d.open(15, new Uint8Array(0));
    expect(d.statusText()).toMatch(/^62,FILE NOT FOUND,00,00/);
  });

  it('the command channel scratches files and reports the count', () => {
    const d = drive();
    d.saveFile(text('A1'), prg(1));
    d.saveFile(text('A2'), prg(1));
    d.open(15, text('S0:A*'));
    expect(d.statusText()).toMatch(/^01, FILES SCRATCHED,02,00/);
    expect(d.loadFile(text('A1'))).toEqual({ error: 62 });
  });

  it('N: formats, R: renames, V: validates, unknown commands are syntax errors', () => {
    const d = drive();
    d.saveFile(text('OLD'), prg(1));
    d.open(15, text('R:NEW=OLD'));
    expect(d.statusText()).toMatch(/^00, OK/);
    expect('data' in d.loadFile(text('NEW'))).toBe(true);
    d.open(15, text('V'));
    expect(d.statusText()).toMatch(/^00, OK/);
    d.open(15, text('N:BLANK,99'));
    expect(d.loadFile(text('NEW'))).toEqual({ error: 62 });
    d.open(15, text('XYZ'));
    expect(d.statusText()).toMatch(/^31,SYNTAX ERROR/);
  });

  it('exportD64 returns the modified image', () => {
    const d = drive();
    d.saveFile(text('A'), prg(1));
    const out = d.exportD64();
    const again = new ImageDrive(8);
    again.mount(new D64Source(new D64(out)));
    expect('data' in again.loadFile(text('A'))).toBe(true);
  });
});
