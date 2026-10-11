import { describe, expect, it } from 'vitest';
import { LexError } from '../../src/c64script/errors';
import { tokenize } from '../../src/c64script/lexer';

describe('errors', () => {
  it('LexError carries line/col', () => {
    const e = new LexError('bad char', 3, 7);
    expect(e.line).toBe(3);
    expect(e.col).toBe(7);
    expect(e.message).toContain('[3:7]');
  });
});

describe('lexer', () => {
  it('tokenizes a minimal program', () => {
    const toks = tokenize('let x: u8 = 0;');
    const kinds = toks.map((t) => t.kind);
    expect(kinds).toEqual(['let', 'ident', 'colon', 'u8', 'eq', 'int_lit', 'semicolon', 'eof']);
  });

  it('recognizes hex literals', () => {
    const [t] = tokenize('0xD020');
    expect(t?.kind).toBe('int_lit');
    expect(t?.text).toBe('0xD020');
  });

  it('recognizes binary literals', () => {
    const [t] = tokenize('0b11001100');
    expect(t?.kind).toBe('int_lit');
    expect(t?.text).toBe('0b11001100');
  });

  it('skips line comments', () => {
    const toks = tokenize('let x: u8 // comment\n= 0;');
    expect(toks.map((t) => t.kind)).toEqual([
      'let',
      'ident',
      'colon',
      'u8',
      'eq',
      'int_lit',
      'semicolon',
      'eof',
    ]);
  });

  it('tracks line numbers', () => {
    const toks = tokenize('let\nx: u8;');
    const x = toks.find((t) => t.text === 'x');
    expect(x?.line).toBe(2);
  });

  it('throws LexError on unknown character', () => {
    expect(() => tokenize('let x = `;')).toThrow(LexError);
  });

  it('tokenizes dollar_lbrace inside asm block', () => {
    const toks = tokenize('asm { lda ${count} }');
    expect(toks.some((t) => t.kind === 'dollar_lbrace')).toBe(true);
  });
});

describe('lexer: assembler tokens', () => {
  it('lexes $HEX as an integer literal', () => {
    const toks = tokenize('$D020 $1b $0');
    expect(toks.map((t) => `${t.kind}:${t.text}`)).toEqual([
      'int_lit:0xD020',
      'int_lit:0x1b',
      'int_lit:0x0',
      'eof:',
    ]);
  });

  it('lexes # as a token', () => {
    expect(tokenize('#5').map((t) => t.kind)).toEqual(['hash', 'int_lit', 'eof']);
  });

  it('keeps ${ as the interpolation opener', () => {
    expect(tokenize('${x}').map((t) => t.kind)).toEqual([
      'dollar_lbrace',
      'ident',
      'rbrace',
      'eof',
    ]);
  });

  it('rejects a lone $', () => {
    expect(() => tokenize('lda $ 5')).toThrow(/unexpected character '\$'/);
  });
});
