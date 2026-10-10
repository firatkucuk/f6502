import { describe, expect, it } from 'vitest';
import { tokenize } from '../../src/c64script/lexer';
import { parse } from '../../src/c64script/parser';

function p(src: string) { return parse(tokenize(src)); }

describe('parser — types', () => {
  it('parses u8 variable declaration', () => {
    const prog = p('let x: u8 = 0;');
    expect(prog.decls).toHaveLength(1);
    const d = prog.decls[0]!;
    expect(d.tag).toBe('varDecl');
    if (d.tag === 'varDecl') {
      expect(d.name).toBe('x');
      expect(d.type).toEqual({ tag: 'u8' });
      expect(d.annotation).toEqual({ kind: 'none' });
    }
  });

  it('parses @zp annotation', () => {
    const prog = p('let @zp frame: u8 = 0;');
    const d = prog.decls[0]!;
    if (d.tag === 'varDecl') expect(d.annotation).toEqual({ kind: 'zp' });
  });

  it('parses @addr annotation', () => {
    const prog = p('let @addr(0xD020) borderReg: u8;');
    const d = prog.decls[0]!;
    if (d.tag === 'varDecl') expect(d.annotation).toEqual({ kind: 'addr', address: 0xD020 });
  });

  it('parses fixed array type', () => {
    const prog = p('let buf: [u8; 256];');
    const d = prog.decls[0]!;
    if (d.tag === 'varDecl') expect(d.type).toEqual({ tag: 'array', elem: { tag: 'u8' }, size: 256 });
  });

  it('parses ptr<u8> type', () => {
    const prog = p('let @zp p: ptr<u8> = 0x0400;');
    const d = prog.decls[0]!;
    if (d.tag === 'varDecl') expect(d.type).toEqual({ tag: 'ptr', elem: { tag: 'u8' } });
  });

  it('parses struct declaration', () => {
    const prog = p('struct Point { x: u8, y: u8, }');
    const d = prog.decls[0]!;
    expect(d.tag).toBe('struct');
    if (d.tag === 'struct') {
      expect(d.name).toBe('Point');
      expect(d.fields).toHaveLength(2);
    }
  });

  it('parses fn declaration', () => {
    const prog = p('fn add(a: u8, b: u8): u8 { return a; }');
    const d = prog.decls[0]!;
    expect(d.tag).toBe('fn');
    if (d.tag === 'fn') {
      expect(d.name).toBe('add');
      expect(d.params).toHaveLength(2);
      expect(d.ret).toEqual({ tag: 'u8' });
      expect(d.isInline).toBe(false);
    }
  });

  it('parses @inline fn', () => {
    const prog = p('@inline fn setBorder(c: u8): void {}');
    const d = prog.decls[0]!;
    if (d.tag === 'fn') expect(d.isInline).toBe(true);
  });

  it('parses hardware block', () => {
    const prog = p('hardware VIC2 @ 0xD000 { borderColor: u8 @ 0x20, }');
    const d = prog.decls[0]!;
    expect(d.tag).toBe('hardware');
    if (d.tag === 'hardware') {
      expect(d.name).toBe('VIC2');
      expect(d.base).toBe(0xD000);
      expect(d.fields[0]?.name).toBe('borderColor');
      expect(d.fields[0]?.offset).toBe(0x20);
    }
  });

  it('parses program block', () => {
    const prog = p('program @ 0xC000 { }');
    const d = prog.decls[0]!;
    expect(d.tag).toBe('program');
    if (d.tag === 'program') expect(d.address).toBe(0xC000);
  });

  it('parses if/else', () => {
    const prog = p('fn f(): void { if (x == 0) { return; } else { return; } }');
    const d = prog.decls[0]!;
    if (d.tag === 'fn') {
      const s = d.body[0]!;
      expect(s.tag).toBe('if');
    }
  });

  it('parses binary expression precedence', () => {
    const prog = p('let x: u8 = a + b * c;');
    const d = prog.decls[0]!;
    if (d.tag === 'varDecl' && d.init?.tag === 'binary') {
      expect(d.init.op).toBe('+');
      expect(d.init.rhs.tag).toBe('binary'); // b*c is the rhs
    }
  });
});
