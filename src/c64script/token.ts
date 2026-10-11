export type TokenKind =
  // Keywords
  | 'fn'
  | 'let'
  | 'const'
  | 'struct'
  | 'hardware'
  | 'data'
  | 'program'
  | 'asm'
  | 'if'
  | 'else'
  | 'while'
  | 'for'
  | 'loop'
  | 'break'
  | 'continue'
  | 'return'
  | 'as'
  | 'clobbers'
  | 'inline'
  | 'readonly'
  | 'writeonly'
  | 'read_to_clear'
  | 'true'
  | 'false'
  | 'void'
  // Primitive types (also keywords)
  | 'u8'
  | 'u16'
  | 'bool'
  | 'ptr'
  // Punctuation
  | 'lbrace'
  | 'rbrace'
  | 'lparen'
  | 'rparen'
  | 'lbracket'
  | 'rbracket'
  | 'comma'
  | 'colon'
  | 'semicolon'
  | 'dot'
  | 'at'
  | 'hash'
  | 'lt'
  | 'gt'
  // Operators (single)
  | 'eq'
  | 'plus'
  | 'minus'
  | 'star'
  | 'slash'
  | 'percent'
  | 'amp'
  | 'pipe'
  | 'caret'
  | 'tilde'
  | 'bang'
  // Operators (double)
  | 'eqeq'
  | 'bangeq'
  | 'lteq'
  | 'gteq'
  | 'ltlt'
  | 'gtgt'
  | 'ampamp'
  | 'pipepipe'
  | 'plusplus'
  | 'minusminus'
  | 'arrow'
  // Compound assignment
  | 'pluseq'
  | 'minuseq'
  | 'stareq'
  | 'slasheq'
  | 'percenteq'
  | 'ampeq'
  | 'pipeeq'
  | 'careteq'
  | 'ltlteq'
  | 'gtgteq'
  // Asm interpolation
  | 'dollar_lbrace'
  // Literals / identifier
  | 'ident'
  | 'int_lit'
  | 'str_lit'
  | 'eof';

export interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  readonly line: number;
  readonly col: number;
  /** Screen codes of a string literal's characters (str_lit only). */
  readonly codes?: readonly number[];
}

const KEYWORDS: ReadonlyMap<string, TokenKind> = new Map([
  ['fn', 'fn'],
  ['let', 'let'],
  ['const', 'const'],
  ['struct', 'struct'],
  ['hardware', 'hardware'],
  ['data', 'data'],
  ['program', 'program'],
  ['asm', 'asm'],
  ['if', 'if'],
  ['else', 'else'],
  ['while', 'while'],
  ['for', 'for'],
  ['loop', 'loop'],
  ['break', 'break'],
  ['continue', 'continue'],
  ['return', 'return'],
  ['as', 'as'],
  ['clobbers', 'clobbers'],
  ['inline', 'inline'],
  ['readonly', 'readonly'],
  ['writeonly', 'writeonly'],
  ['read_to_clear', 'read_to_clear'],
  ['true', 'true'],
  ['false', 'false'],
  ['void', 'void'],
  ['u8', 'u8'],
  ['u16', 'u16'],
  ['bool', 'bool'],
  ['ptr', 'ptr'],
]);

export function identOrKeyword(text: string): TokenKind {
  return KEYWORDS.get(text) ?? 'ident';
}
