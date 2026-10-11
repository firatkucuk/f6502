import { TypeError } from './errors';
import { builtinDecls } from './builtin';
import { ZpAllocator } from './symbols';
import type { Program, Stmt, Expr, PsType, StructDecl, HardwareDecl, FnDecl, VarDecl } from './ast';
import { sizeOf } from './ast';

export interface ResolvedVar {
  type: PsType;
  zpAddr: number | null;
  absAddr: number | null;
  /** Declared `const`: folded into the code, has no storage. */
  isConst: boolean;
  constValue: number | null;
  /** Compile-time value of the initialiser, when it has one. */
  initValue: number | null;
  /** True for top-level declarations (initialised once at start-up). */
  isGlobal: boolean;
}

export interface ResolvedFn {
  decl: FnDecl;
  isInline: boolean;
}

export interface CheckedProgram {
  readonly program: Program;
  readonly loadAddr: number;
  /** Globals under their own name; locals and parameters as `<scope>::<name>`. */
  readonly vars: ReadonlyMap<string, ResolvedVar>;
  readonly fns: ReadonlyMap<string, ResolvedFn>;
  readonly structs: ReadonlyMap<string, StructDecl>;
  readonly hardware: ReadonlyMap<string, HardwareDecl>;
  readonly zpUsed: number;
}

/** Scope name of the `program { … }` block; functions use their own name. */
export const PROGRAM_SCOPE = 'program';

export function scopedName(scope: string, name: string): string {
  return `${scope}::${name}`;
}

/** Built-in functions and how many arguments they take. */
const BUILTIN_FNS: ReadonlyMap<string, number> = new Map([
  ['poke', 2],
  ['clrscr', 0],
]);

/**
 * Folds an expression to a number when it is made only of literals and constants. Returns null
 * for anything that needs the machine to evaluate it.
 */
export function foldConst(
  e: Expr,
  lookup: (name: string) => ResolvedVar | undefined,
): number | null {
  switch (e.tag) {
    case 'intLit':
      return e.value;
    case 'boolLit':
      return e.value ? 1 : 0;
    case 'ident': {
      const v = lookup(e.name);
      return v !== undefined && v.isConst ? v.constValue : null;
    }
    case 'cast': {
      const v = foldConst(e.expr, lookup);
      if (v === null) return null;
      return e.toType.tag === 'u8' ? v & 0xff : v & 0xffff;
    }
    case 'lo': {
      const v = foldConst(e.expr, lookup);
      return v === null ? null : v & 0xff;
    }
    case 'hi': {
      const v = foldConst(e.expr, lookup);
      return v === null ? null : (v >> 8) & 0xff;
    }
    case 'unary': {
      if (e.op !== '!') return null;
      const v = foldConst(e.rhs, lookup);
      return v === null ? null : v === 0 ? 1 : 0;
    }
    case 'binary': {
      const l = foldConst(e.lhs, lookup);
      const r = foldConst(e.rhs, lookup);
      if (l === null || r === null) return null;
      switch (e.op) {
        case '+': return (l + r) & 0xffff;
        case '-': return (l - r) & 0xffff;
        case '*': return (l * r) & 0xffff;
        case '&': return l & r;
        case '|': return l | r;
        case '^': return l ^ r;
        case '<<': return (l << r) & 0xffff;
        case '>>': return l >> r;
        default: return null;
      }
    }
    default:
      return null;
  }
}

export function check(userProg: Program): CheckedProgram {
  const builtins = builtinDecls();
  const allDecls = [...builtins, ...userProg.decls];

  const vars = new Map<string, ResolvedVar>();
  const fns = new Map<string, ResolvedFn>();
  const structs = new Map<string, StructDecl>();
  const hardware = new Map<string, HardwareDecl>();
  const zp = new ZpAllocator();
  let loadAddr = 0;
  let hasProgramDecl = false;

  const resolveVar = (scope: string | null, name: string): ResolvedVar | undefined =>
    (scope !== null ? vars.get(scopedName(scope, name)) : undefined) ?? vars.get(name);

  // Pass 1: structs and hardware blocks
  for (const d of allDecls) {
    if (d.tag === 'struct') structs.set(d.name, d);
    if (d.tag === 'hardware') hardware.set(d.name, d);
  }

  /** Registers a variable (global when `scope` is null, otherwise local to that scope). */
  function declare(d: VarDecl, scope: string | null): void {
    const key = scope === null ? d.name : scopedName(scope, d.name);
    if (vars.has(key)) throw new TypeError(`'${d.name}' already defined`, d.line, 0);
    const lookup = (n: string) => resolveVar(scope, n);
    const ann = d.annotation;
    let zpAddr: number | null = null;
    let absAddr: number | null = null;
    let isConst = false;
    let constValue: number | null = null;
    let initValue: number | null = null;

    if (d.isConst && ann.kind === 'none') {
      if (d.init === null) {
        throw new TypeError(`constant '${d.name}' needs an initialiser`, d.line, 0);
      }
      const v = foldConst(d.init, lookup);
      if (v === null) {
        throw new TypeError(
          `constant '${d.name}' needs a compile-time constant initialiser`,
          d.line,
          0,
        );
      }
      isConst = true;
      constValue = d.type.tag === 'u8' || d.type.tag === 'bool' ? v & 0xff : v & 0xffff;
    } else {
      if (ann.kind === 'addr') absAddr = ann.address;
      else zpAddr = zp.alloc(sizeOf(d.type, structs));
      if (d.init !== null) {
        const v = foldConst(d.init, lookup);
        if (v !== null) initValue = v;
        else if (scope === null) {
          throw new TypeError(
            `initialiser of '${d.name}' must be a compile-time constant`,
            d.line,
            0,
          );
        }
      }
    }
    vars.set(key, { type: d.type, zpAddr, absAddr, isConst, constValue, initValue, isGlobal: scope === null });
  }

  // Pass 2: globals, function signatures, the program block
  for (const d of allDecls) {
    if (d.tag === 'varDecl') declare(d, null);

    if (d.tag === 'fn') {
      if (fns.has(d.name)) throw new TypeError(`function '${d.name}' already defined`, d.line, 0);
      fns.set(d.name, { decl: d, isInline: d.isInline });
    }

    if (d.tag === 'program') {
      loadAddr = d.address;
      hasProgramDecl = true;
    }
  }

  if (!hasProgramDecl) {
    throw new TypeError('program block is required', 0, 0);
  }

  // Pass 3: parameters, locals, name resolution
  const calls = new Map<string, Array<{ to: string; line: number }>>();

  for (const d of allDecls) {
    if (d.tag === 'fn') {
      for (const p of d.params) {
        if (p.type.tag !== 'u8' && p.type.tag !== 'bool') {
          throw new TypeError(
            `${p.type.tag} parameter '${p.name}' is not supported yet (only u8 and bool)`,
            d.line,
            0,
          );
        }
        declare(
          { tag: 'varDecl', name: p.name, type: p.type, annotation: { kind: 'none' }, isConst: false, init: null, line: d.line },
          d.name,
        );
      }
      calls.set(d.name, []);
      checkStmts(d.body, d.name, d.name);
    } else if (d.tag === 'program') {
      calls.set(PROGRAM_SCOPE, []);
      checkStmts(d.body, PROGRAM_SCOPE, null);
    }
  }

  // A function needs its parameter slots to itself: there is no stack to save them on.
  const state = new Map<string, 'open' | 'done'>();
  const visit = (name: string): void => {
    state.set(name, 'open');
    for (const edge of calls.get(name) ?? []) {
      if (state.get(edge.to) === 'open') {
        throw new TypeError(
          `function '${edge.to}' is called from within itself; recursion is not supported (there is no stack frame)`,
          edge.line,
          0,
        );
      }
      if (!state.has(edge.to)) visit(edge.to);
    }
    state.set(name, 'done');
  };
  for (const name of calls.keys()) if (!state.has(name)) visit(name);

  return { program: userProg, loadAddr, vars, fns, structs, hardware, zpUsed: zp.used() };

  // ─── statement / expression walk ─────────────────────────────────────

  function checkStmts(stmts: readonly Stmt[], scope: string, fnName: string | null): void {
    for (const s of stmts) checkStmt(s, scope, fnName);
  }

  function checkStmt(s: Stmt, scope: string, fnName: string | null): void {
    const expr = (e: Expr, access: 'read' | 'write' = 'read') => checkExpr(e, access, scope);
    switch (s.tag) {
      case 'assign':
        expr(s.lhs, 'write');
        expr(s.rhs);
        break;
      case 'varDecl':
        if (s.init) expr(s.init);
        declare(s, scope);
        break;
      case 'exprStmt':
        expr(s.expr);
        break;
      case 'return':
        if (s.value) expr(s.value);
        break;
      case 'incDec':
        expr(s.lhs, 'write');
        break;
      case 'if':
        expr(s.cond);
        checkStmts(s.then, scope, fnName);
        for (const e of s.elif) {
          expr(e.cond);
          checkStmts(e.body, scope, fnName);
        }
        if (s.els) checkStmts(s.els, scope, fnName);
        break;
      case 'while':
        expr(s.cond);
        checkStmts(s.body, scope, fnName);
        break;
      case 'loop':
        checkStmts(s.body, scope, fnName);
        break;
      case 'for':
        checkStmt(s.init, scope, fnName);
        expr(s.cond);
        checkStmt(s.post, scope, fnName);
        checkStmts(s.body, scope, fnName);
        break;
      default:
        break; // break / continue / asm: nothing to resolve
    }
  }

  function checkExpr(e: Expr, access: 'read' | 'write', scope: string): void {
    switch (e.tag) {
      case 'ident': {
        const v = resolveVar(scope, e.name);
        if (v === undefined) {
          throw new TypeError(`undefined variable '${e.name}'`, e.line, 0);
        }
        if (access === 'write' && v.isConst) {
          throw new TypeError(`cannot assign to constant '${e.name}'`, e.line, 0);
        }
        break;
      }
      case 'field': {
        if (e.obj.tag !== 'ident') {
          checkExpr(e.obj, 'read', scope);
          break;
        }
        const hw = hardware.get(e.obj.name);
        if (!hw) {
          if (resolveVar(scope, e.obj.name) !== undefined) {
            throw new TypeError(
              `'${e.obj.name}' is not a hardware block (struct field access is not supported yet)`,
              e.line,
              0,
            );
          }
          throw new TypeError(`undefined variable '${e.obj.name}'`, e.line, 0);
        }
        const f = hw.fields.find((field) => field.name === e.field);
        if (f) {
          if (access === 'write' && (f.access === 'readonly' || f.access === 'read_to_clear')) {
            throw new TypeError(`cannot write to readonly field '${e.obj.name}.${e.field}'`, e.line, 0);
          }
          if (access === 'read' && f.access === 'writeonly') {
            throw new TypeError(`cannot read from writeonly field '${e.obj.name}.${e.field}'`, e.line, 0);
          }
        }
        break;
      }
      case 'call': {
        const fn = fns.get(e.name);
        const arity = fn !== undefined ? fn.decl.params.length : BUILTIN_FNS.get(e.name);
        if (arity === undefined) {
          throw new TypeError(`undefined function '${e.name}'`, e.line, 0);
        }
        if (e.args.length !== arity) {
          throw new TypeError(
            `function '${e.name}' expects ${arity} argument${arity === 1 ? '' : 's'}, got ${e.args.length}`,
            e.line,
            0,
          );
        }
        if (fn !== undefined) calls.get(scope)?.push({ to: e.name, line: e.line });
        for (const a of e.args) checkExpr(a, 'read', scope);
        break;
      }
      case 'unary':
        checkExpr(e.rhs, 'read', scope);
        break;
      case 'binary':
        checkExpr(e.lhs, 'read', scope);
        checkExpr(e.rhs, 'read', scope);
        break;
      case 'cast':
      case 'lo':
      case 'hi':
        checkExpr(e.expr, 'read', scope);
        break;
      case 'index':
        checkExpr(e.obj, 'read', scope);
        checkExpr(e.idx, 'read', scope);
        break;
      default:
        break; // literals
    }
  }
}
