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

type LoopContext = { breakLabel: string; continueLabel: string };

export function generate(cp: CheckedProgram): CodeBuffer {
  const bytes: number[] = [];
  const labels = new Map<string, number>();
  const fixups: Fixup[] = [];
  let labelCounter = 0;
  const loopStack: LoopContext[] = [];

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
    } else if (lhs.tag === 'field' && lhs.obj.tag === 'ident') {
      const addr = hwAddr(lhs.obj.name, lhs.field);
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
    }
  }

  function genCall(e: Extract<Expr, { tag: 'call' }>): void {
    const fn = cp.fns.get(e.name);
    if (!fn) throw new CodeGenError(`undefined function '${e.name}'`, 0, 0);

    const arg0 = e.args[0];
    if (arg0 !== undefined) genExpr(arg0);

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

  // Emit the RHS of an arithmetic/logic binary op, choosing imm/zp/abs mode
  function genBinaryRhs(rhs: Expr, immOp: number, zpOp: number, absOp: number): void {
    if (rhs.tag === 'intLit') {
      emit(immOp, rhs.value & 0xFF);
    } else if (rhs.tag === 'ident') {
      const v = cp.vars.get(rhs.name);
      if (v && v.zpAddr !== null) {
        emit(zpOp, v.zpAddr);
      } else if (v && v.absAddr !== null) {
        emit(absOp, v.absAddr & 0xFF, (v.absAddr >> 8) & 0xFF);
      } else if (v && v.constValue !== null) {
        emit(immOp, v.constValue & 0xFF);
      }
    }
  }

  function genBinary(e: Extract<Expr, { tag: 'binary' }>): void {
    switch (e.op) {
      case '+':
        emit(0x18); // CLC
        genExpr(e.lhs);
        genBinaryRhs(e.rhs, 0x69, 0x65, 0x6D); // ADC #imm, ADC zp, ADC abs
        break;
      case '-':
        emit(0x38); // SEC
        genExpr(e.lhs);
        genBinaryRhs(e.rhs, 0xE9, 0xE5, 0xED); // SBC #imm, SBC zp, SBC abs
        break;
      case '&':
        genExpr(e.lhs);
        genBinaryRhs(e.rhs, 0x29, 0x25, 0x2D); // AND #imm, AND zp, AND abs
        break;
      case '|':
        genExpr(e.lhs);
        genBinaryRhs(e.rhs, 0x09, 0x05, 0x0D); // ORA #imm, ORA zp, ORA abs
        break;
      case '^':
        genExpr(e.lhs);
        genBinaryRhs(e.rhs, 0x49, 0x45, 0x4D); // EOR #imm, EOR zp, EOR abs
        break;
      default:
        genExpr(e.lhs);
        break;
    }
  }

  // Emit the CMP operand, choosing imm/zp/abs mode based on rhs type
  function genCmpRhs(rhs: Expr): void {
    if (rhs.tag === 'intLit') {
      emit(0xC9, rhs.value & 0xFF); // CMP #imm
    } else if (rhs.tag === 'ident') {
      const v = cp.vars.get(rhs.name);
      if (v && v.zpAddr !== null) {
        emit(0xC5, v.zpAddr); // CMP zp
      } else if (v && v.absAddr !== null) {
        emit(0xCD, v.absAddr & 0xFF, (v.absAddr >> 8) & 0xFF); // CMP abs
      } else if (v && v.constValue !== null) {
        emit(0xC9, v.constValue & 0xFF); // CMP #imm
      }
    }
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
    if (cond.tag === 'binary') {
      genExpr(cond.lhs);
      genCmpRhs(cond.rhs);
      emitCondJump(cond.op, label, invertForFalse);
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
          } else if (s.annotation.kind === 'addr') {
            const v = cp.vars.get(s.name);
            if (v && v.absAddr !== null) emit(0x8D, v.absAddr & 0xFF, (v.absAddr >> 8) & 0xFF);
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
