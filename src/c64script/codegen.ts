import { CodeGenError } from './errors';
import type { CheckedProgram } from './checker';
import type { Expr, Stmt, VarDecl } from './ast';

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

export function generate(cp: CheckedProgram): CodeBuffer {
  const bytes: number[] = [];
  const labels = new Map<string, number>();
  const fixups: Fixup[] = [];
  let labelCounter = 0;

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

  function hwAddr(hwName: string, fieldName: string): number {
    const hw = cp.hardware.get(hwName);
    if (!hw) throw new CodeGenError(`unknown hardware '${hwName}'`, 0, 0);
    const f = hw.fields.find(field => field.name === fieldName);
    if (!f) throw new CodeGenError(`unknown field '${fieldName}' on '${hwName}'`, 0, 0);
    return hw.base + f.offset;
  }

  function genStore(lhs: Expr): void {
    if (lhs.tag === 'ident') {
      const v = cp.vars.get(lhs.name);
      if (v && v.zpAddr !== null) {
        emit(0x85, v.zpAddr);
      } else if (v && v.absAddr !== null) {
        emit(0x8D, v.absAddr & 0xFF, (v.absAddr >> 8) & 0xFF);
      }
    } else if (lhs.tag === 'field' && lhs.obj.tag === 'ident') {
      const addr = hwAddr(lhs.obj.name, lhs.field);
      emit(0x8D, addr & 0xFF, (addr >> 8) & 0xFF);
    }
  }

  function genIncDec(lhs: Expr, op: '++' | '--'): void {
    if (lhs.tag === 'ident') {
      const v = cp.vars.get(lhs.name);
      if (v && v.zpAddr !== null) {
        emit(op === '++' ? 0xE6 : 0xC6, v.zpAddr);
      } else if (v && v.absAddr !== null) {
        emit(op === '++' ? 0xEE : 0xCE, v.absAddr & 0xFF, (v.absAddr >> 8) & 0xFF);
      }
    }
  }

  function genCall(e: Extract<Expr, { tag: 'call' }>): void {
    const fn = cp.fns.get(e.name);
    if (!fn) return;

    const arg0 = e.args[0];
    if (arg0 !== undefined) genExpr(arg0);
    if (e.args.length >= 2) emit(0xAA); // TAX

    if (fn.isInline) {
      genStmts(fn.decl.body);
    } else {
      emit(0x20); // JSR
      addFixup({ kind: 'abs16', label: `fn_${e.name}` }, 2);
    }
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
        const v = cp.vars.get(e.name);
        if (v && v.zpAddr !== null) {
          emit(0xA5, v.zpAddr);
        } else if (v && v.absAddr !== null) {
          emit(0xAD, v.absAddr & 0xFF, (v.absAddr >> 8) & 0xFF);
        } else if (v && v.constValue !== null) {
          emit(0xA9, v.constValue & 0xFF);
        }
        break;
      }
      case 'field':
        if (e.obj.tag === 'ident') {
          const addr = hwAddr(e.obj.name, e.field);
          emit(0xAD, addr & 0xFF, (addr >> 8) & 0xFF);
        }
        break;
      case 'unary':
        genExpr(e.rhs);
        if (e.op === '!') emit(0x49, 0x01); // EOR #1 (bool flip)
        break;
      case 'binary':
        genBinary(e);
        break;
      case 'cast':
        genExpr(e.expr);
        break;
      case 'call':
        genCall(e);
        break;
      case 'lo':
        if (e.expr.tag === 'ident') {
          const v = cp.vars.get(e.expr.name);
          if (v && v.zpAddr !== null) emit(0xA5, v.zpAddr);
        }
        break;
      case 'hi':
        if (e.expr.tag === 'ident') {
          const v = cp.vars.get(e.expr.name);
          if (v && v.zpAddr !== null) emit(0xA5, v.zpAddr + 1);
        }
        break;
      case 'index':
        break;
    }
  }

  function genBinary(e: Extract<Expr, { tag: 'binary' }>): void {
    switch (e.op) {
      case '+':
        emit(0x18); // CLC
        genExpr(e.lhs);
        if (e.rhs.tag === 'intLit') emit(0x69, e.rhs.value & 0xFF); // ADC #imm
        break;
      case '-':
        emit(0x38); // SEC
        genExpr(e.lhs);
        if (e.rhs.tag === 'intLit') emit(0xE9, e.rhs.value & 0xFF); // SBC #imm
        break;
      case '&':
        genExpr(e.lhs);
        if (e.rhs.tag === 'intLit') emit(0x29, e.rhs.value & 0xFF); // AND #
        break;
      case '|':
        genExpr(e.lhs);
        if (e.rhs.tag === 'intLit') emit(0x09, e.rhs.value & 0xFF); // ORA #
        break;
      case '^':
        genExpr(e.lhs);
        if (e.rhs.tag === 'intLit') emit(0x49, e.rhs.value & 0xFF); // EOR #
        break;
      default:
        genExpr(e.lhs);
        break;
    }
  }

  function genCondBranch(cond: Expr, label: string, invertForFalse: boolean): void {
    if (cond.tag === 'binary') {
      genExpr(cond.lhs);
      if (cond.rhs.tag === 'intLit') emit(0xC9, cond.rhs.value & 0xFF); // CMP #imm
      let branchOp: number;
      if (invertForFalse) {
        // Branch to label when condition is FALSE
        branchOp = cond.op === '==' ? 0xD0 : // BNE — skip when not equal
                   cond.op === '!=' ? 0xF0 : // BEQ — skip when equal
                   cond.op === '<'  ? 0xB0 : // BCS — skip when >=
                   cond.op === '>=' ? 0x90 : // BCC — skip when <
                   0xF0;
      } else {
        branchOp = cond.op === '==' ? 0xF0 : 0xD0; // BEQ : BNE
      }
      emit(branchOp);
      addFixup({ kind: 'branch8', label }, 1);
    } else {
      genExpr(cond);
      emit(invertForFalse ? 0xF0 : 0xD0);
      addFixup({ kind: 'branch8', label }, 1);
    }
  }

  function genStmt(s: Stmt): void {
    switch (s.tag) {
      case 'varDecl':
        if (s.init) {
          genExpr(s.init);
          if (s.annotation.kind === 'zp') {
            const v = cp.vars.get(s.name);
            if (v && v.zpAddr !== null) emit(0x85, v.zpAddr);
          }
        }
        break;
      case 'assign':
        if (s.op === '=') { genExpr(s.rhs); genStore(s.lhs); }
        break;
      case 'incDec':
        genIncDec(s.lhs, s.op);
        break;
      case 'exprStmt':
        genExpr(s.expr);
        break;
      case 'return':
        if (s.value) genExpr(s.value);
        emit(0x60); // RTS
        break;
      case 'if': {
        const endLabel = freshLabel('if_end');
        genCondBranch(s.cond, endLabel, true);
        genStmts(s.then);
        emitLabel(endLabel);
        break;
      }
      case 'while': {
        const topLabel = freshLabel('while_top');
        const endLabel = freshLabel('while_end');
        emitLabel(topLabel);
        genCondBranch(s.cond, endLabel, true);
        genStmts(s.body);
        emit(0x4C);
        addFixup({ kind: 'abs16', label: topLabel }, 2);
        emitLabel(endLabel);
        break;
      }
      case 'loop': {
        const topLabel = freshLabel('loop_top');
        emitLabel(topLabel);
        genStmts(s.body);
        emit(0x4C);
        addFixup({ kind: 'abs16', label: topLabel }, 2);
        break;
      }
      case 'for': {
        const topLabel = freshLabel('for_top');
        const endLabel = freshLabel('for_end');
        genStmt(s.init);
        emitLabel(topLabel);
        genCondBranch(s.cond, endLabel, true);
        genStmts(s.body);
        genStmt(s.post);
        emit(0x4C);
        addFixup({ kind: 'abs16', label: topLabel }, 2);
        emitLabel(endLabel);
        break;
      }
      case 'break':
      case 'continue':
      case 'asm':
        break;
    }
  }

  function genStmts(stmts: readonly Stmt[]): void {
    for (const s of stmts) genStmt(s);
  }

  // ─── ZP init: runs once before program_start ──────────────────────────
  for (const [name, v] of cp.vars) {
    if (v.zpAddr === null) continue;
    let decl: VarDecl | undefined;
    for (const d of cp.program.decls) {
      if (d.tag === 'varDecl' && d.name === name) { decl = d; break; }
    }
    if (!decl?.init || decl.init.tag !== 'intLit') continue;
    const val = decl.init.value;
    emit(0xA9, val & 0xFF);
    emit(0x85, v.zpAddr);
    if (v.type.tag === 'u16' && val > 0xFF) {
      emit(0xA9, (val >> 8) & 0xFF);
      emit(0x85, v.zpAddr + 1);
    } else if (v.type.tag === 'u16') {
      emit(0xA9, 0x00);
      emit(0x85, v.zpAddr + 1);
    }
  }

  // ─── Program block ────────────────────────────────────────────────────
  emitLabel('__program_start');
  emit(0xD8); // CLD — 6502 NMOS decimal mode must be off

  for (const d of cp.program.decls) {
    if (d.tag === 'program') { genStmts(d.body); break; }
  }

  emit(0x4C);
  addFixup({ kind: 'abs16', label: '__program_start' }, 2);

  // ─── Non-inline functions ─────────────────────────────────────────────
  for (const [name, fn] of cp.fns) {
    if (fn.isInline) continue;
    emitLabel(`fn_${name}`);
    genStmts(fn.decl.body);
    emit(0x60); // RTS
  }

  return { bytes, labels, fixups, loadAddr: cp.loadAddr };
}
