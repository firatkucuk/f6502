import { describe, expect, it } from 'vitest';
import { OPS } from '../../src/core/opcodes';

describe('opcode table', () => {
  it('defines all 256 opcodes', () => {
    expect(OPS).toHaveLength(256);
    for (const op of OPS) expect(op).toBeDefined();
  });

  it('has 151 official opcodes and 12 JAMs', () => {
    expect(OPS.filter((o) => o.official)).toHaveLength(151);
    const jams = OPS.map((o, i) => (o.kind === 'jam' ? i : -1)).filter((i) => i >= 0);
    expect(jams).toEqual([0x02, 0x12, 0x22, 0x32, 0x42, 0x52, 0x62, 0x72, 0x92, 0xb2, 0xd2, 0xf2]);
  });

  it.each([
    [0xa9, 'LDA', 'imm', 'read', true],
    [0x8d, 'STA', 'abs', 'write', true],
    [0xbd, 'LDA', 'abx', 'read', true],
    [0x1e, 'ASL', 'abx', 'rmw', true],
    [0x0a, 'ASL', 'acc', 'implied', true],
    [0x6c, 'JMP', 'ind', 'flow', true],
    [0xd0, 'BNE', 'rel', 'branch', true],
    [0xea, 'NOP', 'imp', 'implied', true],
    [0x1a, 'NOP', 'imp', 'implied', false],
    [0x0c, 'NOP', 'abs', 'read', false],
    [0xeb, 'SBC', 'imm', 'read', false],
    [0xa7, 'LAX', 'zp', 'read', false],
    [0xc7, 'DCP', 'zp', 'rmw', false],
    [0x9b, 'TAS', 'aby', 'write', false],
  ] as const)('opcode %i is %s %s (%s, official=%s)', (code, mnemonic, mode, kind, official) => {
    expect(OPS[code]).toEqual({ mnemonic, mode, kind, official });
  });
});
