import { CodeGenError } from './errors';
import { PROGRAM_SCOPE, foldConst, scopedName } from './checker';
import type { CheckedProgram, ResolvedVar } from './checker';
import { sizeOf } from './ast';
import type { Expr, Stmt } from './ast';

export type FixupKind =
  | { kind: 'branch8';   label: string }
  | { kind: 'abs16';     label: string }
  | { kind: 'zpByte';    varName: string }
  | { kind: 'absHiByte'; label: string }
  | { kind: 'absLoByte'; label: string };

export interface Fixup { offset: number; kind: FixupKind; }

export interface CodeBuffer {
  bytes: number[];
  labels: Map<string, number>;
  fixups: Fixup[];
  loadAddr: number;
}

type LoopContext = { breakLabel: string; continueLabel: string };

export function generate(cp: CheckedProgram): CodeBuffer {
  const bytes: number[] = [];
  const labels = new Map<string, number>();
  const fixups: Fixup[] = [];
  let labelCounter = 0;
  const loopStack: LoopContext[] = [];
  // Name of the function (or 'program') whose body is being generated: locals and parameters
  // live under `<scope>::<name>` in cp.vars.
  let scope = PROGRAM_SCOPE;
  let inlineDepth = 0;

  function lookup(name: string): ResolvedVar | undefined {
    return cp.vars.get(scopedName(scope, name)) ?? cp.vars.get(name);
  }

  const COMPARE_OPS = new Set(['==', '!=', '<', '>', '<=', '>=']);

  /** True when the expression has a 16-bit value (the code generator only does 8-bit math). */
  function isU16(e: Expr): boolean {
    switch (e.tag) {
      case 'intLit':
        return e.value > 0xff;
      case 'ident': {
        const v = lookup(e.name);
        if (v === undefined) return false;
        return v.isConst ? (v.constValue ?? 0) > 0xff : v.type.tag === 'u16';
      }
      case 'cast':
        return e.toType.tag === 'u16';
      case 'call':
        return cp.fns.get(e.name)?.decl.ret.tag === 'u16';
      case 'unary':
        return isU16(e.rhs);
      case 'binary':
        return COMPARE_OPS.has(e.op) ? false : isU16(e.lhs) || isU16(e.rhs);
      default:
        return false;
    }
  }

  function emit(...bs: number[]): void {
    for (const b of bs) bytes.push(b & 0xFF);
  }

  function emitLabel(name: string): void {
    labels.set(name, bytes.length);
  }

  function freshLabel(prefix: string): string {
    return `__${prefix}_${labelCounter++}`;
  }

  function addFixup(kind: FixupKind, n: number): void {
    fixups.push({ offset: bytes.length, kind });
    for (let i = 0; i < n; i++) emit(0x00);
  }

  function hwAddr(hwName: string, fieldName: string, line = 0): number {
    const hw = cp.hardware.get(hwName);
    if (!hw) throw new CodeGenError(`unknown hardware '${hwName}'`, line, 0);
    const f = hw.fields.find(field => field.name === fieldName);
    if (!f) throw new CodeGenError(`unknown field '${fieldName}' on '${hwName}'`, line, 0);
    return hw.base + f.offset;
  }

  function genStore(lhs: Expr): void {
    if (lhs.tag === 'ident') {
      const v = lookup(lhs.name);
      if (v && v.zpAddr !== null) {
        emit(0x85, v.zpAddr);
      } else if (v && v.absAddr !== null) {
        emit(0x8D, v.absAddr & 0xFF, (v.absAddr >> 8) & 0xFF);
      } else {
        throw new CodeGenError(`cannot assign to '${lhs.name}'`, lhs.line, 0);
      }
    } else if (lhs.tag === 'field' && lhs.obj.tag === 'ident') {
      const addr = hwAddr(lhs.obj.name, lhs.field, lhs.line);
      emit(0x8D, addr & 0xFF, (addr >> 8) & 0xFF);
    } else if (lhs.tag === 'index') {
      throw new CodeGenError('array indexing is not supported yet', lhs.line, 0);
    } else {
      throw new CodeGenError('invalid assignment target', lhs.line, 0);
    }
  }

  function genIncDec(lhs: Expr, op: '++' | '--'): void {
    if (lhs.tag === 'ident') {
      const v = lookup(lhs.name);
      if (v && v.type.tag === 'u16' && !v.isConst) {
        if (v.zpAddr === null) {
          throw new CodeGenError(`16-bit '${op}' needs a zero-page variable`, lhs.line, 0);
        }
        const z = v.zpAddr;
        if (op === '++') {
          emit(0xE6, z, 0xD0, 0x02, 0xE6, z + 1); // INC lo; BNE +2; INC hi
        } else {
          emit(0xA5, z, 0xD0, 0x02, 0xC6, z + 1, 0xC6, z); // LDA lo; BNE +2; DEC hi; DEC lo
        }
      } else if (v && v.zpAddr !== null) {
        emit(op === '++' ? 0xE6 : 0xC6, v.zpAddr);
      } else if (v && v.absAddr !== null) {
        emit(op === '++' ? 0xEE : 0xCE, v.absAddr & 0xFF, (v.absAddr >> 8) & 0xFF);
      } else {
        throw new CodeGenError(`cannot modify '${lhs.name}'`, lhs.line, 0);
      }
    } else if (lhs.tag === 'field' && lhs.obj.tag === 'ident') {
      const addr = hwAddr(lhs.obj.name, lhs.field, lhs.line);
      // Never INC/DEC on hardware registers — use LDA/ADC(SBC)/STA instead
      emit(0xAD, addr & 0xFF, (addr >> 8) & 0xFF); // LDA abs
      if (op === '++') {
        emit(0x18); // CLC
        emit(0x69, 0x01); // ADC #1
      } else {
        emit(0x38); // SEC
        emit(0xE9, 0x01); // SBC #1
      }
      emit(0x8D, addr & 0xFF, (addr >> 8) & 0xFF); // STA abs
    } else {
      throw new CodeGenError(`cannot apply '${op}' here`, lhs.line, 0);
    }
  }

  // ─── Built-in: poke(addr: u16, val: u8) ────────────────────────────────
  function evalConst(e: Expr): number | null {
    return foldConst(e, lookup);
  }

  // ─── Built-in: clrscr() — clears screen RAM + color RAM ────────────────
  function genClrscr(): void {
    // Fill screen RAM $0400-$07E7 with spaces (0x20)
    emit(0xA9, 0x20);                        // LDA #' '
    emit(0xA2, 0x00);                        // LDX #0
    const scrLoop = bytes.length;
    emit(0x9D, 0x00, 0x04);                  // STA $0400,X
    emit(0x9D, 0x00, 0x05);                  // STA $0500,X
    emit(0x9D, 0x00, 0x06);                  // STA $0600,X
    emit(0xE8);                              // INX
    emit(0xD0, (scrLoop - bytes.length - 2) & 0xFF); // BNE scrLoop
    // Last partial page: $0700-$07E7 (232 bytes), avoid sprite ptrs $07F8-$07FF
    // BNE (not BPL): X starts above 127, so N would be set after the first DEX.
    // STA $06FF,X with X = 232..1 covers $07E7 down to $0700.
    emit(0xA2, 232);                         // LDX #232
    const scrLoop2 = bytes.length;
    emit(0x9D, 0xFF, 0x06);                  // STA $06FF,X
    emit(0xCA);                              // DEX
    emit(0xD0, (scrLoop2 - bytes.length - 2) & 0xFF); // BNE scrLoop2
    // Fill color RAM $D800-$DBFF with black (0)
    emit(0xA9, 0x00);                        // LDA #0
    emit(0xA2, 0x00);                        // LDX #0
    const colLoop = bytes.length;
    emit(0x9D, 0x00, 0xD8);                  // STA $D800,X
    emit(0x9D, 0x00, 0xD9);                  // STA $D900,X
    emit(0x9D, 0x00, 0xDA);                  // STA $DA00,X
    emit(0xE8);                              // INX
    emit(0xD0, (colLoop - bytes.length - 2) & 0xFF); // BNE colLoop
    emit(0xA2, 232);                         // LDX #232
    const colLoop2 = bytes.length;
    emit(0x9D, 0xFF, 0xDA);                  // STA $DAFF,X  (covers $DB00..$DBE7)
    emit(0xCA);                              // DEX
    emit(0xD0, (colLoop2 - bytes.length - 2) & 0xFF); // BNE colLoop2
  }

  function genCall(e: Extract<Expr, { tag: 'call' }>): void {
    // ── built-in: poke(addr, val) ──────────────────────────────────────────
    if (e.name === 'poke') {
      const addrExpr = e.args[0];
      const valueExpr = e.args[1];
      if (addrExpr === undefined || valueExpr === undefined || e.args.length !== 2) {
        throw new CodeGenError('poke() takes an address and a value', e.line, 0);
      }
      const addrVal = evalConst(addrExpr);
      if (addrVal === null) {
        throw new CodeGenError('poke() address must be a compile-time constant', e.line, 0);
      }
      const byteVal = evalConst(valueExpr);
      if (byteVal !== null) emit(0xA9, byteVal & 0xFF);
      else genExpr(valueExpr);
      emit(0x8D, addrVal & 0xFF, (addrVal >> 8) & 0xFF);
      return;
    }
    // ── built-in: clrscr() ────────────────────────────────────────────────
    if (e.name === 'clrscr') { genClrscr(); return; }

    // ── user function: bind the arguments to its parameter slots, then call ──
    const fn = cp.fns.get(e.name);
    if (!fn) throw new CodeGenError(`undefined function '${e.name}'`, e.line, 0);

    const params = fn.decl.params;
    for (let i = 0; i < params.length; i++) {
      const arg = e.args[i];
      const param = params[i];
      const slot = param ? cp.vars.get(scopedName(e.name, param.name)) : undefined;
      if (arg === undefined || slot === undefined || slot.zpAddr === null) {
        throw new CodeGenError(`cannot pass argument ${i + 1} to '${e.name}'`, e.line, 0);
      }
      genExpr(arg);
      emit(0x85, slot.zpAddr); // STA param slot
    }

    if (fn.isInline) {
      const outer = scope;
      scope = e.name;
      inlineDepth++;
      genStmts(fn.decl.body);
      inlineDepth--;
      scope = outer;
    } else {
      emit(0x20); // JSR
      addFixup({ kind: 'abs16', label: `fn_${e.name}` }, 2);
    }
  }

  /** Loads the low (or high) byte of a variable or constant argument of lo() / hi(). */
  function genByteOf(arg: Expr, high: boolean, line: number): void {
    const c = evalConst(arg);
    if (c !== null) {
      emit(0xA9, (high ? c >> 8 : c) & 0xFF);
      return;
    }
    if (arg.tag === 'ident') {
      const v = lookup(arg.name);
      if (v && v.zpAddr !== null) {
        emit(0xA5, v.zpAddr + (high ? 1 : 0));
        return;
      }
      if (v && v.absAddr !== null) {
        const a = v.absAddr + (high ? 1 : 0);
        emit(0xAD, a & 0xFF, (a >> 8) & 0xFF);
        return;
      }
    }
    throw new CodeGenError(`${high ? 'hi' : 'lo'}() needs a variable or a constant`, line, 0);
  }

  function genExpr(e: Expr): void {
    switch (e.tag) {
      case 'intLit':
        emit(0xA9, e.value & 0xFF);
        break;
      case 'boolLit':
        emit(0xA9, e.value ? 0x01 : 0x00);
        break;
      case 'ident': {
        const v = lookup(e.name);
        if (v && v.isConst && v.constValue !== null) {
          emit(0xA9, v.constValue & 0xFF);
        } else if (v && v.zpAddr !== null) {
          emit(0xA5, v.zpAddr);
        } else if (v && v.absAddr !== null) {
          emit(0xAD, v.absAddr & 0xFF, (v.absAddr >> 8) & 0xFF);
        } else {
          throw new CodeGenError(`cannot read '${e.name}'`, e.line, 0);
        }
        break;
      }
      case 'field': {
        if (e.obj.tag !== 'ident') {
          throw new CodeGenError('only hardware fields can be read (e.g. VIC2.borderColor)', e.line, 0);
        }
        const addr = hwAddr(e.obj.name, e.field, e.line);
        emit(0xAD, addr & 0xFF, (addr >> 8) & 0xFF);
        break;
      }
      case 'unary':
        if (e.op !== '!') {
          throw new CodeGenError(`unary operator '${e.op}' is not supported yet`, e.line, 0);
        }
        genExpr(e.rhs);
        emit(0x49, 0x01); // EOR #1 (bool flip)
        break;
      case 'binary': {
        const folded = evalConst(e);
        if (folded !== null) emit(0xA9, folded & 0xFF);
        else genBinary(e);
        break;
      }
      case 'cast':
        genExpr(e.expr);
        break;
      case 'call':
        genCall(e);
        break;
      case 'lo':
        genByteOf(e.expr, false, e.line);
        break;
      case 'hi':
        genByteOf(e.expr, true, e.line);
        break;
      case 'index':
        throw new CodeGenError('array indexing is not supported yet', e.line, 0);
    }
  }

  const RHS_HINT = 'right-hand operand must be a literal, a variable or a hardware register ' +
    '(assign the sub-expression to a variable first)';

  /** Emits `<op> operand` for the right side of a binary operation, choosing imm/zp/abs mode. */
  function genOperand(rhs: Expr, immOp: number, zpOp: number, absOp: number): void {
    const c = evalConst(rhs);
    if (c !== null) {
      emit(immOp, c & 0xFF);
      return;
    }
    if (rhs.tag === 'ident') {
      const v = lookup(rhs.name);
      if (v && v.zpAddr !== null) {
        emit(zpOp, v.zpAddr);
        return;
      }
      if (v && v.absAddr !== null) {
        emit(absOp, v.absAddr & 0xFF, (v.absAddr >> 8) & 0xFF);
        return;
      }
    }
    if (rhs.tag === 'field' && rhs.obj.tag === 'ident') {
      const addr = hwAddr(rhs.obj.name, rhs.field, rhs.line);
      emit(absOp, addr & 0xFF, (addr >> 8) & 0xFF);
      return;
    }
    throw new CodeGenError(RHS_HINT, rhs.line, 0);
  }

  function genBinary(e: Extract<Expr, { tag: 'binary' }>): void {
    if (e.op === '&&' || e.op === '||') {
      throw new CodeGenError(`'${e.op}' is not supported yet`, e.line, 0);
    }
    if (COMPARE_OPS.has(e.op)) {
      throw new CodeGenError(
        `comparison '${e.op}' can only be used as a condition (if / while / for)`,
        e.line,
        0,
      );
    }
    if (!['+', '-', '&', '|', '^'].includes(e.op)) {
      throw new CodeGenError(`operator '${e.op}' is not supported yet`, e.line, 0);
    }
    if (isU16(e.lhs) || isU16(e.rhs)) {
      throw new CodeGenError('16-bit arithmetic is not supported yet', e.line, 0);
    }
    switch (e.op) {
      case '+':
        emit(0x18); // CLC
        genExpr(e.lhs);
        genOperand(e.rhs, 0x69, 0x65, 0x6D); // ADC #imm, ADC zp, ADC abs
        break;
      case '-':
        emit(0x38); // SEC
        genExpr(e.lhs);
        genOperand(e.rhs, 0xE9, 0xE5, 0xED); // SBC #imm, SBC zp, SBC abs
        break;
      case '&':
        genExpr(e.lhs);
        genOperand(e.rhs, 0x29, 0x25, 0x2D); // AND #imm, AND zp, AND abs
        break;
      case '|':
        genExpr(e.lhs);
        genOperand(e.rhs, 0x09, 0x05, 0x0D); // ORA #imm, ORA zp, ORA abs
        break;
      case '^':
        genExpr(e.lhs);
        genOperand(e.rhs, 0x49, 0x45, 0x4D); // EOR #imm, EOR zp, EOR abs
        break;
    }
  }

  // Emit the CMP operand, choosing imm/zp/abs mode based on rhs type
  function genCmpRhs(rhs: Expr): void {
    genOperand(rhs, 0xC9, 0xC5, 0xCD); // CMP #imm, CMP zp, CMP abs
  }

  // Emit branch instruction(s) for a comparison operator.
  // invertForFalse=true: branch to label when condition is FALSE (skip body).
  // invertForFalse=false: branch to label when condition is TRUE.
  function emitCondJump(op: string, label: string, invertForFalse: boolean): void {
    if (invertForFalse) {
      switch (op) {
        case '==': emit(0xD0); addFixup({ kind: 'branch8', label }, 1); break; // BNE
        case '!=': emit(0xF0); addFixup({ kind: 'branch8', label }, 1); break; // BEQ
        case '<':  emit(0xB0); addFixup({ kind: 'branch8', label }, 1); break; // BCS (skip when >=)
        case '>=': emit(0x90); addFixup({ kind: 'branch8', label }, 1); break; // BCC (skip when <)
        case '>': {
          // FALSE when x <= k: C=0 (x<k) OR Z=1 (x==k) → BCC + BEQ both skip
          emit(0x90); addFixup({ kind: 'branch8', label }, 1); // BCC
          emit(0xF0); addFixup({ kind: 'branch8', label }, 1); // BEQ
          break;
        }
        case '<=': {
          // FALSE when x > k: C=1 AND Z=0 → BCC skips to okLabel; BNE skips to label
          const okLabel = freshLabel('cmp_ok');
          emit(0x90); addFixup({ kind: 'branch8', label: okLabel }, 1); // BCC → x<k → keep going
          emit(0xD0); addFixup({ kind: 'branch8', label }, 1);          // BNE → x>k → skip
          emitLabel(okLabel);
          break;
        }
        default: emit(0xF0); addFixup({ kind: 'branch8', label }, 1); break;
      }
    } else {
      switch (op) {
        case '==': emit(0xF0); addFixup({ kind: 'branch8', label }, 1); break; // BEQ
        case '!=': emit(0xD0); addFixup({ kind: 'branch8', label }, 1); break; // BNE
        case '<':  emit(0x90); addFixup({ kind: 'branch8', label }, 1); break; // BCC
        case '>=': emit(0xB0); addFixup({ kind: 'branch8', label }, 1); break; // BCS
        case '>': {
          // TRUE when C=1 AND Z=0: BEQ skips to notGt; BCS jumps when >
          const notGtLabel = freshLabel('cmp_skip');
          emit(0xF0); addFixup({ kind: 'branch8', label: notGtLabel }, 1); // BEQ → equal → not >
          emit(0xB0); addFixup({ kind: 'branch8', label }, 1);              // BCS → C=1,Z=0 → is >
          emitLabel(notGtLabel);
          break;
        }
        case '<=': {
          // TRUE when C=0 OR Z=1: BCC + BEQ both jump
          emit(0x90); addFixup({ kind: 'branch8', label }, 1); // BCC → <
          emit(0xF0); addFixup({ kind: 'branch8', label }, 1); // BEQ → =
          break;
        }
        default: emit(0xD0); addFixup({ kind: 'branch8', label }, 1); break;
      }
    }
  }

  function genCondBranch(cond: Expr, label: string, invertForFalse: boolean): void {
    if (cond.tag === 'binary' && (cond.op === '&&' || cond.op === '||')) {
      throw new CodeGenError(`'${cond.op}' is not supported yet`, cond.line, 0);
    }
    if (cond.tag === 'binary' && COMPARE_OPS.has(cond.op)) {
      if (isU16(cond.lhs) || isU16(cond.rhs)) {
        throw new CodeGenError('16-bit comparison is not supported yet', cond.line, 0);
      }
      genExpr(cond.lhs);
      genCmpRhs(cond.rhs);
      emitCondJump(cond.op, label, invertForFalse);
    } else {
      // Any other value is true when it is non-zero. CMP #0 makes the flags reflect A even
      // after a function call returned it.
      genExpr(cond);
      emit(0xC9, 0x00);
      emit(invertForFalse ? 0xF0 : 0xD0);
      addFixup({ kind: 'branch8', label }, 1);
    }
  }

  const COMPOUND_OPS: Record<string, string> = {
    '+=': '+', '-=': '-', '&=': '&', '|=': '|', '^=': '^',
  };

  /** Stores `rhs` into the 16-bit variable `target` (low byte first), widening a u8 value. */
  function genStore16(target: ResolvedVar, name: string, rhs: Expr, line: number): void {
    const base = target.zpAddr ?? target.absAddr;
    if (base === null) throw new CodeGenError(`cannot assign to '${name}'`, line, 0);
    const store = (offset: number): void => {
      if (target.zpAddr !== null) emit(0x85, target.zpAddr + offset);
      else emit(0x8D, (base + offset) & 0xFF, ((base + offset) >> 8) & 0xFF);
    };
    let value = rhs;
    while (value.tag === 'cast' && value.toType.tag === 'u16') value = value.expr;

    const c = evalConst(value);
    if (c !== null) {
      emit(0xA9, c & 0xFF);
      store(0);
      emit(0xA9, (c >> 8) & 0xFF);
      store(1);
      return;
    }
    if (value.tag === 'ident') {
      const src = lookup(value.name);
      if (src && src.type.tag === 'u16' && !src.isConst) {
        for (const offset of [0, 1]) {
          if (src.zpAddr !== null) emit(0xA5, src.zpAddr + offset);
          else if (src.absAddr !== null) {
            const a = src.absAddr + offset;
            emit(0xAD, a & 0xFF, (a >> 8) & 0xFF);
          }
          store(offset);
        }
        return;
      }
    }
    if (isU16(value)) {
      throw new CodeGenError('16-bit arithmetic is not supported yet', line, 0);
    }
    genExpr(value); // an 8-bit value: zero-extend
    store(0);
    emit(0xA9, 0x00);
    store(1);
  }

  /** `lhs = rhs`, handling 16-bit targets. */
  function genAssign(lhs: Expr, rhs: Expr, line: number): void {
    if (lhs.tag === 'ident') {
      const v = lookup(lhs.name);
      if (v && v.type.tag === 'u16' && !v.isConst) {
        genStore16(v, lhs.name, rhs, line);
        return;
      }
    }
    genExpr(rhs);
    genStore(lhs);
  }

  function genStmt(s: Stmt): void {
    switch (s.tag) {
      case 'varDecl': {
        const v = lookup(s.name);
        if (!v) throw new CodeGenError(`internal error: '${s.name}' was not declared`, s.line, 0);
        if (v.isConst || !s.init) break;
        genAssign({ tag: 'ident', name: s.name, line: s.line }, s.init, s.line);
        break;
      }
      case 'assign': {
        if (s.op === '=') {
          genAssign(s.lhs, s.rhs, s.line);
          break;
        }
        const binop = COMPOUND_OPS[s.op];
        if (binop === undefined) {
          throw new CodeGenError(`'${s.op}' is not supported yet`, s.line, 0);
        }
        genAssign(
          s.lhs,
          { tag: 'binary', op: binop, lhs: s.lhs, rhs: s.rhs, line: s.line },
          s.line,
        );
        break;
      }
      case 'incDec':
        genIncDec(s.lhs, s.op);
        break;
      case 'exprStmt':
        genExpr(s.expr);
        break;
      case 'return':
        if (inlineDepth > 0) {
          throw new CodeGenError('return is not allowed in an @inline function', s.line, 0);
        }
        if (scope === PROGRAM_SCOPE) {
          throw new CodeGenError('return is only valid inside a function', s.line, 0);
        }
        if (s.value) genExpr(s.value);
        emit(0x60); // RTS
        break;
      case 'if': {
        const endIfLabel = freshLabel('if_end');
        // Main if branch
        {
          const skipLabel = freshLabel('if_skip');
          genCondBranch(s.cond, skipLabel, true);
          genStmts(s.then);
          emit(0x4C); addFixup({ kind: 'abs16', label: endIfLabel }, 2); // JMP to end
          emitLabel(skipLabel);
        }
        // elif branches
        for (const elif of s.elif) {
          const skipLabel = freshLabel('if_skip');
          genCondBranch(elif.cond, skipLabel, true);
          genStmts(elif.body);
          emit(0x4C); addFixup({ kind: 'abs16', label: endIfLabel }, 2);
          emitLabel(skipLabel);
        }
        // else branch
        if (s.els) genStmts(s.els);
        emitLabel(endIfLabel);
        break;
      }
      case 'while': {
        const topLabel = freshLabel('while_top');
        const endLabel = freshLabel('while_end');
        emitLabel(topLabel);
        genCondBranch(s.cond, endLabel, true);
        loopStack.push({ breakLabel: endLabel, continueLabel: topLabel });
        genStmts(s.body);
        loopStack.pop();
        emit(0x4C);
        addFixup({ kind: 'abs16', label: topLabel }, 2);
        emitLabel(endLabel);
        break;
      }
      case 'loop': {
        const topLabel = freshLabel('loop_top');
        const endLabel = freshLabel('loop_end');
        emitLabel(topLabel);
        loopStack.push({ breakLabel: endLabel, continueLabel: topLabel });
        genStmts(s.body);
        loopStack.pop();
        emit(0x4C);
        addFixup({ kind: 'abs16', label: topLabel }, 2);
        emitLabel(endLabel);
        break;
      }
      case 'for': {
        const topLabel = freshLabel('for_top');
        const endLabel = freshLabel('for_end');
        const postLabel = freshLabel('for_post');
        genStmt(s.init);
        emitLabel(topLabel);
        genCondBranch(s.cond, endLabel, true);
        loopStack.push({ breakLabel: endLabel, continueLabel: postLabel });
        genStmts(s.body);
        loopStack.pop();
        emitLabel(postLabel);
        genStmt(s.post);
        emit(0x4C);
        addFixup({ kind: 'abs16', label: topLabel }, 2);
        emitLabel(endLabel);
        break;
      }
      case 'break': {
        const ctx = loopStack[loopStack.length - 1];
        if (ctx) { emit(0x4C); addFixup({ kind: 'abs16', label: ctx.breakLabel }, 2); }
        break;
      }
      case 'continue': {
        const ctx = loopStack[loopStack.length - 1];
        if (ctx) { emit(0x4C); addFixup({ kind: 'abs16', label: ctx.continueLabel }, 2); }
        break;
      }
      case 'asm':
        throw new CodeGenError('asm {} blocks are not supported yet', s.line, 0);
    }
  }

  function genStmts(stmts: readonly Stmt[]): void {
    for (const s of stmts) genStmt(s);
  }

  // ─── Global initialisation: runs once before program_start ─────────────
  // Variables in zero page start at their initialiser, or 0; a global bound to a hardware
  // address (@addr) is only written when it has an initialiser.
  for (const v of cp.vars.values()) {
    if (!v.isGlobal || v.isConst) continue;
    if (v.zpAddr !== null) {
      const size = sizeOf(v.type, cp.structs);
      const value = v.initValue ?? 0;
      for (let i = 0; i < size; i++) {
        emit(0xA9, i === 0 ? value & 0xFF : i === 1 ? (value >> 8) & 0xFF : 0x00);
        emit(0x85, v.zpAddr + i);
      }
    } else if (v.absAddr !== null && v.initValue !== null) {
      const size = v.type.tag === 'u16' ? 2 : 1;
      for (let i = 0; i < size; i++) {
        const a = v.absAddr + i;
        emit(0xA9, (v.initValue >> (8 * i)) & 0xFF);
        emit(0x8D, a & 0xFF, (a >> 8) & 0xFF);
      }
    }
  }

  // ─── Program block ────────────────────────────────────────────────────
  emitLabel('__program_start');
  emit(0xD8); // CLD — 6502 NMOS decimal mode must be off

  scope = PROGRAM_SCOPE;
  for (const d of cp.program.decls) {
    if (d.tag === 'program') { genStmts(d.body); break; }
  }

  emit(0x4C);
  addFixup({ kind: 'abs16', label: '__program_start' }, 2);

  // ─── Non-inline functions ─────────────────────────────────────────────
  for (const [name, fn] of cp.fns) {
    if (fn.isInline) continue;
    emitLabel(`fn_${name}`);
    scope = name;
    genStmts(fn.decl.body);
    emit(0x60); // RTS
  }
  scope = PROGRAM_SCOPE;

  // ─── Data sections (placed at absolute addresses via padding) ──────────
  const hex4 = (n: number): string => `$${n.toString(16).toUpperCase().padStart(4, '0')}`;
  const dataBlocks: Array<{ decl: Extract<(typeof cp.program.decls)[number], { tag: 'data' }>; addr: number }> = [];
  for (const d of cp.program.decls) {
    if (d.tag !== 'data') continue;
    if (d.annotation.kind !== 'addr') {
      throw new CodeGenError('a data block needs an @addr(...) annotation', d.line, 0);
    }
    dataBlocks.push({ decl: d, addr: d.annotation.address });
  }
  dataBlocks.sort((a, b) => a.addr - b.addr);

  for (const { decl, addr } of dataBlocks) {
    const currentAddr = cp.loadAddr + bytes.length;
    if (addr < currentAddr) {
      throw new CodeGenError(
        `code reaches ${hex4(currentAddr)}, which overlaps the data block at ${hex4(addr)}; ` +
          'move the data block higher',
        decl.line,
        0,
      );
    }
    while (cp.loadAddr + bytes.length < addr) emit(0x00); // pad
    for (const field of decl.fields) {
      for (const init of field.init) {
        const v = evalConst(init);
        if (v === null) {
          throw new CodeGenError(`data '${field.name}' values must be compile-time constants`, decl.line, 0);
        }
        emit(v & 0xFF);
      }
    }
  }

  return { bytes, labels, fixups, loadAddr: cp.loadAddr };
}
