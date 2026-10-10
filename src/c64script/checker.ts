import { TypeError } from './errors';
import { builtinDecls } from './builtin';
import { ZpAllocator } from './symbols';
import type { Program, Stmt, PsType, StructDecl, HardwareDecl, FnDecl } from './ast';
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

      if (vars.has(d.name)) throw new TypeError(`'${d.name}' already defined`, d.line, 0);
      vars.set(d.name, { type: d.type, zpAddr, absAddr, isConst: false, constValue: null });
    }

    if (d.tag === 'fn') {
      if (fns.has(d.name)) throw new TypeError(`function '${d.name}' already defined`, d.line, 0);
      fns.set(d.name, { decl: d, isInline: d.isInline });
    }

    if (d.tag === 'program') {
      loadAddr = d.address;
    }
  }

  // Pass 3: type-check statement bodies
  for (const d of allDecls) {
    if (d.tag === 'fn' || d.tag === 'program') {
      checkStmts(d.body, hardware, vars);
    }
  }

  return { program: userProg, loadAddr, vars, fns, structs, hardware, zpUsed: zp.used() };
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
  if (s.tag === 'assign') {
    const lhs = s.lhs;
    if (lhs.tag === 'field' && lhs.obj.tag === 'ident') {
      const hw = hardware.get(lhs.obj.name);
      if (hw) {
        const f = hw.fields.find(f => f.name === lhs.field);
        if (f?.access === 'readonly' || f?.access === 'read_to_clear') {
          throw new TypeError(
            `cannot write to readonly field '${lhs.obj.name}.${lhs.field}'`,
            lhs.line, 0,
          );
        }
      }
    }
  }

  if (s.tag === 'varDecl') {
    const rhs = s.init;
    if (rhs?.tag === 'field' && rhs.obj.tag === 'ident') {
      const hw = hardware.get(rhs.obj.name);
      if (hw) {
        const f = hw.fields.find(f => f.name === rhs.field);
        if (f?.access === 'writeonly') {
          throw new TypeError(
            `cannot read from writeonly field '${rhs.obj.name}.${rhs.field}'`,
            rhs.line, 0,
          );
        }
      }
    }
  }

  // Recurse into nested bodies
  if (s.tag === 'if') {
    checkStmts(s.then, hardware, vars);
    s.elif.forEach(e => checkStmts(e.body, hardware, vars));
    if (s.els) checkStmts(s.els, hardware, vars);
  }
  if (s.tag === 'while' || s.tag === 'loop') checkStmts(s.body, hardware, vars);
  if (s.tag === 'for') checkStmts(s.body, hardware, vars);
}
