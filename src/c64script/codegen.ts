import { CodeGenError } from './errors';
import { PROGRAM_SCOPE, foldConst, scopedName } from './checker';
import type { CheckedProgram, ResolvedVar } from './checker';
import { OPS } from '../core';
import { chooseMode, opcodeFor } from './asm';
import type { AsmShape } from './asm';
import { isCompareOp, sizeOf } from './ast';
import type { AsmExpr, AsmItem, AssignOp, BinaryOp, CompareOp, Expr, Stmt } from './ast';

export type FixupKind =
  | { tag: 'branch8'; label: string }
  | { tag: 'abs16'; label: string }
  | { tag: 'zpByte'; varName: string }
  | { tag: 'absHiByte'; label: string }
  | { tag: 'absLoByte'; label: string };

export interface Fixup {
  offset: number;
  kind: FixupKind;
  line?: number;
}

export interface CodeBuffer {
  bytes: number[];
  labels: Map<string, number>;
  fixups: Fixup[];
  loadAddr: number;
}

type LoopContext = { breakLabel: string; continueLabel: string };

/** Zero page the compiler keeps for itself ($F8–$FF are outside the allocator's range). */
const ACC = 0xf8; // 16-bit accumulator: low at $F8, high at $F9; also the pointer for (zp),Y
const TMP2 = 0xfa; // second 16-bit temporary ($FA/$FB)

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

  /** The operators the 8-bit expression generator implements. */
  const BYTE_OPS: ReadonlySet<BinaryOp> = new Set<BinaryOp>(['+', '-', '&', '|', '^']);

  /** True when the expression has a 16-bit value (the code generator only does 8-bit math). */
  function isU16(e: Expr): boolean {
    switch (e.tag) {
      case 'intLit':
        return e.value > 0xff;
      case 'ident': {
        const v = lookup(e.name);
        if (v === undefined) return false;
        if (v.type.tag === 'array') return true; // its address
        return v.isConst ? (v.constValue ?? 0) > 0xff : v.type.tag === 'u16';
      }
      case 'cast':
        return e.toType.tag === 'u16';
      case 'call':
        // screen() / color() are addresses: 16-bit values.
        if (e.name === 'screen' || e.name === 'color') return true;
        return cp.fns.get(e.name)?.decl.ret.tag === 'u16';
      case 'unary':
        return isU16(e.rhs);
      case 'binary':
        return isCompareOp(e.op) ? false : isU16(e.lhs) || isU16(e.rhs);
      default:
        return false;
    }
  }

  function emit(...bs: number[]): void {
    for (const b of bs) bytes.push(b & 0xff);
  }

  function emitLabel(name: string): void {
    labels.set(name, bytes.length);
  }

  function freshLabel(prefix: string): string {
    return `__${prefix}_${labelCounter++}`;
  }

  function addFixup(kind: FixupKind, n: number, line?: number): void {
    fixups.push(
      line === undefined ? { offset: bytes.length, kind } : { offset: bytes.length, kind, line },
    );
    for (let i = 0; i < n; i++) emit(0x00);
  }

  function hwAddr(hwName: string, fieldName: string, line = 0): number {
    const hw = cp.hardware.get(hwName);
    if (!hw) throw new CodeGenError(`unknown hardware '${hwName}'`, line, 0);
    const f = hw.fields.find((field) => field.name === fieldName);
    if (!f) throw new CodeGenError(`unknown field '${fieldName}' on '${hwName}'`, line, 0);
    return hw.base + f.offset;
  }

  function genStore(lhs: Expr): void {
    if (lhs.tag === 'ident') {
      const v = lookup(lhs.name);
      if (v && v.zpAddr !== null) {
        emit(0x85, v.zpAddr);
      } else if (v && v.absAddr !== null) {
        emit(0x8d, v.absAddr & 0xff, (v.absAddr >> 8) & 0xff);
      } else {
        throw new CodeGenError(`cannot assign to '${lhs.name}'`, lhs.line, 0);
      }
    } else if (lhs.tag === 'field' && lhs.obj.tag === 'ident') {
      const addr = hwAddr(lhs.obj.name, lhs.field, lhs.line);
      emit(0x8d, addr & 0xff, (addr >> 8) & 0xff);
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
          emit(0xe6, z, 0xd0, 0x02, 0xe6, z + 1); // INC lo; BNE +2; INC hi
        } else {
          emit(0xa5, z, 0xd0, 0x02, 0xc6, z + 1, 0xc6, z); // LDA lo; BNE +2; DEC hi; DEC lo
        }
      } else if (v && v.zpAddr !== null) {
        emit(op === '++' ? 0xe6 : 0xc6, v.zpAddr);
      } else if (v && v.absAddr !== null) {
        emit(op === '++' ? 0xee : 0xce, v.absAddr & 0xff, (v.absAddr >> 8) & 0xff);
      } else {
        throw new CodeGenError(`cannot modify '${lhs.name}'`, lhs.line, 0);
      }
    } else if (lhs.tag === 'field' && lhs.obj.tag === 'ident') {
      const addr = hwAddr(lhs.obj.name, lhs.field, lhs.line);
      // Never INC/DEC on hardware registers — use LDA/ADC(SBC)/STA instead
      emit(0xad, addr & 0xff, (addr >> 8) & 0xff); // LDA abs
      if (op === '++') {
        emit(0x18); // CLC
        emit(0x69, 0x01); // ADC #1
      } else {
        emit(0x38); // SEC
        emit(0xe9, 0x01); // SBC #1
      }
      emit(0x8d, addr & 0xff, (addr >> 8) & 0xff); // STA abs
    } else if (lhs.tag === 'index') {
      const one: Expr = { tag: 'intLit', value: 1, line: lhs.line };
      genAssign(
        lhs,
        { tag: 'binary', op: op === '++' ? '+' : '-', lhs, rhs: one, line: lhs.line },
        lhs.line,
      );
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
    emit(0xa9, 0x20); // LDA #' '
    emit(0xa2, 0x00); // LDX #0
    const scrLoop = bytes.length;
    emit(0x9d, 0x00, 0x04); // STA $0400,X
    emit(0x9d, 0x00, 0x05); // STA $0500,X
    emit(0x9d, 0x00, 0x06); // STA $0600,X
    emit(0xe8); // INX
    emit(0xd0, (scrLoop - bytes.length - 2) & 0xff); // BNE scrLoop
    // Last partial page: $0700-$07E7 (232 bytes), avoid sprite ptrs $07F8-$07FF
    // BNE (not BPL): X starts above 127, so N would be set after the first DEX.
    // STA $06FF,X with X = 232..1 covers $07E7 down to $0700.
    emit(0xa2, 232); // LDX #232
    const scrLoop2 = bytes.length;
    emit(0x9d, 0xff, 0x06); // STA $06FF,X
    emit(0xca); // DEX
    emit(0xd0, (scrLoop2 - bytes.length - 2) & 0xff); // BNE scrLoop2
    // Fill color RAM $D800-$DBFF with black (0)
    emit(0xa9, 0x00); // LDA #0
    emit(0xa2, 0x00); // LDX #0
    const colLoop = bytes.length;
    emit(0x9d, 0x00, 0xd8); // STA $D800,X
    emit(0x9d, 0x00, 0xd9); // STA $D900,X
    emit(0x9d, 0x00, 0xda); // STA $DA00,X
    emit(0xe8); // INX
    emit(0xd0, (colLoop - bytes.length - 2) & 0xff); // BNE colLoop
    emit(0xa2, 232); // LDX #232
    const colLoop2 = bytes.length;
    emit(0x9d, 0xff, 0xda); // STA $DAFF,X  (covers $DB00..$DBE7)
    emit(0xca); // DEX
    emit(0xd0, (colLoop2 - bytes.length - 2) & 0xff); // BNE colLoop2
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
        // A computed address: the value waits on the stack while the address is built in ACC,
        // which is then the pointer for STA (ACC),Y.
        assertFits8(valueExpr, e.line, 'a byte');
        const byteConst = evalConst(valueExpr);
        if (byteConst !== null) emit(0xa9, byteConst & 0xff);
        else genExpr(valueExpr);
        emit(0x48); // PHA: the value waits on the stack while the address is built
        gen16(addrExpr);
        emit(0x68, 0xa0, 0x00, 0x91, ACC); // PLA; LDY #0; STA (ACC),Y
        return;
      }
      assertFits8(valueExpr, e.line, 'a byte');
      const byteVal = evalConst(valueExpr);
      if (byteVal !== null) emit(0xa9, byteVal & 0xff);
      else genExpr(valueExpr);
      emit(0x8d, addrVal & 0xff, (addrVal >> 8) & 0xff);
      return;
    }
    // ── built-in: clrscr() ────────────────────────────────────────────────
    if (e.name === 'clrscr') {
      genClrscr();
      return;
    }

    // ── built-in: puts(row, col, "TEXT" [, colour]) — constant stores ─────────
    if (e.name === 'puts') {
      const [rowE, colE, textE, colourE] = e.args;
      const row = rowE !== undefined ? evalConst(rowE) : null;
      const col = colE !== undefined ? evalConst(colE) : null;
      if (row === null || col === null) {
        throw new CodeGenError(
          'puts(): row and column must be compile-time constants ' +
            '(use poke(screen(row, col), code) for a position known only at run time)',
          e.line,
          0,
        );
      }
      if (textE === undefined || textE.tag !== 'strLit') {
        throw new CodeGenError('puts(): the third argument must be a string literal', e.line, 0);
      }
      const colour = colourE !== undefined ? evalConst(colourE) : null;
      if (colourE !== undefined && colour === null) {
        throw new CodeGenError('puts(): the colour must be a compile-time constant', e.line, 0);
      }
      const cell = row * 40 + col;
      let loaded = -1;
      textE.codes.forEach((code, i) => {
        if (code !== loaded) emit(0xa9, code); // LDA #code (skipped when A already holds it)
        loaded = code;
        const a = 0x0400 + cell + i;
        emit(0x8d, a & 0xff, (a >> 8) & 0xff); // STA screen cell
      });
      if (colour !== null) {
        emit(0xa9, colour & 0x0f); // LDA #colour
        for (let i = 0; i < textE.codes.length; i++) {
          const a = 0xd800 + cell + i;
          emit(0x8d, a & 0xff, (a >> 8) & 0xff); // STA colour cell
        }
      }
      return;
    }

    // ── built-in: peek(addr) — the byte at any address ──
    if (e.name === 'peek') {
      const a = e.args[0];
      if (a === undefined) throw new CodeGenError('peek() takes an address', e.line, 0);
      const c = evalConst(a);
      if (c !== null) {
        emit(0xad, c & 0xff, (c >> 8) & 0xff); // LDA abs
        return;
      }
      gen16(a);
      emit(0xa0, 0x00, 0xb1, ACC); // LDY #0; LDA (ACC),Y
      return;
    }

    // ── built-ins: spritePtr(addr) — the pointer value for sprite data at addr ──
    if (e.name === 'spritePtr') {
      const value = evalConst(e);
      if (value === null) {
        throw new CodeGenError(
          'spritePtr(): the address must be a compile-time constant',
          e.line,
          0,
        );
      }
      emit(0xa9, value & 0xff);
      return;
    }

    // ── built-ins: screen(row, col) / color(row, col) — compile-time addresses ──
    if (e.name === 'screen' || e.name === 'color') {
      const address = evalConst(e);
      if (address === null) {
        genScreenAddr(e);
        emit(0xa5, ACC); // the low byte, as for any address in an 8-bit context
        return;
      }
      emit(0xa9, address & 0xff);
      return;
    }

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
      assertFits8(arg, e.line, `parameter '${param?.name}' of '${e.name}'`);
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
      addFixup({ tag: 'abs16', label: `fn_${e.name}` }, 2);
    }
  }

  /** A value stored into an 8-bit target must be known to fit, or be narrowed explicitly. */
  function assertFits8(value: Expr, line: number, what: string): void {
    const c = evalConst(value);
    if (c !== null) {
      if (c > 0xff) throw new CodeGenError(`value ${c} does not fit in ${what}`, line, 0);
      return;
    }
    if (isU16(value)) {
      throw new CodeGenError(
        `a 16-bit value cannot be stored in ${what}; use lo(...) or 'as u8'`,
        line,
        0,
      );
    }
  }

  /** Loads the low (or high) byte of a variable or constant argument of lo() / hi(). */
  function genByteOf(arg: Expr, high: boolean, line: number): void {
    const c = evalConst(arg);
    if (c !== null) {
      emit(0xa9, (high ? c >> 8 : c) & 0xff);
      return;
    }
    if (arg.tag === 'ident') {
      const v = lookup(arg.name);
      if (high && v && v.type.tag !== 'u16') {
        throw new CodeGenError(
          `hi() needs a 16-bit value, but '${arg.name}' is ${v.type.tag}`,
          line,
          0,
        );
      }
      if (v && v.zpAddr !== null) {
        emit(0xa5, v.zpAddr + (high ? 1 : 0));
        return;
      }
      if (v && v.absAddr !== null) {
        const a = v.absAddr + (high ? 1 : 0);
        emit(0xad, a & 0xff, (a >> 8) & 0xff);
        return;
      }
    }
    if (isU16(arg)) {
      gen16(arg);
      emit(0xa5, ACC + (high ? 1 : 0));
      return;
    }
    throw new CodeGenError(`${high ? 'hi' : 'lo'}() needs a variable or a constant`, line, 0);
  }

  function genExpr(e: Expr): void {
    switch (e.tag) {
      case 'intLit':
        emit(0xa9, e.value & 0xff);
        break;
      case 'boolLit':
        emit(0xa9, e.value ? 0x01 : 0x00);
        break;
      case 'ident': {
        const v = lookup(e.name);
        if (v && v.isConst && v.constValue !== null) {
          emit(0xa9, v.constValue & 0xff);
        } else if (v && v.zpAddr !== null) {
          emit(0xa5, v.zpAddr);
        } else if (v && v.absAddr !== null) {
          emit(0xad, v.absAddr & 0xff, (v.absAddr >> 8) & 0xff);
        } else {
          throw new CodeGenError(`cannot read '${e.name}'`, e.line, 0);
        }
        break;
      }
      case 'field': {
        if (e.obj.tag !== 'ident') {
          throw new CodeGenError(
            'only hardware fields can be read (e.g. VIC2.borderColor)',
            e.line,
            0,
          );
        }
        const addr = hwAddr(e.obj.name, e.field, e.line);
        emit(0xad, addr & 0xff, (addr >> 8) & 0xff);
        break;
      }
      case 'unary':
        if (e.op !== '!') {
          throw new CodeGenError(`unary operator '${e.op}' is not supported yet`, e.line, 0);
        }
        genExpr(e.rhs);
        // !x is 1 when x is 0, else 0 — for any u8, not just 0/1:
        emit(0xc9, 0x01); // CMP #1   (carry set when x >= 1)
        emit(0xa9, 0x00); // LDA #0
        emit(0x2a); // ROL A    (A = 1 when x was non-zero)
        emit(0x49, 0x01); // EOR #1
        break;
      case 'binary': {
        const folded = evalConst(e);
        if (folded !== null) emit(0xa9, folded & 0xff);
        else genBinary(e);
        break;
      }
      case 'cast':
        if (e.toType.tag === 'u8' && isU16(e.expr) && evalConst(e.expr) === null) {
          gen16(e.expr); // narrowing a 16-bit expression keeps its low byte
          emit(0xa5, ACC);
        } else genExpr(e.expr);
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
        genIndexRead(e);
        break;
      case 'strLit':
        throw new CodeGenError('string literals are only allowed in puts()', e.line, 0);
    }
  }

  function prepareOperandCarry(immOp: number): void {
    if (immOp === 0x69)
      emit(0x18); // CLC before ADC
    else if (immOp === 0xe9) emit(0x38); // SEC before SBC
  }

  /** Emits `<op> operand`, evaluating a complex byte operand through the accumulator scratch. */
  function genOperand(rhs: Expr, immOp: number, zpOp: number, absOp: number): void {
    const c = evalConst(rhs);
    if (c !== null) {
      prepareOperandCarry(immOp);
      emit(immOp, c & 0xff);
      return;
    }
    if (rhs.tag === 'ident') {
      const v = lookup(rhs.name);
      if (v && v.zpAddr !== null) {
        prepareOperandCarry(immOp);
        emit(zpOp, v.zpAddr);
        return;
      }
      if (v && v.absAddr !== null) {
        prepareOperandCarry(immOp);
        emit(absOp, v.absAddr & 0xff, (v.absAddr >> 8) & 0xff);
        return;
      }
    }
    if (rhs.tag === 'field' && rhs.obj.tag === 'ident') {
      const addr = hwAddr(rhs.obj.name, rhs.field, rhs.line);
      prepareOperandCarry(immOp);
      emit(absOp, addr & 0xff, (addr >> 8) & 0xff);
      return;
    }
    // Preserve the accumulator's left value while the right expression is evaluated. $F8 is
    // compiler-owned scratch, so the computed byte can be used by the ALU after restoring A.
    emit(0x48); // PHA
    genExpr(rhs);
    emit(0x85, ACC, 0x68); // STA ACC; PLA
    prepareOperandCarry(immOp);
    emit(zpOp, ACC);
  }

  /** A right-hand operand of 16-bit math: loads byte 0 (low) or 1 (high) with the given opcodes. */
  interface Operand16 {
    load(byte: 0 | 1, imm: number, zp: number, abs: number): void;
  }

  const U16_RHS_HINT =
    'right-hand operand must be a literal, a variable or a hardware register ' +
    '(assign the sub-expression to a variable first)';

  function operand16(rhs: Expr): Operand16 {
    const c = evalConst(rhs);
    if (c !== null) {
      return { load: (b, imm) => emit(imm, b === 0 ? c & 0xff : (c >> 8) & 0xff) };
    }
    if (rhs.tag === 'ident') {
      const v = lookup(rhs.name);
      if (v && (v.zpAddr !== null || v.absAddr !== null)) {
        const wide = v.type.tag === 'u16';
        return {
          load: (b, imm, zp, abs) => {
            if (b === 1 && !wide) emit(imm, 0);
            else if (v.zpAddr !== null) emit(zp, v.zpAddr + b);
            else {
              const a = (v.absAddr as number) + b;
              emit(abs, a & 0xff, (a >> 8) & 0xff);
            }
          },
        };
      }
    }
    if (rhs.tag === 'field' && rhs.obj.tag === 'ident') {
      const addr = hwAddr(rhs.obj.name, rhs.field, rhs.line);
      return {
        load: (b, imm, _zp, abs) => {
          if (b === 1) emit(imm, 0);
          else emit(abs, addr & 0xff, (addr >> 8) & 0xff);
        },
      };
    }
    throw new CodeGenError(U16_RHS_HINT, rhs.line, 0);
  }

  /** The array an index expression refers to, with its address and whether it is zero page. */
  function arrayOf(e: Extract<Expr, { tag: 'index' }>): { base: number; zp: boolean } {
    if (e.obj.tag !== 'ident') {
      throw new CodeGenError('only named arrays can be indexed', e.line, 0);
    }
    const v = lookup(e.obj.name);
    if (!v || v.type.tag !== 'array') {
      throw new CodeGenError(`'${e.obj.name}' is not an array`, e.line, 0);
    }
    if (v.zpAddr !== null) return { base: v.zpAddr, zp: true };
    if (v.absAddr !== null) return { base: v.absAddr, zp: false };
    throw new CodeGenError(`cannot index '${e.obj.name}'`, e.line, 0);
  }

  /** Leaves the address of the indexed element in ACC (the 16-bit index path). */
  function genElementAddr(e: Extract<Expr, { tag: 'index' }>, base: number): void {
    gen16(e.idx);
    emit(0x18, 0xa5, ACC, 0x69, base & 0xff, 0x85, ACC); // CLC; ACC.lo += lo(base)
    emit(0xa5, ACC + 1, 0x69, (base >> 8) & 0xff, 0x85, ACC + 1); // ACC.hi += hi(base) + carry
  }

  function genIndexRead(e: Extract<Expr, { tag: 'index' }>): void {
    const { base, zp } = arrayOf(e);
    const k = evalConst(e.idx);
    if (k !== null) {
      const a = base + k;
      if (zp) emit(0xa5, a & 0xff);
      else emit(0xad, a & 0xff, (a >> 8) & 0xff);
      return;
    }
    if (!isU16(e.idx)) {
      genExpr(e.idx);
      emit(0xaa); // TAX
      if (zp)
        emit(0xb5, base & 0xff); // LDA zp,X
      else emit(0xbd, base & 0xff, (base >> 8) & 0xff); // LDA abs,X
      return;
    }
    genElementAddr(e, base);
    emit(0xa0, 0x00, 0xb1, ACC); // LDY #0; LDA (ACC),Y
  }

  /** Stores the byte waiting on the stack (pushed by the caller) to the indexed element. */
  function genIndexWrite(e: Extract<Expr, { tag: 'index' }>): void {
    const { base, zp } = arrayOf(e);
    const k = evalConst(e.idx);
    if (k !== null) {
      const a = base + k;
      emit(0x68); // PLA
      if (zp) emit(0x85, a & 0xff);
      else emit(0x8d, a & 0xff, (a >> 8) & 0xff);
      return;
    }
    if (!isU16(e.idx)) {
      genExpr(e.idx);
      emit(0xaa, 0x68); // TAX; PLA
      if (zp)
        emit(0x95, base & 0xff); // STA zp,X
      else emit(0x9d, base & 0xff, (base >> 8) & 0xff); // STA abs,X
      return;
    }
    genElementAddr(e, base);
    emit(0x68, 0xa0, 0x00, 0x91, ACC); // PLA; LDY #0; STA (ACC),Y
  }

  /** `screen(row, col)` / `color(row, col)` with run-time arguments → ACC. */
  function genScreenAddr(e: Extract<Expr, { tag: 'call' }>): void {
    const [rowE, colE] = e.args;
    if (rowE === undefined || colE === undefined) {
      throw new CodeGenError(`${e.name}() takes a row and a column`, e.line, 0);
    }
    if (isU16(rowE) || isU16(colE)) {
      throw new CodeGenError(`${e.name}(): the row and the column must be 8-bit values`, e.line, 0);
    }
    const base = e.name === 'screen' ? 0x0400 : 0xd800;
    genExpr(colE);
    emit(0x48); // PHA: the column waits on the stack while the row is scaled
    genExpr(rowE);
    emit(0x85, ACC, 0xa9, 0x00, 0x85, ACC + 1); // ACC = row
    for (let i = 0; i < 3; i++) emit(0x06, ACC, 0x26, ACC + 1); // ASL lo; ROL hi: row * 8
    emit(0xa5, ACC, 0x85, TMP2, 0xa5, ACC + 1, 0x85, TMP2 + 1); // TMP2 = row * 8
    for (let i = 0; i < 2; i++) emit(0x06, ACC, 0x26, ACC + 1); // row * 32
    emit(0x18, 0xa5, ACC, 0x65, TMP2, 0x85, ACC); // CLC; ACC.lo += TMP2.lo
    emit(0xa5, ACC + 1, 0x65, TMP2 + 1, 0x85, ACC + 1); // ACC.hi += TMP2.hi (+ carry)
    emit(0x68, 0x85, TMP2); // PLA; STA TMP2: the column
    emit(0x18, 0xa5, ACC, 0x65, TMP2, 0x85, ACC); // ACC.lo += column
    emit(0xa5, ACC + 1, 0x69, 0x00, 0x85, ACC + 1); // ACC.hi += carry
    emit(0x18, 0xa5, ACC, 0x69, base & 0xff, 0x85, ACC); // ACC.lo += lo(base)
    emit(0xa5, ACC + 1, 0x69, (base >> 8) & 0xff, 0x85, ACC + 1); // ACC.hi += hi(base) + carry
  }

  /** Evaluates `e` as a 16-bit value into ACC (low) / ACC+1 (high). */
  function gen16(e: Expr): void {
    const c = evalConst(e);
    if (c !== null) {
      emit(0xa9, c & 0xff, 0x85, ACC, 0xa9, (c >> 8) & 0xff, 0x85, ACC + 1);
      return;
    }
    if (e.tag === 'ident') {
      const v = lookup(e.name);
      if (v && v.type.tag === 'u16' && !v.isConst) {
        for (const b of [0, 1] as const) {
          if (v.zpAddr !== null) emit(0xa5, v.zpAddr + b);
          else if (v.absAddr !== null) {
            const a = v.absAddr + b;
            emit(0xad, a & 0xff, (a >> 8) & 0xff);
          } else throw new CodeGenError(`cannot read '${e.name}'`, e.line, 0);
          emit(0x85, ACC + b);
        }
        return;
      }
    }
    if (e.tag === 'cast' && e.toType.tag === 'u16') {
      gen16(e.expr);
      return;
    }
    if (e.tag === 'binary' && (e.op === '+' || e.op === '-') && isU16(e)) {
      gen16(e.lhs);
      const r = operand16(e.rhs);
      const add = e.op === '+';
      const [imm, zp, abs] = add ? [0x69, 0x65, 0x6d] : [0xe9, 0xe5, 0xed];
      emit(0xa5, ACC, add ? 0x18 : 0x38); // LDA lo; CLC | SEC
      r.load(0, imm, zp, abs);
      emit(0x85, ACC, 0xa5, ACC + 1); // STA lo; LDA hi
      r.load(1, imm, zp, abs);
      emit(0x85, ACC + 1);
      return;
    }
    if (e.tag === 'call' && (e.name === 'screen' || e.name === 'color')) {
      genScreenAddr(e);
      return;
    }
    if (isU16(e)) {
      throw new CodeGenError('this 16-bit expression is not supported yet', e.line, 0);
    }
    genExpr(e); // an 8-bit value: zero-extend
    emit(0x85, ACC, 0xa9, 0x00, 0x85, ACC + 1);
  }

  function genBinary(e: Extract<Expr, { tag: 'binary' }>): void {
    if (e.op === '&&' || e.op === '||' || isCompareOp(e.op)) {
      const what = isCompareOp(e.op) ? `comparison '${e.op}'` : `'${e.op}'`;
      throw new CodeGenError(
        `${what} can only be used as a condition (if / while / for)`,
        e.line,
        0,
      );
    }
    if (!BYTE_OPS.has(e.op)) {
      throw new CodeGenError(`operator '${e.op}' is not supported yet`, e.line, 0);
    }
    if (isU16(e.lhs) || isU16(e.rhs)) {
      throw new CodeGenError('16-bit arithmetic is not supported yet', e.line, 0);
    }
    switch (e.op) {
      case '+':
        genExpr(e.lhs);
        genOperand(e.rhs, 0x69, 0x65, 0x6d); // ADC #imm, ADC zp, ADC abs
        break;
      case '-':
        genExpr(e.lhs);
        genOperand(e.rhs, 0xe9, 0xe5, 0xed); // SBC #imm, SBC zp, SBC abs
        break;
      case '&':
        genExpr(e.lhs);
        genOperand(e.rhs, 0x29, 0x25, 0x2d); // AND #imm, AND zp, AND abs
        break;
      case '|':
        genExpr(e.lhs);
        genOperand(e.rhs, 0x09, 0x05, 0x0d); // ORA #imm, ORA zp, ORA abs
        break;
      case '^':
        genExpr(e.lhs);
        genOperand(e.rhs, 0x49, 0x45, 0x4d); // EOR #imm, EOR zp, EOR abs
        break;
    }
  }

  // Emit the CMP operand, choosing imm/zp/abs mode based on rhs type
  function genCmpRhs(rhs: Expr): void {
    genOperand(rhs, 0xc9, 0xc5, 0xcd); // CMP #imm, CMP zp, CMP abs
  }

  // Emit branch instruction(s) for a comparison operator.
  // invertForFalse=true: branch to label when condition is FALSE (skip body).
  // invertForFalse=false: branch to label when condition is TRUE.
  function emitCondJump(op: CompareOp, label: string, invertForFalse: boolean): void {
    if (invertForFalse) {
      switch (op) {
        case '==':
          emit(0xd0);
          addFixup({ tag: 'branch8', label }, 1);
          break; // BNE
        case '!=':
          emit(0xf0);
          addFixup({ tag: 'branch8', label }, 1);
          break; // BEQ
        case '<':
          emit(0xb0);
          addFixup({ tag: 'branch8', label }, 1);
          break; // BCS (skip when >=)
        case '>=':
          emit(0x90);
          addFixup({ tag: 'branch8', label }, 1);
          break; // BCC (skip when <)
        case '>': {
          // FALSE when x <= k: C=0 (x<k) OR Z=1 (x==k) → BCC + BEQ both skip
          emit(0x90);
          addFixup({ tag: 'branch8', label }, 1); // BCC
          emit(0xf0);
          addFixup({ tag: 'branch8', label }, 1); // BEQ
          break;
        }
        case '<=': {
          // FALSE when x > k: C=1 AND Z=0 → BCC skips to okLabel; BNE skips to label
          const okLabel = freshLabel('cmp_ok');
          emit(0x90);
          addFixup({ tag: 'branch8', label: okLabel }, 1); // BCC → x<k → keep going
          emit(0xd0);
          addFixup({ tag: 'branch8', label }, 1); // BNE → x>k → skip
          emitLabel(okLabel);
          break;
        }
      }
    } else {
      switch (op) {
        case '==':
          emit(0xf0);
          addFixup({ tag: 'branch8', label }, 1);
          break; // BEQ
        case '!=':
          emit(0xd0);
          addFixup({ tag: 'branch8', label }, 1);
          break; // BNE
        case '<':
          emit(0x90);
          addFixup({ tag: 'branch8', label }, 1);
          break; // BCC
        case '>=':
          emit(0xb0);
          addFixup({ tag: 'branch8', label }, 1);
          break; // BCS
        case '>': {
          // TRUE when C=1 AND Z=0: BEQ skips to notGt; BCS jumps when >
          const notGtLabel = freshLabel('cmp_skip');
          emit(0xf0);
          addFixup({ tag: 'branch8', label: notGtLabel }, 1); // BEQ → equal → not >
          emit(0xb0);
          addFixup({ tag: 'branch8', label }, 1); // BCS → C=1,Z=0 → is >
          emitLabel(notGtLabel);
          break;
        }
        case '<=': {
          // TRUE when C=0 OR Z=1: BCC + BEQ both jump
          emit(0x90);
          addFixup({ tag: 'branch8', label }, 1); // BCC → <
          emit(0xf0);
          addFixup({ tag: 'branch8', label }, 1); // BEQ → =
          break;
        }
      }
    }
  }

  /**
   * Compares two 16-bit values and leaves the flags for `jumpOp16(op)`:
   *   == / !=  → Z (equal)        < / >=  → C (a >= b)
   *   > / <=   → the operands are swapped, so C is clear when a > b.
   */
  function genCompare16(cond: Extract<Expr, { tag: 'binary' }>): void {
    const op = cond.op;
    gen16(cond.lhs);
    const r = operand16(cond.rhs);
    if (op === '>' || op === '<=') {
      // b - a: C is clear when b < a, i.e. a > b.
      r.load(0, 0xa9, 0xa5, 0xad); // LDA b.lo
      emit(0xc5, ACC); // CMP a.lo
      r.load(1, 0xa9, 0xa5, 0xad); // LDA b.hi
      emit(0xe5, ACC + 1); // SBC a.hi
      return;
    }
    if (op === '==' || op === '!=') {
      const ne = freshLabel('cmp16_ne');
      emit(0xa5, ACC); // LDA a.lo
      r.load(0, 0xc9, 0xc5, 0xcd); // CMP b.lo
      emit(0xd0);
      addFixup({ tag: 'branch8', label: ne }, 1); // BNE: Z is already clear
      emit(0xa5, ACC + 1); // LDA a.hi
      r.load(1, 0xc9, 0xc5, 0xcd); // CMP b.hi: Z set when equal
      emitLabel(ne);
      return;
    }
    emit(0xa5, ACC); // LDA a.lo
    r.load(0, 0xc9, 0xc5, 0xcd); // CMP b.lo
    emit(0xa5, ACC + 1); // LDA a.hi
    r.load(1, 0xe9, 0xe5, 0xed); // SBC b.hi: C set when a >= b
  }

  /** The 8-bit condition whose branch test matches the flags left by `genCompare16`. */
  function jumpOp16(op: CompareOp): CompareOp {
    if (op === '>') return '<'; // C clear after the swapped subtraction
    if (op === '<=') return '>=';
    return op;
  }

  /**
   * Emits code that continues at `label` when the condition is false (`invertForFalse`) or
   * true (otherwise). A 6502 branch reaches only ±127 bytes, so this never branches to `label`
   * directly: it branches the opposite way over a JMP, which can go anywhere.
   *
   * `&&`, `||` and `!` are control flow, not values: each operand is tested on its own and the
   * right operand is skipped when the left one decides (short-circuit), so the operands may be
   * comparisons, which have no value form.
   */
  function genCondBranch(cond: Expr, label: string, invertForFalse: boolean): void {
    if (cond.tag === 'binary' && cond.op === '&&') {
      if (invertForFalse) {
        // Go to `label` when either operand is false.
        genCondBranch(cond.lhs, label, true);
        genCondBranch(cond.rhs, label, true);
      } else {
        // Go to `label` when both are true: a false left operand skips the right one.
        const skip = freshLabel('and_skip');
        genCondBranch(cond.lhs, skip, true);
        genCondBranch(cond.rhs, label, false);
        emitLabel(skip);
      }
      return;
    }
    if (cond.tag === 'binary' && cond.op === '||') {
      if (invertForFalse) {
        // Go to `label` when both operands are false: a true left operand skips the right one.
        const skip = freshLabel('or_skip');
        genCondBranch(cond.lhs, skip, false);
        genCondBranch(cond.rhs, label, true);
        emitLabel(skip);
      } else {
        // Go to `label` when either operand is true.
        genCondBranch(cond.lhs, label, false);
        genCondBranch(cond.rhs, label, false);
      }
      return;
    }
    if (cond.tag === 'unary' && cond.op === '!') {
      genCondBranch(cond.rhs, label, !invertForFalse);
      return;
    }
    const stay = freshLabel('cond_stay');
    if (cond.tag === 'binary' && isCompareOp(cond.op)) {
      if (isU16(cond.lhs) || isU16(cond.rhs)) {
        genCompare16(cond);
        emitCondJump(jumpOp16(cond.op), stay, !invertForFalse);
      } else {
        genExpr(cond.lhs);
        genCmpRhs(cond.rhs);
        // Stay (fall into the body / loop) when the jump to `label` is NOT wanted.
        emitCondJump(cond.op, stay, !invertForFalse);
      }
    } else if (isU16(cond)) {
      // A 16-bit value is true when either byte is non-zero.
      gen16(cond);
      emit(0xa5, ACC, 0x05, ACC + 1); // LDA lo; ORA hi
      emit(invertForFalse ? 0xd0 : 0xf0); // BNE / BEQ over the jump
      addFixup({ tag: 'branch8', label: stay }, 1);
    } else {
      // Any other value is true when it is non-zero. CMP #0 makes the flags reflect A even
      // after a function call returned it.
      genExpr(cond);
      emit(0xc9, 0x00);
      emit(invertForFalse ? 0xd0 : 0xf0); // BNE / BEQ over the jump
      addFixup({ tag: 'branch8', label: stay }, 1);
    }
    emit(0x4c); // JMP label
    addFixup({ tag: 'abs16', label }, 2);
    emitLabel(stay);
  }

  // ─── asm {} ─────────────────────────────────────────────────────────────
  let asmCounter = 0;

  type AsmValue =
    | { kind: 'value'; value: number; fromConst: boolean; fromVar: boolean }
    | { kind: 'label'; label: string }
    | { kind: 'byte'; label: string; high: boolean };

  function resolveAsm(
    e: AsmExpr,
    defined: ReadonlySet<string>,
    mangle: (name: string) => string,
  ): AsmValue {
    switch (e.tag) {
      case 'num':
        return { kind: 'value', value: e.value, fromConst: false, fromVar: false };
      case 'label':
        if (!defined.has(e.name)) {
          throw new CodeGenError(`undefined label '${e.name}'`, e.line, 0);
        }
        return { kind: 'label', label: mangle(e.name) };
      case 'sym': {
        const ex = e.expr;
        if (ex.tag === 'ident') {
          const v = lookup(ex.name);
          if (v) {
            if (v.isConst && v.constValue !== null) {
              // A u8/bool constant is a data value: storing to "its address" is almost
              // certainly a mistake. A u16 constant (or any constant expression) is an
              // address, which is how asm uses them: `sta ${TABLE},x`.
              const isData = v.type.tag === 'u8' || v.type.tag === 'bool';
              return { kind: 'value', value: v.constValue, fromConst: isData, fromVar: false };
            }
            const addr = v.zpAddr ?? v.absAddr;
            if (addr !== null)
              return { kind: 'value', value: addr, fromConst: false, fromVar: true };
          }
          const fn = cp.fns.get(ex.name);
          if (fn) {
            if (fn.isInline) {
              throw new CodeGenError(`'${ex.name}' is @inline and has no address`, e.line, 0);
            }
            return { kind: 'label', label: `fn_${ex.name}` };
          }
        }
        const c = evalConst(ex);
        if (c === null) {
          throw new CodeGenError(
            '${…} must be a variable, a function or a compile-time constant',
            e.line,
            0,
          );
        }
        return { kind: 'value', value: c, fromConst: false, fromVar: false };
      }
      case 'lo':
      case 'hi': {
        const inner = resolveAsm(e.arg, defined, mangle);
        if (inner.kind === 'value') {
          const v = e.tag === 'hi' ? inner.value >> 8 : inner.value;
          return { kind: 'value', value: v & 0xff, fromConst: inner.fromConst, fromVar: false };
        }
        if (inner.kind === 'label')
          return { kind: 'byte', label: inner.label, high: e.tag === 'hi' };
        throw new CodeGenError(`${e.tag}() cannot be nested`, e.line, 0);
      }
      case 'add': {
        const inner = resolveAsm(e.lhs, defined, mangle);
        if (inner.kind !== 'value') {
          throw new CodeGenError(
            'an offset cannot be added to a label or function address',
            e.line,
            0,
          );
        }
        return { ...inner, value: inner.value + e.offset };
      }
    }
  }

  function genAsm(s: Extract<Stmt, { tag: 'asm' }>): void {
    const id = asmCounter++; // per emission: an @inline function may be expanded many times
    const mangle = (name: string): string => `__asm${id}_${name}`;
    const defined = new Set<string>();
    for (const item of s.items) {
      if (item.tag !== 'label') continue;
      if (defined.has(item.name)) {
        throw new CodeGenError(
          `label '${item.name}' is defined twice in this asm block`,
          item.line,
          0,
        );
      }
      defined.add(item.name);
    }
    for (const item of s.items) {
      if (item.tag === 'label') emitLabel(mangle(item.name));
      else genAsmInstr(item, defined, mangle);
    }
  }

  function genAsmInstr(
    item: Extract<AsmItem, { tag: 'instr' }>,
    defined: ReadonlySet<string>,
    mangle: (name: string) => string,
  ): void {
    const op = item.operand;
    const line = item.line;
    let shape: AsmShape;
    switch (op.tag) {
      case 'none':
      case 'acc':
      case 'imm':
      case 'izx':
      case 'izy':
      case 'ind':
        shape = op.tag;
        break;
      case 'addr':
        shape = op.index === 'x' ? 'addrx' : op.index === 'y' ? 'addry' : 'addr';
        break;
    }
    const resolved = 'value' in op ? resolveAsm(op.value, defined, mangle) : null;
    const known = resolved !== null && resolved.kind === 'value' ? resolved.value : null;

    const choice = chooseMode(item.mnemonic, shape, known);
    if ('error' in choice) throw new CodeGenError(choice.error, line, 0);
    const mode = choice.mode;
    const opcode = opcodeFor(item.mnemonic, mode)!;

    if (resolved && resolved.kind === 'value') {
      if (mode === 'imm' && resolved.fromVar) {
        throw new CodeGenError(
          "'#' needs a constant, but the operand is the address of a variable; " +
            'use lo(${…}) or hi(${…}) for one byte of it',
          line,
          0,
        );
      }
      const kind = OPS[opcode]!.kind;
      // `sta (${PTR}),y` stores THROUGH the pointer, not to the constant itself.
      const throughPointer = mode === 'izx' || mode === 'izy';
      if (
        resolved.fromConst &&
        mode !== 'imm' &&
        !throughPointer &&
        (kind === 'write' || kind === 'rmw')
      ) {
        throw new CodeGenError(
          `cannot write to constant: '${item.mnemonic}' stores to it`,
          line,
          0,
        );
      }
    }

    switch (mode) {
      case 'imp':
      case 'acc':
        emit(opcode);
        return;
      case 'imm':
        if (resolved?.kind === 'byte') {
          emit(opcode);
          addFixup(
            { tag: resolved.high ? 'absHiByte' : 'absLoByte', label: resolved.label },
            1,
            line,
          );
          return;
        }
        if (resolved?.kind === 'label') {
          throw new CodeGenError(
            "'#' needs lo(...) or hi(...) of an address, not the address itself",
            line,
            0,
          );
        }
        emit(opcode, (known ?? 0) & 0xff);
        return;
      case 'zp':
      case 'zpx':
      case 'zpy':
      case 'izx':
      case 'izy':
        if (known === null) {
          throw new CodeGenError(
            `'${item.mnemonic}' needs a zero-page address, not a label or function`,
            line,
            0,
          );
        }
        emit(opcode, known & 0xff);
        return;
      case 'rel':
        if (resolved?.kind !== 'label') {
          throw new CodeGenError(`'${item.mnemonic}' needs a label to branch to`, line, 0);
        }
        emit(opcode);
        addFixup({ tag: 'branch8', label: resolved.label }, 1, line);
        return;
      case 'abs':
      case 'abx':
      case 'aby':
      case 'ind':
        if (resolved?.kind === 'label') {
          emit(opcode);
          addFixup({ tag: 'abs16', label: resolved.label }, 2, line);
        } else if (resolved?.kind === 'value') {
          emit(opcode, resolved.value & 0xff, (resolved.value >> 8) & 0xff);
        } else {
          throw new CodeGenError(`'${item.mnemonic}' needs an address`, line, 0);
        }
        return;
    }
  }

  const COMPOUND_OPS: Partial<Record<AssignOp, BinaryOp>> = {
    '+=': '+',
    '-=': '-',
    '&=': '&',
    '|=': '|',
    '^=': '^',
  };

  /** Stores `rhs` into the 16-bit variable `target` (low byte first), widening a u8 value. */
  function genStore16(target: ResolvedVar, name: string, rhs: Expr, line: number): void {
    const base = target.zpAddr ?? target.absAddr;
    if (base === null) throw new CodeGenError(`cannot assign to '${name}'`, line, 0);
    const store = (offset: number): void => {
      if (target.zpAddr !== null) emit(0x85, target.zpAddr + offset);
      else emit(0x8d, (base + offset) & 0xff, ((base + offset) >> 8) & 0xff);
    };
    let value = rhs;
    while (value.tag === 'cast' && value.toType.tag === 'u16') value = value.expr;

    const c = evalConst(value);
    if (c !== null) {
      emit(0xa9, c & 0xff);
      store(0);
      emit(0xa9, (c >> 8) & 0xff);
      store(1);
      return;
    }
    if (value.tag === 'ident') {
      const src = lookup(value.name);
      if (src && src.type.tag === 'u16' && !src.isConst) {
        for (const offset of [0, 1]) {
          if (src.zpAddr !== null) emit(0xa5, src.zpAddr + offset);
          else if (src.absAddr !== null) {
            const a = src.absAddr + offset;
            emit(0xad, a & 0xff, (a >> 8) & 0xff);
          }
          store(offset);
        }
        return;
      }
    }
    if (isU16(value)) {
      gen16(value);
      emit(0xa5, ACC);
      store(0);
      emit(0xa5, ACC + 1);
      store(1);
      return;
    }
    genExpr(value); // an 8-bit value: zero-extend
    store(0);
    emit(0xa9, 0x00);
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
    if (lhs.tag === 'index') {
      assertFits8(rhs, line, 'an array element');
      genExpr(rhs);
      emit(0x48); // PHA: the value waits on the stack while the index is computed
      genIndexWrite(lhs);
      return;
    }
    assertFits8(rhs, line, lhs.tag === 'ident' ? `'${lhs.name}'` : 'a byte register');
    genExpr(rhs);
    genStore(lhs);
  }

  function genStmt(s: Stmt): void {
    switch (s.tag) {
      case 'varDecl': {
        const v = lookup(s.name);
        if (!v) throw new CodeGenError(`internal error: '${s.name}' was not declared`, s.line, 0);
        if (v.isConst) break;
        if (!s.init) {
          // Declaration without a value: start at zero, like globals do.
          if (v.zpAddr !== null) {
            const size = sizeOf(v.type, cp.structs);
            emit(0xa9, 0x00);
            for (let i = 0; i < size; i++) emit(0x85, v.zpAddr + i);
          }
          break;
        }
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
          emit(0x4c);
          addFixup({ tag: 'abs16', label: endIfLabel }, 2); // JMP to end
          emitLabel(skipLabel);
        }
        // elif branches
        for (const elif of s.elif) {
          const skipLabel = freshLabel('if_skip');
          genCondBranch(elif.cond, skipLabel, true);
          genStmts(elif.body);
          emit(0x4c);
          addFixup({ tag: 'abs16', label: endIfLabel }, 2);
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
        emit(0x4c);
        addFixup({ tag: 'abs16', label: topLabel }, 2);
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
        emit(0x4c);
        addFixup({ tag: 'abs16', label: topLabel }, 2);
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
        emit(0x4c);
        addFixup({ tag: 'abs16', label: topLabel }, 2);
        emitLabel(endLabel);
        break;
      }
      case 'break': {
        const ctx = loopStack[loopStack.length - 1];
        if (ctx) {
          emit(0x4c);
          addFixup({ tag: 'abs16', label: ctx.breakLabel }, 2);
        }
        break;
      }
      case 'continue': {
        const ctx = loopStack[loopStack.length - 1];
        if (ctx) {
          emit(0x4c);
          addFixup({ tag: 'abs16', label: ctx.continueLabel }, 2);
        }
        break;
      }
      case 'asm':
        genAsm(s);
        break;
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
        emit(0xa9, i === 0 ? value & 0xff : i === 1 ? (value >> 8) & 0xff : 0x00);
        emit(0x85, v.zpAddr + i);
      }
    } else if (v.absAddr !== null && v.initValue !== null) {
      const size = v.type.tag === 'u16' ? 2 : 1;
      for (let i = 0; i < size; i++) {
        const a = v.absAddr + i;
        emit(0xa9, (v.initValue >> (8 * i)) & 0xff);
        emit(0x8d, a & 0xff, (a >> 8) & 0xff);
      }
    }
  }

  // ─── Program block ────────────────────────────────────────────────────
  emitLabel('__program_start');
  emit(0xd8); // CLD — 6502 NMOS decimal mode must be off

  scope = PROGRAM_SCOPE;
  for (const d of cp.program.decls) {
    if (d.tag === 'program') {
      genStmts(d.body);
      break;
    }
  }

  emit(0x4c);
  addFixup({ tag: 'abs16', label: '__program_start' }, 2);

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
  const dataBlocks: Array<{
    decl: Extract<(typeof cp.program.decls)[number], { tag: 'data' }>;
    addr: number;
  }> = [];
  for (const d of cp.program.decls) {
    if (d.tag !== 'data') continue;
    if (d.annotation.tag !== 'addr') {
      throw new CodeGenError('a data block needs an @addr(...) annotation', d.line, 0);
    }
    dataBlocks.push({ decl: d, addr: cp.dataAddrs.get(d) ?? 0 });
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
      if (field.type.tag === 'array' && field.init.length !== field.type.size) {
        throw new CodeGenError(
          `data '${field.name}' has ${field.init.length} values but is declared with ${field.type.size}`,
          decl.line,
          0,
        );
      }
      const wide = field.type.tag === 'u16'; // a scalar u16 field is two bytes, low first
      for (const init of field.init) {
        const v = evalConst(init);
        if (v === null) {
          throw new CodeGenError(
            `data '${field.name}' values must be compile-time constants`,
            decl.line,
            0,
          );
        }
        if (!wide && v > 0xff) {
          throw new CodeGenError(
            `value ${v} does not fit in a byte (data '${field.name}')`,
            decl.line,
            0,
          );
        }
        emit(v & 0xff);
        if (wide) emit((v >> 8) & 0xff);
      }
    }
  }

  return { bytes, labels, fixups, loadAddr: cp.loadAddr };
}
