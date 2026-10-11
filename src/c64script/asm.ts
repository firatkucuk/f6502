import { OPS } from '../core';
import type { Mode } from '../core';

// The assembler's encodings are derived from the CPU core's decode table, so the compiler and
// the emulator can never disagree about what an instruction is. Only official opcodes count.

const opcodes = new Map<string, number>(); // "LDA:imm" → opcode
const modesByMnemonic = new Map<string, Set<Mode>>(); // "LDA" → { imm, zp, … }
const undocumentedOnly = new Set<string>();

{
  const seenUndocumented = new Set<string>();
  OPS.forEach((info, opcode) => {
    if (!info.official) {
      seenUndocumented.add(info.mnemonic);
      return;
    }
    const key = `${info.mnemonic}:${info.mode}`;
    if (!opcodes.has(key)) opcodes.set(key, opcode);
    let modes = modesByMnemonic.get(info.mnemonic);
    if (!modes) modesByMnemonic.set(info.mnemonic, (modes = new Set()));
    modes.add(info.mode);
  });
  for (const m of seenUndocumented) if (!modesByMnemonic.has(m)) undocumentedOnly.add(m);
}

/** The shape of an operand as written, before its value decides zero page vs absolute. */
export type AsmShape = 'none' | 'acc' | 'imm' | 'addr' | 'addrx' | 'addry' | 'izx' | 'izy' | 'ind';

export type ModeChoice = { readonly mode: Mode } | { readonly error: string };

export function isMnemonic(m: string): boolean {
  return modesByMnemonic.has(m.toUpperCase());
}

export function takesOperand(m: string): boolean {
  const modes = modesByMnemonic.get(m.toUpperCase());
  if (!modes) return false;
  for (const mode of modes) if (mode !== 'imp') return true;
  return false;
}

export function opcodeFor(m: string, mode: Mode): number | undefined {
  return opcodes.get(`${m.toUpperCase()}:${mode}`);
}

function has(m: string, mode: Mode): boolean {
  return modesByMnemonic.get(m)?.has(mode) ?? false;
}

/**
 * Picks the addressing mode for `m` given how the operand was written and its value.
 * `value` is null for a label or function address (unknown until link time, always 16-bit).
 */
export function chooseMode(mnemonic: string, shape: AsmShape, value: number | null): ModeChoice {
  const m = mnemonic.toUpperCase();
  if (!modesByMnemonic.has(m)) {
    return {
      error: undocumentedOnly.has(m)
        ? `'${m}' is an undocumented instruction and is not supported`
        : `unknown instruction '${mnemonic}'`,
    };
  }
  const unsupported = { error: `'${m}' does not support this addressing mode` };
  if (value !== null && (value < 0 || value > 0xffff)) {
    return { error: `address ${value} is out of range 0..65535` };
  }

  switch (shape) {
    case 'none':
      if (has(m, 'imp')) return { mode: 'imp' };
      if (has(m, 'acc')) return { mode: 'acc' };
      return { error: `'${m}' needs an operand` };
    case 'acc':
      return has(m, 'acc') ? { mode: 'acc' } : unsupported;
    case 'imm':
      if (!has(m, 'imm')) return unsupported;
      if (value !== null && value > 0xff) {
        return { error: `immediate value ${value} is out of range 0..255` };
      }
      return { mode: 'imm' };
    case 'addr':
      if (has(m, 'rel')) return { mode: 'rel' };
      return pickAddress(m, 'zp', 'abs', value, unsupported);
    case 'addrx':
      return pickAddress(m, 'zpx', 'abx', value, unsupported);
    case 'addry':
      return pickAddress(m, 'zpy', 'aby', value, unsupported);
    case 'izx':
    case 'izy': {
      if (!has(m, shape)) return unsupported;
      if (value !== null && value > 0xff) {
        return {
          error: `'${m}' needs a zero-page address, but ${value} does not fit in zero page`,
        };
      }
      return { mode: shape };
    }
    case 'ind':
      return has(m, 'ind') ? { mode: 'ind' } : unsupported;
  }
}

function pickAddress(
  m: string,
  zp: Mode,
  abs: Mode,
  value: number | null,
  unsupported: { readonly error: string },
): ModeChoice {
  const zeroPage = value !== null && value <= 0xff;
  if (zeroPage && has(m, zp)) return { mode: zp };
  if (has(m, abs)) return { mode: abs };
  if (has(m, zp)) {
    return { error: `'${m}' only has a zero-page form, but the address does not fit in zero page` };
  }
  return unsupported;
}
