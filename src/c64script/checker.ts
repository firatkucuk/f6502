import { TypeError } from './errors';
import { COLOR_NAMES, builtinDecls } from './builtin';
import { ZpAllocator } from './symbols';
import type {
  Program,
  Stmt,
  Expr,
  PsType,
  StructDecl,
  HardwareDecl,
  FnDecl,
  VarDecl,
  AsmExpr,
  DataDecl,
  ProgramDecl,
} from './ast';
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
  /** Resolved address of every `data @addr(…)` block. */
  readonly dataAddrs: ReadonlyMap<DataDecl, number>;
}

/** Scope name of the `program { … }` block; functions use their own name. */
export const PROGRAM_SCOPE = 'program';

export function scopedName(scope: string, name: string): string {
  return `${scope}::${name}`;
}

/** Built-in functions and how many arguments they take. */
const BUILTIN_FNS: ReadonlyMap<string, readonly [min: number, max: number]> = new Map([
  ['poke', [2, 2]],
  ['clrscr', [0, 0]],
  ['screen', [2, 2]],
  ['color', [2, 2]],
  ['spritePtr', [1, 1]],
  ['puts', [3, 4]],
]);

/** Register names accepted by `asm clobbers(…)`. */
const CLOBBERABLE = new Set(['a', 'x', 'y', 'flags']);

/** Text screen geometry, for screen(row, col) and color(row, col). */
const SCREEN_RAM = 0x0400;
const COLOR_RAM = 0xd800;
const SCREEN_ROWS = 25;
const SCREEN_COLS = 40;

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
    case 'call': {
      if (e.name === 'spritePtr') {
        const a = e.args[0] !== undefined ? foldConst(e.args[0], lookup) : null;
        if (a === null) return null;
        if (a % 64 !== 0) {
          throw new TypeError(
            `spritePtr(): address ${a} is not a multiple of 64 (sprite data sits on 64-byte boundaries)`,
            e.line,
            0,
          );
        }
        if (a >= 0x4000) {
          throw new TypeError(
            `spritePtr(): address ${a} is outside the VIC-II's 16 KB bank 0 (0..16383)`,
            e.line,
            0,
          );
        }
        return a / 64;
      }
      if (e.name !== 'screen' && e.name !== 'color') return null;
      const row = e.args[0] !== undefined ? foldConst(e.args[0], lookup) : null;
      const col = e.args[1] !== undefined ? foldConst(e.args[1], lookup) : null;
      if (row === null || col === null) return null;
      if (row >= SCREEN_ROWS) {
        throw new TypeError(
          `${e.name}(): row ${row} is out of range 0..${SCREEN_ROWS - 1}`,
          e.line,
          0,
        );
      }
      if (col >= SCREEN_COLS) {
        throw new TypeError(
          `${e.name}(): column ${col} is out of range 0..${SCREEN_COLS - 1}`,
          e.line,
          0,
        );
      }
      return (e.name === 'screen' ? SCREEN_RAM : COLOR_RAM) + row * SCREEN_COLS + col;
    }
    case 'binary': {
      const l = foldConst(e.lhs, lookup);
      const r = foldConst(e.rhs, lookup);
      if (l === null || r === null) return null;
      switch (e.op) {
        case '+':
          return (l + r) & 0xffff;
        case '-':
          return (l - r) & 0xffff;
        case '*':
          return (l * r) & 0xffff;
        case '&':
          return l & r;
        case '|':
          return l | r;
        case '^':
          return l ^ r;
        case '<<':
          return (l << r) & 0xffff;
        case '>>':
          return l >> r;
        default:
          return null;
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
  let hasProgramDecl = false;
  let programDecl: ProgramDecl | null = null;

  const resolveVar = (scope: string | null, name: string): ResolvedVar | undefined =>
    (scope !== null ? vars.get(scopedName(scope, name)) : undefined) ?? vars.get(name);

  // Pass 1: structs and hardware blocks
  for (const d of allDecls) {
    if (d.tag === 'struct') structs.set(d.name, d);
    if (d.tag === 'hardware') hardware.set(d.name, d);
  }

  // Names declared in the blocks currently being checked (innermost last). A name may be
  // reused in a sibling block (it shares one slot); it may not repeat inside its own block or
  // shadow one from an enclosing block or a global.
  const blockNames: Set<string>[] = [];

  /** Registers a variable (global when `scope` is null, otherwise local to that scope). */
  function declare(d: VarDecl, scope: string | null): void {
    const key = scope === null ? d.name : scopedName(scope, d.name);
    if (scope !== null && fns.has(d.name)) {
      throw new TypeError(`'${d.name}' is already defined as a function`, d.line, 0);
    }
    const lookup = (n: string) => resolveVar(scope, n);
    const ann = d.annotation;
    const isInt = d.type.tag === 'u8' || d.type.tag === 'bool';
    const fits = (v: number): void => {
      if (isInt && v > 0xff) {
        throw new TypeError(`value ${v} does not fit in ${d.type.tag}`, d.line, 0);
      }
    };

    if (scope !== null) {
      if (vars.has(d.name) || blockNames.some((names) => names.has(d.name))) {
        throw new TypeError(`'${d.name}' already defined`, d.line, 0);
      }
      const sibling = vars.get(key);
      if (sibling !== undefined) {
        // Declared before in another block of this function: share the slot.
        if (sibling.type.tag !== d.type.tag) {
          throw new TypeError(
            `'${d.name}' was declared with a different type (${sibling.type.tag}) elsewhere in this function`,
            d.line,
            0,
          );
        }
        blockNames[blockNames.length - 1]?.add(d.name);
        if (d.init !== null) {
          const v = foldConst(d.init, lookup);
          if (v !== null) fits(v);
        }
        return;
      }
    } else if (vars.has(key)) {
      throw new TypeError(`'${d.name}' already defined`, d.line, 0);
    }

    if (d.isConst && ann.kind !== 'none') {
      throw new TypeError(
        `a const cannot have a ${ann.kind === 'zp' ? '@zp' : '@addr'} annotation (use let)`,
        d.line,
        0,
      );
    }

    let zpAddr: number | null = null;
    let absAddr: number | null = null;
    let isConst = false;
    let constValue: number | null = null;
    let initValue: number | null = null;

    if (d.isConst) {
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
      fits(v);
      isConst = true;
      constValue = isInt ? v & 0xff : v & 0xffff;
    } else {
      if (ann.kind === 'addr') {
        const a = foldConst(ann.address, lookup);
        if (a === null) {
          throw new TypeError(
            '@addr(...) must be a compile-time constant (a const declared above this line)',
            d.line,
            0,
          );
        }
        if (a > 0xffff) {
          throw new TypeError(`address ${a} is out of range 0..65535`, d.line, 0);
        }
        absAddr = a;
      } else zpAddr = zp.alloc(sizeOf(d.type, structs), d.line);
      if (d.init !== null) {
        const v = foldConst(d.init, lookup);
        if (v !== null) {
          fits(v);
          initValue = v;
        } else if (scope === null) {
          throw new TypeError(
            `initialiser of '${d.name}' must be a compile-time constant`,
            d.line,
            0,
          );
        }
      }
    }
    if (scope !== null) blockNames[blockNames.length - 1]?.add(d.name);
    vars.set(key, {
      type: d.type,
      zpAddr,
      absAddr,
      isConst,
      constValue,
      initValue,
      isGlobal: scope === null,
    });
  }

  // Pass 2: globals, function signatures, the program block
  // A name is either a variable or a function: `${f}` and `f` would otherwise disagree.
  for (const d of allDecls) {
    if (d.tag === 'varDecl') {
      if (fns.has(d.name)) {
        throw new TypeError(`'${d.name}' is already defined as a function`, d.line, 0);
      }
      declare(d, null);
    }

    if (d.tag === 'fn') {
      if (vars.has(d.name)) {
        throw new TypeError(`'${d.name}' is already defined as a variable`, d.line, 0);
      }
      if (fns.has(d.name) || BUILTIN_FNS.has(d.name)) {
        throw new TypeError(`function '${d.name}' already defined`, d.line, 0);
      }
      if (d.ret.tag === 'u16') {
        throw new TypeError(
          `u16 return values are not supported yet (function '${d.name}')`,
          d.line,
          0,
        );
      }
      fns.set(d.name, { decl: d, isInline: d.isInline });
    }

    if (d.tag === 'program') {
      if (hasProgramDecl) {
        throw new TypeError('only one program block is allowed', d.line, 0);
      }
      programDecl = d;
      hasProgramDecl = true;
    }
  }

  if (!hasProgramDecl || programDecl === null) {
    throw new TypeError('program block is required', 0, 0);
  }

  // Addresses are folded once every global is known, so a `const` may sit below `program @ …`.
  const globalLookup = (n: string) => vars.get(n);
  const programAddr = foldConst(programDecl.address, globalLookup);
  if (programAddr === null) {
    throw new TypeError('program address must be a compile-time constant', programDecl.line, 0);
  }
  if (programAddr > 0xffff) {
    throw new TypeError(
      `program address ${programAddr} is out of range 0..65535`,
      programDecl.line,
      0,
    );
  }
  const loadAddr = programAddr;

  const dataAddrs = new Map<DataDecl, number>();
  for (const d of allDecls) {
    if (d.tag !== 'data' || d.annotation.kind !== 'addr') continue;
    const a = foldConst(d.annotation.address, globalLookup);
    if (a === null) {
      throw new TypeError('@addr(...) must be a compile-time constant', d.line, 0);
    }
    if (a > 0xffff) {
      throw new TypeError(`address ${a} is out of range 0..65535`, d.line, 0);
    }
    dataAddrs.set(d, a);
  }

  // Pass 3: parameters, locals, name resolution
  const calls = new Map<string, Array<{ to: string; line: number }>>();
  // Calls made while evaluating another call's arguments, for the slot-aliasing check below.
  const argCalls: Array<{ callee: string; inner: string; line: number }> = [];

  for (const d of allDecls) {
    if (d.tag === 'fn') {
      blockNames.length = 0;
      blockNames.push(new Set());
      for (const p of d.params) {
        if (p.type.tag !== 'u8' && p.type.tag !== 'bool') {
          throw new TypeError(
            `${p.type.tag} parameter '${p.name}' is not supported yet (only u8 and bool)`,
            d.line,
            0,
          );
        }
        declare(
          {
            tag: 'varDecl',
            name: p.name,
            type: p.type,
            annotation: { kind: 'none' },
            isConst: false,
            init: null,
            line: d.line,
          },
          d.name,
        );
      }
      calls.set(d.name, []);
      checkStmts(d.body, d.name, 0);
    } else if (d.tag === 'program') {
      blockNames.length = 0;
      blockNames.push(new Set());
      calls.set(PROGRAM_SCOPE, []);
      checkStmts(d.body, PROGRAM_SCOPE, 0);
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

  // Arguments are stored into the callee's slots one by one. If evaluating a later argument
  // runs a function that calls the same callee, it would overwrite the slots already filled.
  const reaches = (from: string, target: string, seen = new Set<string>()): boolean => {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (calls.get(from) ?? []).some((edge) => reaches(edge.to, target, seen));
  };
  for (const c of argCalls) {
    if (reaches(c.inner, c.callee)) {
      throw new TypeError(
        `argument of '${c.callee}' calls '${c.inner}', which calls '${c.callee}' again; ` +
          'the parameter slots are shared, so assign the result to a variable first',
        c.line,
        0,
      );
    }
  }

  return {
    program: userProg,
    loadAddr,
    vars,
    fns,
    structs,
    hardware,
    zpUsed: zp.used(),
    dataAddrs,
  };

  // ─── statement / expression walk ─────────────────────────────────────

  function checkStmts(stmts: readonly Stmt[], scope: string, loops: number): void {
    for (const s of stmts) checkStmt(s, scope, loops);
  }

  /** Checks a nested block: names declared inside it are released when it ends. */
  function checkBlock(stmts: readonly Stmt[], scope: string, loops: number): void {
    blockNames.push(new Set());
    checkStmts(stmts, scope, loops);
    blockNames.pop();
  }

  function checkStmt(s: Stmt, scope: string, loops: number): void {
    const expr = (e: Expr, access: 'read' | 'write' = 'read') => checkExpr(e, access, scope, null);
    switch (s.tag) {
      case 'assign':
        if (s.op !== '=') expr(s.lhs, 'read'); // `x += 1` reads x first
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
        expr(s.lhs, 'read');
        expr(s.lhs, 'write');
        break;
      case 'if':
        expr(s.cond);
        checkBlock(s.then, scope, loops);
        for (const e of s.elif) {
          expr(e.cond);
          checkBlock(e.body, scope, loops);
        }
        if (s.els) checkBlock(s.els, scope, loops);
        break;
      case 'while':
        expr(s.cond);
        checkBlock(s.body, scope, loops + 1);
        break;
      case 'loop':
        checkBlock(s.body, scope, loops + 1);
        break;
      case 'for':
        // The header's variable lives in the loop's own block.
        blockNames.push(new Set());
        checkStmt(s.init, scope, loops);
        expr(s.cond);
        checkStmt(s.post, scope, loops + 1);
        checkStmts(s.body, scope, loops + 1);
        blockNames.pop();
        break;
      case 'break':
      case 'continue':
        if (loops === 0) {
          throw new TypeError(`'${s.tag}' outside of a loop`, s.line, 0);
        }
        break;
      case 'asm':
        checkAsm(s, scope);
        break;
      default:
        break;
    }
  }

  /** clobbers() names are validated; `${…}` operands are resolved like any expression. */
  function checkAsm(s: Extract<Stmt, { tag: 'asm' }>, scope: string): void {
    for (const name of s.clobbers) {
      if (!CLOBBERABLE.has(name.toLowerCase())) {
        throw new TypeError(
          `unknown register '${name}' in clobbers() (use A, X, Y or flags)`,
          s.line,
          0,
        );
      }
    }
    const visit = (e: AsmExpr, transfersControl: boolean): void => {
      switch (e.tag) {
        case 'sym': {
          const ex = e.expr;
          if (ex.tag === 'ident' && fns.has(ex.name)) {
            // Only jsr/jmp run the function; `lda #lo(${f})` just takes its address.
            if (transfersControl) calls.get(scope)?.push({ to: ex.name, line: e.line });
            return;
          }
          checkExpr(ex, 'read', scope, null);
          return;
        }
        case 'lo':
        case 'hi':
          visit(e.arg, false);
          return;
        case 'add':
          visit(e.lhs, transfersControl);
          return;
        default:
          return;
      }
    };
    for (const item of s.items) {
      if (item.kind === 'instr' && 'value' in item.operand) {
        visit(item.operand.value, item.mnemonic === 'JSR' || item.mnemonic === 'JMP');
      }
    }
  }

  /** puts(row, col, "TEXT" [, colour]): the text and its place are checked at compile time. */
  function checkPuts(e: Extract<Expr, { tag: 'call' }>, scope: string): void {
    const [rowE, colE, textE, colourE] = e.args;
    if (textE === undefined || textE.tag !== 'strLit') {
      throw new TypeError('puts(): the third argument must be a string literal', e.line, 0);
    }
    for (const a of [rowE, colE, colourE]) {
      if (a !== undefined) checkExpr(a, 'read', scope, null);
    }
    const lookup = (n: string) => resolveVar(scope, n);
    const row = rowE !== undefined ? foldConst(rowE, lookup) : null;
    const col = colE !== undefined ? foldConst(colE, lookup) : null;
    if (row !== null && row >= SCREEN_ROWS) {
      throw new TypeError(`puts(): row ${row} is out of range 0..${SCREEN_ROWS - 1}`, e.line, 0);
    }
    if (col !== null && col + textE.codes.length > SCREEN_COLS) {
      throw new TypeError(
        col >= SCREEN_COLS
          ? `puts(): column ${col} is out of range 0..${SCREEN_COLS - 1}`
          : `puts(): ${textE.codes.length} characters starting at column ${col} run past column ${SCREEN_COLS - 1}`,
        e.line,
        0,
      );
    }
    const colour = colourE !== undefined ? foldConst(colourE, lookup) : null;
    if (colour !== null && colour > 15) {
      throw new TypeError(
        `puts(): colour ${colour} is out of range 0..15 (use COLOR_*)`,
        e.line,
        0,
      );
    }
  }

  /** `parent` is the call whose argument list contains `e`, when there is one. */
  function checkExpr(
    e: Expr,
    access: 'read' | 'write',
    scope: string,
    parent: string | null,
  ): void {
    switch (e.tag) {
      case 'ident': {
        const v = resolveVar(scope, e.name);
        if (v === undefined) {
          const hint = (COLOR_NAMES as readonly string[]).includes(e.name)
            ? ` (colour names start with COLOR_: did you mean COLOR_${e.name}?)`
            : '';
          throw new TypeError(`undefined variable '${e.name}'${hint}`, e.line, 0);
        }
        if (access === 'write' && v.isConst) {
          throw new TypeError(`cannot assign to constant '${e.name}'`, e.line, 0);
        }
        break;
      }
      case 'field': {
        if (e.obj.tag !== 'ident') {
          checkExpr(e.obj, 'read', scope, parent);
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
            throw new TypeError(
              `cannot write to readonly field '${e.obj.name}.${e.field}'`,
              e.line,
              0,
            );
          }
          if (access === 'read' && f.access === 'writeonly') {
            throw new TypeError(
              `cannot read from writeonly field '${e.obj.name}.${e.field}'`,
              e.line,
              0,
            );
          }
        }
        break;
      }
      case 'call': {
        const fn = fns.get(e.name);
        const range =
          fn !== undefined
            ? ([fn.decl.params.length, fn.decl.params.length] as const)
            : BUILTIN_FNS.get(e.name);
        if (range === undefined) {
          throw new TypeError(`undefined function '${e.name}'`, e.line, 0);
        }
        const [min, max] = range;
        if (e.args.length < min || e.args.length > max) {
          const expected =
            min === max ? `${min} argument${min === 1 ? '' : 's'}` : `${min} or ${max} arguments`;
          throw new TypeError(
            `function '${e.name}' expects ${expected}, got ${e.args.length}`,
            e.line,
            0,
          );
        }
        if (e.name === 'puts' && fn === undefined) {
          checkPuts(e, scope);
          break;
        }
        if (fn !== undefined) {
          calls.get(scope)?.push({ to: e.name, line: e.line });
          if (parent !== null) argCalls.push({ callee: parent, inner: e.name, line: e.line });
        }
        for (const a of e.args) checkExpr(a, 'read', scope, fn !== undefined ? e.name : parent);
        break;
      }
      case 'strLit':
        throw new TypeError(
          'string literals are only allowed as the third argument of puts()',
          e.line,
          0,
        );
      case 'unary':
        checkExpr(e.rhs, 'read', scope, parent);
        break;
      case 'binary':
        checkExpr(e.lhs, 'read', scope, parent);
        checkExpr(e.rhs, 'read', scope, parent);
        break;
      case 'cast':
      case 'lo':
      case 'hi':
        checkExpr(e.expr, 'read', scope, parent);
        break;
      case 'index':
        checkExpr(e.obj, 'read', scope, parent);
        checkExpr(e.idx, 'read', scope, parent);
        break;
      default:
        break; // literals
    }
  }
}
