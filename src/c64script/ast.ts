// ── Types ──────────────────────────────────────────────────────────────
export type PsType =
  | { readonly tag: 'u8' }
  | { readonly tag: 'u16' }
  | { readonly tag: 'bool' }
  | { readonly tag: 'void' }
  | { readonly tag: 'ptr'; readonly elem: PsType }
  | { readonly tag: 'array'; readonly elem: PsType; readonly size: number }
  | { readonly tag: 'struct'; readonly name: string }
  | { readonly tag: 'hardware'; readonly name: string };

export const U8: PsType = { tag: 'u8' };
export const U16: PsType = { tag: 'u16' };
export const BOOL: PsType = { tag: 'bool' };
export const VOID: PsType = { tag: 'void' };

export function sizeOf(t: PsType, structs: ReadonlyMap<string, StructDecl>): number {
  switch (t.tag) {
    case 'u8':
    case 'bool':
      return 1;
    case 'u16':
    case 'ptr':
      return 2;
    case 'void':
      return 0;
    case 'array':
      return t.size * sizeOf(t.elem, structs);
    case 'struct': {
      const s = structs.get(t.name);
      if (!s) throw new Error(`unknown struct ${t.name}`);
      return s.fields.reduce((acc, f) => acc + sizeOf(f.type, structs), 0);
    }
    case 'hardware':
      return 0;
  }
}

// ── Annotations ────────────────────────────────────────────────────────
export type VarAnnotation =
  | { readonly tag: 'none' }
  | { readonly tag: 'zp' }
  | { readonly tag: 'addr'; readonly address: Expr };

// ── Hardware fields ────────────────────────────────────────────────────
export type HardwareFieldAccess = 'rw' | 'readonly' | 'writeonly' | 'read_to_clear';

export interface HardwareField {
  readonly name: string;
  readonly type: PsType;
  readonly offset: number;
  readonly access: HardwareFieldAccess;
}

// ── Expressions ────────────────────────────────────────────────────────
export type Expr =
  | { readonly tag: 'intLit'; readonly value: number; readonly line: number }
  | { readonly tag: 'strLit'; readonly codes: readonly number[]; readonly line: number }
  | { readonly tag: 'boolLit'; readonly value: boolean; readonly line: number }
  | { readonly tag: 'ident'; readonly name: string; readonly line: number }
  | { readonly tag: 'field'; readonly obj: Expr; readonly field: string; readonly line: number }
  | { readonly tag: 'index'; readonly obj: Expr; readonly idx: Expr; readonly line: number }
  | { readonly tag: 'unary'; readonly op: string; readonly rhs: Expr; readonly line: number }
  | {
      readonly tag: 'binary';
      readonly op: string;
      readonly lhs: Expr;
      readonly rhs: Expr;
      readonly line: number;
    }
  | { readonly tag: 'cast'; readonly expr: Expr; readonly toType: PsType; readonly line: number }
  | {
      readonly tag: 'call';
      readonly name: string;
      readonly args: readonly Expr[];
      readonly line: number;
    }
  | { readonly tag: 'lo'; readonly expr: Expr; readonly line: number }
  | { readonly tag: 'hi'; readonly expr: Expr; readonly line: number };

// ── Inline asm ─────────────────────────────────────────────────────────
export type AsmExpr =
  | { readonly tag: 'num'; readonly value: number; readonly line: number }
  | { readonly tag: 'sym'; readonly expr: Expr; readonly line: number } // ${…}
  | { readonly tag: 'label'; readonly name: string; readonly line: number }
  | { readonly tag: 'lo' | 'hi'; readonly arg: AsmExpr; readonly line: number }
  | { readonly tag: 'add'; readonly lhs: AsmExpr; readonly offset: number; readonly line: number };

export type AsmOperand =
  | { readonly tag: 'none' }
  | { readonly tag: 'acc' }
  | { readonly tag: 'imm'; readonly value: AsmExpr }
  | { readonly tag: 'addr'; readonly value: AsmExpr; readonly index: 'x' | 'y' | null }
  | { readonly tag: 'izx'; readonly value: AsmExpr }
  | { readonly tag: 'izy'; readonly value: AsmExpr }
  | { readonly tag: 'ind'; readonly value: AsmExpr };

export type AsmItem =
  | { readonly tag: 'label'; readonly name: string; readonly line: number }
  | {
      readonly tag: 'instr';
      /** Upper-case mnemonic. */
      readonly mnemonic: string;
      readonly operand: AsmOperand;
      readonly line: number;
    };

// ── Statements ─────────────────────────────────────────────────────────
export type Stmt =
  | {
      readonly tag: 'varDecl';
      readonly name: string;
      readonly type: PsType;
      readonly annotation: VarAnnotation;
      readonly isConst: boolean;
      readonly init: Expr | null;
      readonly line: number;
    }
  | {
      readonly tag: 'assign';
      readonly lhs: Expr;
      readonly op: string;
      readonly rhs: Expr;
      readonly line: number;
    }
  | { readonly tag: 'incDec'; readonly lhs: Expr; readonly op: '++' | '--'; readonly line: number }
  | { readonly tag: 'exprStmt'; readonly expr: Expr; readonly line: number }
  | { readonly tag: 'return'; readonly value: Expr | null; readonly line: number }
  | {
      readonly tag: 'if';
      readonly cond: Expr;
      readonly then: readonly Stmt[];
      readonly elif: ReadonlyArray<{ readonly cond: Expr; readonly body: readonly Stmt[] }>;
      readonly els: readonly Stmt[] | null;
      readonly line: number;
    }
  | {
      readonly tag: 'while';
      readonly cond: Expr;
      readonly body: readonly Stmt[];
      readonly line: number;
    }
  | {
      readonly tag: 'for';
      readonly init: Stmt;
      readonly cond: Expr;
      readonly post: Stmt;
      readonly body: readonly Stmt[];
      readonly line: number;
    }
  | { readonly tag: 'loop'; readonly body: readonly Stmt[]; readonly line: number }
  | { readonly tag: 'break'; readonly line: number }
  | { readonly tag: 'continue'; readonly line: number }
  | {
      readonly tag: 'asm';
      readonly clobbers: readonly string[];
      readonly items: readonly AsmItem[];
      readonly line: number;
    };

// ── Top-level declarations ─────────────────────────────────────────────
export interface StructDecl {
  readonly tag: 'struct';
  readonly name: string;
  readonly fields: ReadonlyArray<{ readonly name: string; readonly type: PsType }>;
  readonly line: number;
}

export interface HardwareDecl {
  readonly tag: 'hardware';
  readonly name: string;
  readonly base: number;
  readonly fields: readonly HardwareField[];
  readonly line: number;
}

export interface VarDecl {
  readonly tag: 'varDecl';
  readonly name: string;
  readonly type: PsType;
  readonly annotation: VarAnnotation;
  /** Declared with `const`: a compile-time constant, never stored in memory. */
  readonly isConst: boolean;
  readonly init: Expr | null;
  readonly line: number;
}

export interface FnDecl {
  readonly tag: 'fn';
  readonly name: string;
  readonly params: ReadonlyArray<{ readonly name: string; readonly type: PsType }>;
  readonly ret: PsType;
  readonly body: readonly Stmt[];
  readonly isInline: boolean;
  readonly line: number;
}

export interface DataDecl {
  readonly tag: 'data';
  readonly annotation: VarAnnotation;
  readonly fields: ReadonlyArray<{
    readonly name: string;
    readonly type: PsType;
    readonly init: readonly Expr[];
  }>;
  readonly line: number;
}

export interface ProgramDecl {
  readonly tag: 'program';
  /** A constant expression; folded to a number by the checker. */
  readonly address: Expr;
  readonly body: readonly Stmt[];
  readonly line: number;
}

export type Decl = StructDecl | HardwareDecl | VarDecl | FnDecl | DataDecl | ProgramDecl;

export interface Program {
  readonly decls: readonly Decl[];
}
