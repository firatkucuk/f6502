import { TypeError } from './errors';
import { builtinDecls } from './builtin';
import { ZpAllocator } from './symbols';
import type { Program, Stmt, Expr, PsType, StructDecl, HardwareDecl, FnDecl } from './ast';
import { sizeOf } from './ast';

export interface ResolvedVar {
  type: PsType;
  zpAddr: number | null;
  absAddr: number | null;
  isConst: boolean;
  constValue: number | null;
}

export interface ResolvedFn {
  decl: FnDecl;
  isInline: boolean;
}

export interface CheckedProgram {
  readonly program: Program;
  readonly loadAddr: number;
  readonly vars: ReadonlyMap<string, ResolvedVar>;
  readonly fns: ReadonlyMap<string, ResolvedFn>;
  readonly structs: ReadonlyMap<string, StructDecl>;
  readonly hardware: ReadonlyMap<string, HardwareDecl>;
  readonly zpUsed: number;
}

export function check(userProg: Program): CheckedProgram {
  const builtins = builtinDecls();
  const allDecls = [...builtins, ...userProg.decls];

  const vars    = new Map<string, ResolvedVar>();
  const fns     = new Map<string, ResolvedFn>();
  const structs  = new Map<string, StructDecl>();
  const hardware = new Map<string, HardwareDecl>();
  const zp = new ZpAllocator();
  let loadAddr = 0;
  let hasProgramDecl = false;

  // Pass 1: collect struct and hardware declarations
  for (const d of allDecls) {
    if (d.tag === 'struct')   structs.set(d.name, d);
    if (d.tag === 'hardware') hardware.set(d.name, d);
  }

  // Pass 2: collect vars, consts, fns; assign ZP addresses
  for (const d of allDecls) {
    if (d.tag === 'varDecl') {
      const ann = d.annotation;
      let zpAddr: number | null = null;
      let absAddr: number | null = null;

      if (ann.kind === 'zp') {
        const size = sizeOf(d.type, structs);
        zpAddr = zp.alloc(size);
      } else if (ann.kind === 'addr') {
        absAddr = ann.address;
      }

      // Fold unannotated intLit vars (including color constants) to constValue
      let isConst = false;
      let constValue: number | null = null;
      if (ann.kind === 'none' && d.init !== null && d.init.tag === 'intLit') {
        isConst = true;
        constValue = d.init.value;
      }

      if (vars.has(d.name)) throw new TypeError(`'${d.name}' already defined`, d.line, 0);
      vars.set(d.name, { type: d.type, zpAddr, absAddr, isConst, constValue });
    }

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

  // Pass 3: type-check statement bodies
  for (const d of allDecls) {
    if (d.tag === 'fn' || d.tag === 'program') {
      checkStmts(d.body, hardware, vars);
    }
  }

  return { program: userProg, loadAddr, vars, fns, structs, hardware, zpUsed: zp.used() };
}

function checkExpr(
  e: Expr,
  access: 'read' | 'write',
  hardware: Map<string, HardwareDecl>,
): void {
  if (e.tag === 'field' && e.obj.tag === 'ident') {
    const hw = hardware.get(e.obj.name);
    if (hw) {
      const f = hw.fields.find(field => field.name === e.field);
      if (f) {
        if (access === 'write' && (f.access === 'readonly' || f.access === 'read_to_clear')) {
          throw new TypeError(
            `cannot write to readonly field '${e.obj.name}.${e.field}'`,
            e.line, 0,
          );
        }
        if (access === 'read' && f.access === 'writeonly') {
          throw new TypeError(
            `cannot read from writeonly field '${e.obj.name}.${e.field}'`,
            e.line, 0,
          );
        }
      }
    }
  }
  // Recurse into sub-expressions (all read accesses)
  switch (e.tag) {
    case 'unary':  checkExpr(e.rhs, 'read', hardware); break;
    case 'binary': checkExpr(e.lhs, 'read', hardware); checkExpr(e.rhs, 'read', hardware); break;
    case 'cast':   checkExpr(e.expr, 'read', hardware); break;
    case 'call':   e.args.forEach(a => checkExpr(a, 'read', hardware)); break;
    case 'index':  checkExpr(e.obj, 'read', hardware); checkExpr(e.idx, 'read', hardware); break;
    case 'lo': case 'hi': checkExpr(e.expr, 'read', hardware); break;
    case 'field':  if (e.obj.tag !== 'ident') checkExpr(e.obj, 'read', hardware); break;
  }
}

function checkStmts(
  stmts: readonly Stmt[],
  hardware: Map<string, HardwareDecl>,
  vars: Map<string, ResolvedVar>,
): void {
  for (const s of stmts) checkStmt(s, hardware, vars);
}

function checkStmt(
  s: Stmt,
  hardware: Map<string, HardwareDecl>,
  vars: Map<string, ResolvedVar>,
): void {
  switch (s.tag) {
    case 'assign':
      checkExpr(s.lhs, 'write', hardware);
      checkExpr(s.rhs, 'read', hardware);
      break;
    case 'varDecl':
      if (s.init) checkExpr(s.init, 'read', hardware);
      break;
    case 'exprStmt':
      checkExpr(s.expr, 'read', hardware);
      break;
    case 'return':
      if (s.value) checkExpr(s.value, 'read', hardware);
      break;
    case 'incDec':
      checkExpr(s.lhs, 'write', hardware);
      break;
    case 'if':
      checkExpr(s.cond, 'read', hardware);
      checkStmts(s.then, hardware, vars);
      s.elif.forEach(e => {
        checkExpr(e.cond, 'read', hardware);
        checkStmts(e.body, hardware, vars);
      });
      if (s.els) checkStmts(s.els, hardware, vars);
      break;
    case 'while':
      checkExpr(s.cond, 'read', hardware);
      checkStmts(s.body, hardware, vars);
      break;
    case 'loop':
      checkStmts(s.body, hardware, vars);
      break;
    case 'for':
      checkStmt(s.init, hardware, vars);
      checkExpr(s.cond, 'read', hardware);
      checkStmt(s.post, hardware, vars);
      checkStmts(s.body, hardware, vars);
      break;
  }
}
