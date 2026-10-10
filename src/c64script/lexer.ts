import { LexError } from './errors';
import { type Token, type TokenKind, identOrKeyword } from './token';

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0, line = 1, col = 1;

  function peek(offset = 0): string { return src[i + offset] ?? ''; }
  function advance(): string {
    const ch = src[i++]!;
    if (ch === '\n') { line++; col = 1; } else { col++; }
    return ch;
  }
  function tok(kind: TokenKind, text: string, l = line, c = col): void {
    tokens.push({ kind, text, line: l, col: c });
  }

  while (i < src.length) {
    const l = line, c = col;
    const ch = peek();

    // whitespace
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { advance(); continue; }

    // line comment
    if (ch === '/' && peek(1) === '/') {
      while (i < src.length && peek() !== '\n') advance();
      continue;
    }

    // dollar_lbrace  ${
    if (ch === '$' && peek(1) === '{') {
      advance(); advance();
      tok('dollar_lbrace', '${', l, c);
      continue;
    }

    // hex literal
    if (ch === '0' && (peek(1) === 'x' || peek(1) === 'X')) {
      let s = ''; s += advance(); s += advance();
      while (/[0-9a-fA-F_]/.test(peek())) s += advance();
      tok('int_lit', s, l, c); continue;
    }

    // binary literal
    if (ch === '0' && (peek(1) === 'b' || peek(1) === 'B')) {
      let s = ''; s += advance(); s += advance();
      while (/[01_]/.test(peek())) s += advance();
      tok('int_lit', s, l, c); continue;
    }

    // decimal literal
    if (/[0-9]/.test(ch)) {
      let s = '';
      while (/[0-9_]/.test(peek())) s += advance();
      tok('int_lit', s, l, c); continue;
    }

    // identifier / keyword
    if (/[a-zA-Z_]/.test(ch)) {
      let s = '';
      while (/[a-zA-Z0-9_]/.test(peek())) s += advance();
      tok(identOrKeyword(s), s, l, c); continue;
    }

    // multi-char operators (consume ch first)
    advance();
    const next = peek();
    if (ch === '=' && next === '=')  { advance(); tok('eqeq',     '==', l, c); continue; }
    if (ch === '!' && next === '=')  { advance(); tok('bangeq',   '!=', l, c); continue; }
    if (ch === '<' && next === '<') {
      advance();
      if (peek() === '=') { advance(); tok('ltlteq', '<<=', l, c); } else tok('ltlt', '<<', l, c);
      continue;
    }
    if (ch === '>' && next === '>') {
      advance();
      if (peek() === '=') { advance(); tok('gtgteq', '>>=', l, c); } else tok('gtgt', '>>', l, c);
      continue;
    }
    if (ch === '<' && next === '=') { advance(); tok('lteq',   '<=', l, c); continue; }
    if (ch === '>' && next === '=') { advance(); tok('gteq',   '>=', l, c); continue; }
    if (ch === '-' && next === '>') { advance(); tok('arrow',   '->', l, c); continue; }
    if (ch === '+' && next === '+') { advance(); tok('plusplus',  '++', l, c); continue; }
    if (ch === '-' && next === '-') { advance(); tok('minusminus', '--', l, c); continue; }
    if (ch === '&' && next === '&') { advance(); tok('ampamp',   '&&', l, c); continue; }
    if (ch === '|' && next === '|') { advance(); tok('pipepipe', '||', l, c); continue; }
    if (ch === '+' && next === '=') { advance(); tok('pluseq',   '+=', l, c); continue; }
    if (ch === '-' && next === '=') { advance(); tok('minuseq',  '-=', l, c); continue; }
    if (ch === '*' && next === '=') { advance(); tok('stareq',   '*=', l, c); continue; }
    if (ch === '/' && next === '=') { advance(); tok('slasheq',  '/=', l, c); continue; }
    if (ch === '%' && next === '=') { advance(); tok('percenteq', '%=', l, c); continue; }
    if (ch === '&' && next === '=') { advance(); tok('ampeq',   '&=', l, c); continue; }
    if (ch === '|' && next === '=') { advance(); tok('pipeeq',  '|=', l, c); continue; }
    if (ch === '^' && next === '=') { advance(); tok('careteq', '^=', l, c); continue; }

    // single-char punctuation and operators
    const singles: Record<string, TokenKind> = {
      '{': 'lbrace', '}': 'rbrace', '(': 'lparen', ')': 'rparen',
      '[': 'lbracket', ']': 'rbracket', ',': 'comma', ':': 'colon',
      ';': 'semicolon', '.': 'dot', '@': 'at', '<': 'lt', '>': 'gt',
      '=': 'eq', '+': 'plus', '-': 'minus', '*': 'star', '/': 'slash',
      '%': 'percent', '&': 'amp', '|': 'pipe', '^': 'caret',
      '~': 'tilde', '!': 'bang',
    };
    const kind = singles[ch];
    if (kind) { tok(kind, ch, l, c); continue; }

    throw new LexError(`unexpected character '${ch}'`, l, c);
  }

  tok('eof', '', line, col);
  return tokens;
}
