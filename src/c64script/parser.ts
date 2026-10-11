import { isMnemonic, takesOperand } from './asm';
import { ParseError } from './errors';
import type { Token, TokenKind } from './token';
import type {
  Program,
  Decl,
  Stmt,
  Expr,
  PsType,
  VarAnnotation,
  HardwareField,
  HardwareFieldAccess,
  AsmExpr,
  AsmItem,
  AsmOperand,
} from './ast';

export function parse(tokens: Token[]): Program {
  let pos = 0;

  function peek(offset = 0): Token {
    return tokens[pos + offset] ?? tokens[tokens.length - 1]!;
  }
  function at(kind: TokenKind): boolean {
    return peek().kind === kind;
  }
  function eat(kind: TokenKind): Token {
    if (!at(kind))
      throw new ParseError(
        `expected ${kind}, got ${peek().kind} ('${peek().text}')`,
        peek().line,
        peek().col,
      );
    return tokens[pos++]!;
  }
  function maybe(kind: TokenKind): Token | null {
    return at(kind) ? tokens[pos++]! : null;
  }

  function parseType(): PsType {
    if (maybe('u8')) return { tag: 'u8' };
    if (maybe('u16')) return { tag: 'u16' };
    if (maybe('bool')) return { tag: 'bool' };
    if (maybe('void')) return { tag: 'void' };
    if (maybe('ptr')) {
      eat('lt');
      const elem = parseType();
      eat('gt');
      return { tag: 'ptr', elem };
    }
    if (maybe('lbracket')) {
      const elem = parseType();
      eat('semicolon');
      const sizeTok = eat('int_lit');
      eat('rbracket');
      return { tag: 'array', elem, size: parseIntLit(sizeTok.text) };
    }
    if (at('ident')) {
      const name = eat('ident').text;
      return { tag: 'struct', name };
    }
    throw new ParseError(`expected type`, peek().line, peek().col);
  }

  function parseAnnotation(): VarAnnotation {
    if (!at('at')) return { kind: 'none' };
    eat('at');
    const name = eat('ident').text;
    if (name === 'zp') return { kind: 'zp' };
    if (name === 'addr') {
      eat('lparen');
      const addr = parseIntLit(eat('int_lit').text);
      eat('rparen');
      return { kind: 'addr', address: addr };
    }
    throw new ParseError(`unknown annotation @${name}`, peek().line, peek().col);
  }

  function parseHardwareAccess(): HardwareFieldAccess {
    if (maybe('readonly')) return 'readonly';
    if (maybe('writeonly')) return 'writeonly';
    if (maybe('read_to_clear')) return 'read_to_clear';
    return 'rw';
  }

  function parseDecl(): Decl {
    const l = peek().line,
      c = peek().col;
    if (at('at') && peek(1).text === 'inline') {
      eat('at');
      eat('inline');
      return parseFnDecl(true, l);
    }
    if (at('fn')) return parseFnDecl(false, l);
    if (at('struct')) return parseStructDecl(l);
    if (at('hardware')) return parseHardwareDecl(l);
    if (at('data')) return parseDataDecl(l);
    if (at('program')) return parseProgramDecl(l);
    if (at('const') || at('let') || at('at')) return parseVarDecl(l);
    throw new ParseError(`unexpected token ${peek().kind}`, l, c);
  }

  function parseFnDecl(isInline: boolean, line: number): Decl {
    eat('fn');
    const name = eat('ident').text;
    eat('lparen');
    const params: { name: string; type: PsType }[] = [];
    while (!at('rparen') && !at('eof')) {
      const pname = eat('ident').text;
      eat('colon');
      const ptype = parseType();
      params.push({ name: pname, type: ptype });
      maybe('comma');
    }
    eat('rparen');
    eat('colon');
    const ret = parseType();
    const body = parseBlock();
    return { tag: 'fn', name, params, ret, body, isInline, line };
  }

  function parseStructDecl(line: number): Decl {
    eat('struct');
    const name = eat('ident').text;
    eat('lbrace');
    const fields: { name: string; type: PsType }[] = [];
    while (!at('rbrace') && !at('eof')) {
      const fname = eat('ident').text;
      eat('colon');
      const ftype = parseType();
      maybe('comma');
      fields.push({ name: fname, type: ftype });
    }
    eat('rbrace');
    return { tag: 'struct', name, fields, line };
  }

  function parseHardwareDecl(line: number): Decl {
    eat('hardware');
    const name = eat('ident').text;
    eat('at');
    const base = parseIntLit(eat('int_lit').text);
    eat('lbrace');
    const fields: HardwareField[] = [];
    while (!at('rbrace') && !at('eof')) {
      const access = parseHardwareAccess();
      const fname = eat('ident').text;
      eat('colon');
      const ftype = parseType();
      eat('at');
      const offset = parseIntLit(eat('int_lit').text);
      maybe('comma');
      fields.push({ name: fname, type: ftype, offset, access });
    }
    eat('rbrace');
    return { tag: 'hardware', name, base, fields, line };
  }

  function parseDataDecl(line: number): Decl {
    eat('data');
    let annotation: VarAnnotation = { kind: 'none' };
    if (at('at') && peek(1).text === 'addr') annotation = parseAnnotation();
    eat('lbrace');
    const dataFields: { name: string; type: PsType; init: Expr[] }[] = [];
    while (!at('rbrace') && !at('eof')) {
      const fname = eat('ident').text;
      eat('colon');
      const ftype = parseType();
      eat('eq');
      const inits: Expr[] = [];
      if (at('lbracket')) {
        eat('lbracket');
        while (!at('rbracket') && !at('eof')) {
          inits.push(parseExpr());
          maybe('comma');
        }
        eat('rbracket');
      } else {
        inits.push(parseExpr());
      }
      eat('semicolon');
      dataFields.push({ name: fname, type: ftype, init: inits });
    }
    eat('rbrace');
    return { tag: 'data', annotation, fields: dataFields, line };
  }

  function parseProgramDecl(line: number): Decl {
    eat('program');
    eat('at');
    const address = parseIntLit(eat('int_lit').text);
    const body = parseBlock();
    return { tag: 'program', address, body, line };
  }

  function parseVarDecl(line: number): Decl {
    const isConst = maybe('const') !== null;
    if (!isConst) eat('let');
    const annotation = parseAnnotation();
    const name = eat('ident').text;
    eat('colon');
    const type = parseType();
    const init = maybe('eq') ? parseExpr() : null;
    eat('semicolon');
    return { tag: 'varDecl', name, type, annotation, isConst, init, line };
  }

  function parseBlock(): Stmt[] {
    eat('lbrace');
    const stmts: Stmt[] = [];
    while (!at('rbrace') && !at('eof')) stmts.push(parseStmt());
    eat('rbrace');
    return stmts;
  }

  function parseStmt(): Stmt {
    const l = peek().line;
    if (at('if')) return parseIf(l);
    if (at('while')) return parseWhile(l);
    if (at('for')) return parseFor(l);
    if (at('loop')) return parseLoop(l);
    if (at('break')) {
      eat('break');
      eat('semicolon');
      return { tag: 'break', line: l };
    }
    if (at('continue')) {
      eat('continue');
      eat('semicolon');
      return { tag: 'continue', line: l };
    }
    if (at('return')) return parseReturn(l);
    if (at('asm')) return parseAsm(l);
    if (
      at('let') ||
      at('const') ||
      (at('at') && (peek(1).text === 'zp' || peek(1).text === 'addr'))
    ) {
      return parseVarDecl(l) as unknown as Stmt;
    }
    const lhsExpr = parseExpr();
    const assignOps = [
      'eq',
      'pluseq',
      'minuseq',
      'stareq',
      'slasheq',
      'percenteq',
      'ampeq',
      'pipeeq',
      'careteq',
      'ltlteq',
      'gtgteq',
    ];
    if (assignOps.includes(peek().kind)) {
      const op = tokens[pos++]!.text;
      const rhs = parseExpr();
      eat('semicolon');
      return { tag: 'assign', lhs: lhsExpr, op, rhs, line: l };
    }
    if (at('plusplus') || at('minusminus')) {
      const opTok = tokens[pos++]!;
      const op = (opTok.kind === 'plusplus' ? '++' : '--') as '++' | '--';
      eat('semicolon');
      return { tag: 'incDec', lhs: lhsExpr, op, line: l };
    }
    eat('semicolon');
    return { tag: 'exprStmt', expr: lhsExpr, line: l };
  }

  function parseIf(line: number): Stmt {
    eat('if');
    eat('lparen');
    const cond = parseExpr();
    eat('rparen');
    const then = parseBlock();
    const elif: { cond: Expr; body: Stmt[] }[] = [];
    let els: Stmt[] | null = null;
    while (at('else')) {
      eat('else');
      if (at('if')) {
        eat('if');
        eat('lparen');
        const ec = parseExpr();
        eat('rparen');
        elif.push({ cond: ec, body: parseBlock() });
      } else {
        els = parseBlock();
        break;
      }
    }
    return { tag: 'if', cond, then, elif, els, line };
  }

  function parseWhile(line: number): Stmt {
    eat('while');
    eat('lparen');
    const cond = parseExpr();
    eat('rparen');
    return { tag: 'while', cond, body: parseBlock(), line };
  }

  function parseFor(line: number): Stmt {
    eat('for');
    eat('lparen');
    const init = parseStmt();
    const cond = parseExpr();
    eat('semicolon');
    // Parse post expression (no trailing semicolon — followed by ')')
    const postExpr = parseExpr();
    let post: Stmt;
    if (at('plusplus') || at('minusminus')) {
      const opTok = tokens[pos++]!;
      const op = (opTok.kind === 'plusplus' ? '++' : '--') as '++' | '--';
      post = { tag: 'incDec', lhs: postExpr, op, line: postExpr.line };
    } else {
      post = { tag: 'exprStmt', expr: postExpr, line: postExpr.line };
    }
    eat('rparen');
    return { tag: 'for', init, cond, post, body: parseBlock(), line };
  }

  function parseLoop(line: number): Stmt {
    eat('loop');
    return { tag: 'loop', body: parseBlock(), line };
  }

  function parseReturn(line: number): Stmt {
    eat('return');
    if (at('semicolon')) {
      eat('semicolon');
      return { tag: 'return', value: null, line };
    }
    const value = parseExpr();
    eat('semicolon');
    return { tag: 'return', value, line };
  }

  function parseAsm(line: number): Stmt {
    eat('asm');
    const clobbers: string[] = [];
    if (maybe('clobbers')) {
      eat('lparen');
      while (!at('rparen') && !at('eof')) {
        clobbers.push(eat('ident').text);
        maybe('comma');
      }
      eat('rparen');
    }
    eat('lbrace');
    const items: AsmItem[] = [];
    while (!at('rbrace') && !at('eof')) items.push(parseAsmItem());
    eat('rbrace');
    return { tag: 'asm', clobbers, items, line };
  }

  /** Any identifier-shaped token, including C64Script keywords: `loop:` is a very common label. */
  const isWord = (t: Token): boolean =>
    t.kind !== 'int_lit' && t.kind !== 'eof' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(t.text);

  function parseAsmItem(): AsmItem {
    const t = peek();
    if (!isWord(t)) {
      throw new ParseError(`expected an instruction or a label, got ${t.kind}`, t.line, t.col);
    }
    pos++;
    if (at('colon')) {
      pos++;
      if (isMnemonic(t.text)) {
        throw new ParseError(
          `'${t.text}' is an instruction and cannot be used as a label`,
          t.line,
          t.col,
        );
      }
      return { kind: 'label', name: t.text, line: t.line };
    }
    const mnemonic = t.text.toUpperCase();
    return { kind: 'instr', mnemonic, operand: parseAsmOperand(mnemonic, t.line), line: t.line };
  }

  /** The operand must start on the instruction's own line, so `dex` ⏎ `bne x` stays two items. */
  function parseAsmOperand(mnemonic: string, line: number): AsmOperand {
    const next = peek();
    if (next.line !== line || next.kind === 'rbrace' || next.kind === 'eof')
      return { kind: 'none' };
    if (isMnemonic(mnemonic) && !takesOperand(mnemonic)) return { kind: 'none' };
    if (isWord(next) && next.text.toLowerCase() !== 'a' && isMnemonic(next.text)) {
      return { kind: 'none' }; // `asl bne …` on one line: the next word starts a new instruction
    }

    if (at('hash')) {
      pos++;
      return { kind: 'imm', value: parseAsmExpr() };
    }
    if (at('lparen')) {
      pos++;
      const value = parseAsmExpr();
      if (maybe('comma')) {
        const reg = eat('ident');
        if (reg.text.toLowerCase() !== 'x') {
          throw new ParseError(`expected 'x' in (address,x), got '${reg.text}'`, reg.line, reg.col);
        }
        eat('rparen');
        return { kind: 'izx', value };
      }
      eat('rparen');
      if (maybe('comma')) {
        const reg = eat('ident');
        if (reg.text.toLowerCase() !== 'y') {
          throw new ParseError(`expected 'y' in (address),y, got '${reg.text}'`, reg.line, reg.col);
        }
        return { kind: 'izy', value };
      }
      return { kind: 'ind', value };
    }
    if (at('ident') && peek().text.toLowerCase() === 'a') {
      pos++;
      return { kind: 'acc' };
    }
    const value = parseAsmExpr();
    if (maybe('comma')) {
      const reg = eat('ident');
      const r = reg.text.toLowerCase();
      if (r !== 'x' && r !== 'y') {
        throw new ParseError(`expected x or y after ',', got '${reg.text}'`, reg.line, reg.col);
      }
      return { kind: 'addr', value, index: r };
    }
    return { kind: 'addr', value, index: null };
  }

  function parseAsmExpr(): AsmExpr {
    let e = parseAsmTerm();
    while (at('plus') || at('minus')) {
      const sign = tokens[pos++]!.kind === 'plus' ? 1 : -1;
      const n = eat('int_lit');
      e = { tag: 'add', lhs: e, offset: sign * parseIntLit(n.text), line: n.line };
    }
    return e;
  }

  function parseAsmTerm(): AsmExpr {
    const t = peek();
    pos++;
    if (t.kind === 'int_lit') return { tag: 'num', value: parseIntLit(t.text), line: t.line };
    if (t.kind === 'dollar_lbrace') {
      const expr = parseExpr();
      eat('rbrace');
      return { tag: 'sym', expr, line: t.line };
    }
    if (isWord(t)) {
      if ((t.text === 'lo' || t.text === 'hi') && at('lparen')) {
        pos++;
        const arg = parseAsmExpr();
        eat('rparen');
        return { tag: t.text, arg, line: t.line };
      }
      return { tag: 'label', name: t.text, line: t.line };
    }
    throw new ParseError(`unexpected ${t.kind} in an instruction operand`, t.line, t.col);
  }

  function parseExpr(minPrec = 0): Expr {
    let lhs = parseUnary();
    while (true) {
      const t = peek();
      const prec = binPrec(t.kind);
      if (prec < minPrec) break;
      pos++;
      if (t.kind === 'as') {
        const toType = parseType();
        lhs = { tag: 'cast', expr: lhs, toType, line: t.line };
      } else {
        const rhs = parseExpr(prec + 1);
        lhs = { tag: 'binary', op: t.text, lhs, rhs, line: t.line };
      }
    }
    return lhs;
  }

  function binPrec(kind: TokenKind): number {
    switch (kind) {
      case 'pipepipe':
        return 1;
      case 'ampamp':
        return 2;
      case 'pipe':
        return 3;
      case 'caret':
        return 4;
      case 'amp':
        return 5;
      case 'eqeq':
      case 'bangeq':
        return 6;
      case 'lt':
      case 'gt':
      case 'lteq':
      case 'gteq':
        return 7;
      case 'ltlt':
      case 'gtgt':
        return 8;
      case 'plus':
      case 'minus':
        return 9;
      case 'star':
      case 'slash':
      case 'percent':
        return 10;
      case 'as':
        return 11;
      default:
        return -1;
    }
  }

  function parseUnary(): Expr {
    const t = peek();
    if (t.kind === 'minus' || t.kind === 'tilde' || t.kind === 'bang') {
      pos++;
      return { tag: 'unary', op: t.text, rhs: parseUnary(), line: t.line };
    }
    return parsePostfix(parsePrimary());
  }

  function parsePostfix(expr: Expr): Expr {
    while (true) {
      if (at('dot')) {
        pos++;
        const field = eat('ident').text;
        expr = { tag: 'field', obj: expr, field, line: expr.line };
      } else if (at('lbracket')) {
        pos++;
        const idx = parseExpr();
        eat('rbracket');
        expr = { tag: 'index', obj: expr, idx, line: expr.line };
      } else {
        break;
      }
    }
    return expr;
  }

  function parsePrimary(): Expr {
    const t = peek();
    pos++;
    if (t.kind === 'int_lit') return { tag: 'intLit', value: parseIntLit(t.text), line: t.line };
    if (t.kind === 'str_lit') return { tag: 'strLit', codes: t.codes ?? [], line: t.line };
    if (t.kind === 'true') return { tag: 'boolLit', value: true, line: t.line };
    if (t.kind === 'false') return { tag: 'boolLit', value: false, line: t.line };
    if (t.kind === 'lparen') {
      const e = parseExpr();
      eat('rparen');
      return e;
    }
    if (t.kind === 'ident') {
      if ((t.text === 'lo' || t.text === 'hi') && at('lparen')) {
        eat('lparen');
        const e = parseExpr();
        eat('rparen');
        return { tag: t.text as 'lo' | 'hi', expr: e, line: t.line };
      }
      if (at('lparen')) {
        eat('lparen');
        const args: Expr[] = [];
        while (!at('rparen') && !at('eof')) {
          args.push(parseExpr());
          maybe('comma');
        }
        eat('rparen');
        return { tag: 'call', name: t.text, args, line: t.line };
      }
      return { tag: 'ident', name: t.text, line: t.line };
    }
    throw new ParseError(`unexpected token ${t.kind} ('${t.text}') in expression`, t.line, t.col);
  }

  function parseIntLit(text: string): number {
    const clean = text.replace(/_/g, '');
    if (clean.startsWith('0x') || clean.startsWith('0X')) return parseInt(clean, 16);
    if (clean.startsWith('0b') || clean.startsWith('0B')) return parseInt(clean.slice(2), 2);
    return parseInt(clean, 10);
  }

  const decls: Decl[] = [];
  while (!at('eof')) decls.push(parseDecl());
  return { decls };
}
