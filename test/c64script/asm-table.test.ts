import { describe, expect, it } from 'vitest';
import { OPS } from '../../src/core';
import type { Mode } from '../../src/core';
import { chooseMode, isMnemonic, opcodeFor, takesOperand } from '../../src/c64script/asm';
import type { AsmShape } from '../../src/c64script/asm';

const OFFICIAL = OPS.map((info, opcode) => ({ info, opcode })).filter((o) => o.info.official);

describe('asm opcode table', () => {
  it('covers the 151 official opcodes', () => {
    expect(OFFICIAL.length).toBe(151);
  });

  it('every official (mnemonic, mode) pair encodes to an opcode the core decodes back', () => {
    for (const { info } of OFFICIAL) {
      const opcode = opcodeFor(info.mnemonic, info.mode);
      expect(opcode, `${info.mnemonic} ${info.mode}`).toBeDefined();
      const back = OPS[opcode!]!;
      expect(back.mnemonic).toBe(info.mnemonic);
      expect(back.mode).toBe(info.mode);
      expect(back.official).toBe(true);
    }
  });

  it('knows official mnemonics in any case and rejects undocumented ones', () => {
    expect(isMnemonic('lda')).toBe(true);
    expect(isMnemonic('LDA')).toBe(true);
    expect(isMnemonic('lax')).toBe(false);
    expect(isMnemonic('jam')).toBe(false);
    expect(isMnemonic('frob')).toBe(false);
  });

  it('knows which instructions take an operand', () => {
    expect(takesOperand('LDA')).toBe(true);
    expect(takesOperand('BNE')).toBe(true);
    expect(takesOperand('ASL')).toBe(true); // accumulator or memory
    expect(takesOperand('DEX')).toBe(false);
    expect(takesOperand('NOP')).toBe(false);
  });
});

describe('chooseMode', () => {
  const pick = (m: string, shape: AsmShape, value: number | null): Mode | string => {
    const r = chooseMode(m, shape, value);
    return 'mode' in r ? r.mode : r.error;
  };

  it('uses zero page up to $FF and absolute from $100', () => {
    expect(pick('LDA', 'addr', 0xff)).toBe('zp');
    expect(pick('LDA', 'addr', 0x100)).toBe('abs');
    expect(pick('LDA', 'addrx', 0xff)).toBe('zpx');
    expect(pick('LDA', 'addrx', 0x100)).toBe('abx');
  });

  it('falls back to absolute,Y when there is no zero-page,Y form', () => {
    expect(pick('LDA', 'addry', 0x10)).toBe('aby');
    expect(pick('LDX', 'addry', 0x10)).toBe('zpy');
    expect(pick('STA', 'addry', 0x10)).toBe('aby');
  });

  it('labels and function addresses are absolute', () => {
    expect(pick('JMP', 'addr', null)).toBe('abs');
    expect(pick('JSR', 'addr', null)).toBe('abs');
    expect(pick('LDA', 'addrx', null)).toBe('abx');
  });

  it('branches take an address as a relative target', () => {
    expect(pick('BNE', 'addr', null)).toBe('rel');
    expect(pick('BPL', 'addr', null)).toBe('rel');
  });

  it('immediate must fit a byte', () => {
    expect(pick('LDA', 'imm', 255)).toBe('imm');
    expect(pick('LDA', 'imm', 256)).toMatch(/0\.\.255/);
    expect(pick('STA', 'imm', 1)).toMatch(/does not support/);
  });

  it('indirect forms need a zero-page address', () => {
    expect(pick('LDA', 'izx', 0x10)).toBe('izx');
    expect(pick('LDA', 'izy', 0x10)).toBe('izy');
    expect(pick('LDA', 'izy', 0x100)).toMatch(/zero page/);
    expect(pick('JMP', 'ind', 0x1234)).toBe('ind');
    expect(pick('LDA', 'ind', 0x1234)).toMatch(/does not support/);
  });

  it('accumulator and implied forms', () => {
    expect(pick('ASL', 'acc', null)).toBe('acc');
    expect(pick('ASL', 'none', null)).toBe('acc');
    expect(pick('DEX', 'none', null)).toBe('imp');
    expect(pick('LDA', 'none', null)).toMatch(/needs an operand/);
    expect(pick('LDA', 'acc', null)).toMatch(/does not support/);
  });

  it('a zero-page-only form with a value that does not fit is an error', () => {
    expect(pick('STX', 'addry', 0x1234)).toMatch(/zero page/);
  });

  it('values above $FFFF are rejected', () => {
    expect(pick('LDA', 'addr', 0x10000)).toMatch(/0\.\.65535/);
  });

  it('unknown and undocumented instructions are named', () => {
    expect(pick('FROB', 'none', null)).toMatch(/unknown instruction 'FROB'/);
    expect(pick('LAX', 'addr', 0x10)).toMatch(/undocumented/);
  });
});
