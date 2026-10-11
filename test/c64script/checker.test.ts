import { describe, expect, it } from 'vitest';
import { ZpAllocator } from '../../src/c64script/symbols';
import { tokenize } from '../../src/c64script/lexer';
import { parse } from '../../src/c64script/parser';
import { check } from '../../src/c64script/checker';
import { TypeError as PsTypeError } from '../../src/c64script/errors';

describe('ZpAllocator', () => {
  it('starts at $02', () => {
    const zp = new ZpAllocator();
    expect(zp.alloc(1)).toBe(0x02);
  });

  it('allocates sequentially', () => {
    const zp = new ZpAllocator();
    zp.alloc(1);
    expect(zp.alloc(2)).toBe(0x03);
  });

  it('throws when budget exhausted', () => {
    const zp = new ZpAllocator();
    expect(() => zp.alloc(246)).toThrow(); // 246 bytes would exceed $02..$F7 (245 available)
  });

  it('tracks used bytes', () => {
    const zp = new ZpAllocator();
    zp.alloc(3);
    expect(zp.used()).toBe(3);
  });
});

function compile(src: string) { return check(parse(tokenize(src))); }

describe('type checker', () => {
  it('resolves a @zp var address', () => {
    const cp = compile('let @zp x: u8 = 0; program @ 0xC000 {}');
    expect(cp.vars.get('x')?.zpAddr).toBe(0x02);
  });

  it('allocates sequential @zp vars', () => {
    const cp = compile('let @zp a: u8 = 0; let @zp b: u16 = 0; program @ 0xC000 {}');
    expect(cp.vars.get('a')?.zpAddr).toBe(0x02);
    expect(cp.vars.get('b')?.zpAddr).toBe(0x03); // a takes 1 byte
  });

  it('resolves @addr var to fixed address', () => {
    const cp = compile('let @addr(0xD020) reg: u8; program @ 0xC000 {}');
    expect(cp.vars.get('reg')?.absAddr).toBe(0xD020);
    expect(cp.vars.get('reg')?.zpAddr).toBeNull();
  });

  it('reads load address from program block', () => {
    const cp = compile('program @ 0xC000 {}');
    expect(cp.loadAddr).toBe(0xC000);
  });

  it('rejects duplicate variable names', () => {
    expect(() => compile('let x: u8 = 0; let x: u8 = 0; program @ 0xC000 {}')).toThrow(PsTypeError);
  });

  it('rejects write to readonly hardware field', () => {
    expect(() => compile('program @ 0xC000 { VIC2.rasterLine = 5; }')).toThrow(PsTypeError);
  });

  it('rejects read from writeonly hardware field', () => {
    expect(() => compile('program @ 0xC000 { let x: u8 = VIC2.rasterIRQ; }')).toThrow(PsTypeError);
  });

  it('rejects ZP overrun', () => {
    const many = Array.from({ length: 246 }, (_, i) => `let @zp v${i}: u8 = 0;`).join('\n');
    expect(() => compile(many + ' program @ 0xC000 {}')).toThrow(PsTypeError);
  });

  it('registers struct declarations', () => {
    const cp = compile('struct P { x: u8, y: u8, } let @zp p: P; program @ 0xC000 {}');
    expect(cp.structs.has('P')).toBe(true);
  });

  it('throws when no program block is present', () => {
    expect(() => compile('let @zp x: u8 = 0;')).toThrow(PsTypeError);
  });

  it('folds a const declaration to constValue', () => {
    const cp = compile('const myConst: u8 = 42; program @ 0xC000 {}');
    const v = cp.vars.get('myConst');
    expect(v?.constValue).toBe(42);
    expect(v?.isConst).toBe(true);
    expect(v?.zpAddr).toBeNull();
  });

  it('allocates an un-annotated let in zero page, with its initial value', () => {
    const cp = compile('let counter: u8 = 42; program @ 0xC000 {}');
    const v = cp.vars.get('counter');
    expect(v?.isConst).toBe(false);
    expect(v?.zpAddr).not.toBeNull();
    expect(v?.initValue).toBe(42);
  });

  it('folds color constant COLOR_BLACK to constValue 0', () => {
    const cp = compile('program @ 0xC000 {}');
    expect(cp.vars.get('COLOR_BLACK')?.constValue).toBe(0);
    expect(cp.vars.get('COLOR_WHITE')?.constValue).toBe(1);
  });

  it('throws when reading writeonly field inside binary expression', () => {
    expect(() => compile('program @ 0xC000 { let @zp x: u8 = VIC2.rasterIRQ + 1; }')).toThrow(PsTypeError);
  });
});
