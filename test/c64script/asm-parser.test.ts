import { describe, expect, it } from 'vitest';
import { tokenize } from '../../src/c64script/lexer';
import { parse } from '../../src/c64script/parser';
import type { AsmItem, Stmt } from '../../src/c64script/ast';
import { ParseError } from '../../src/c64script/errors';

function items(block: string): AsmItem[] {
  const prog = parse(tokenize(`program @ 0x0810 {\n${block}\n}`));
  const decl = prog.decls.find((d) => d.tag === 'program');
  const stmt = (decl as { body: readonly Stmt[] }).body[0]!;
  if (stmt.tag !== 'asm') throw new Error('not an asm block');
  return [...stmt.items];
}

const instr = (it: AsmItem) => (it.kind === 'instr' ? it : (undefined as never));

describe('asm parser', () => {
  it('parses one instruction per line, upper-casing the mnemonic', () => {
    const r = items('asm {\n  sei\n  lda #5\n  sta $D011\n}');
    expect(r.map((i) => (i.kind === 'instr' ? i.mnemonic : i.name))).toEqual(['SEI', 'LDA', 'STA']);
    expect(instr(r[1]!).operand).toMatchObject({ kind: 'imm', value: { tag: 'num', value: 5 } });
    expect(instr(r[2]!).operand).toMatchObject({
      kind: 'addr',
      index: null,
      value: { tag: 'num', value: 0xd011 },
    });
    // line 1 is the program wrapper, line 2 is `asm {`
    expect(r.map((i) => i.line)).toEqual([3, 4, 5]);
  });

  it('accepts C64Script keywords as labels (loop:, for:)', () => {
    const r = items('asm {\nloop:\n  dex\n  bne loop\n}');
    expect(r[0]).toMatchObject({ kind: 'label', name: 'loop' });
    expect(instr(r[2]!).operand).toMatchObject({ value: { tag: 'label', name: 'loop' } });
  });

  it('parses labels, including one on the same line as an instruction', () => {
    const r = items('asm {\nloop:\n  dex\nagain: bne loop\n}');
    expect(r.map((i) => i.kind)).toEqual(['label', 'instr', 'label', 'instr']);
    expect(r[0]).toMatchObject({ kind: 'label', name: 'loop' });
    expect(instr(r[3]!).operand).toMatchObject({
      kind: 'addr',
      value: { tag: 'label', name: 'loop' },
    });
  });

  it('parses every operand form', () => {
    const r = items(
      'asm {\n  lda #1\n  lda $10\n  lda $10,x\n  lda $10,y\n  lda ($10,x)\n  lda ($10),y\n  jmp ($1234)\n  asl a\n  asl\n  nop\n}',
    );
    expect(r.map((i) => instr(i).operand.kind)).toEqual([
      'imm',
      'addr',
      'addr',
      'addr',
      'izx',
      'izy',
      'ind',
      'acc',
      'none',
      'none',
    ]);
    expect(instr(r[2]!).operand).toMatchObject({ index: 'x' });
    expect(instr(r[3]!).operand).toMatchObject({ index: 'y' });
  });

  it('parses ${expr}, lo()/hi() and offsets', () => {
    const r = items(
      'asm {\n  lda ${count}\n  lda #lo(${T})\n  sta ${buf} + 1\n  lda #hi(${T} - 2)\n}',
    );
    expect(instr(r[0]!).operand).toMatchObject({
      value: { tag: 'sym', expr: { tag: 'ident', name: 'count' } },
    });
    expect(instr(r[1]!).operand).toMatchObject({
      kind: 'imm',
      value: { tag: 'lo', arg: { tag: 'sym' } },
    });
    expect(instr(r[2]!).operand).toMatchObject({
      value: { tag: 'add', offset: 1, lhs: { tag: 'sym' } },
    });
    expect(instr(r[3]!).operand).toMatchObject({
      value: { tag: 'hi', arg: { tag: 'add', offset: -2 } },
    });
  });

  it('parses ${screen(1, 2)} as an expression', () => {
    const r = items('asm {\n  sta ${screen(1, 2)},x\n}');
    expect(instr(r[0]!).operand).toMatchObject({
      kind: 'addr',
      index: 'x',
      value: { tag: 'sym', expr: { tag: 'call', name: 'screen' } },
    });
  });

  it('parses character literals', () => {
    const r = items("asm {\n  lda #'H'\n}");
    expect(instr(r[0]!).operand).toMatchObject({ kind: 'imm', value: { tag: 'num', value: 8 } });
  });

  it('separates instructions written on one line', () => {
    const r = items('asm { lda #5 sta $D020 }');
    expect(r.map((i) => instr(i).mnemonic)).toEqual(['LDA', 'STA']);
  });

  it('an implied instruction does not swallow the next instruction as its operand', () => {
    const r = items('asm {\nloop: dex bpl loop\n}');
    expect(r.map((i) => (i.kind === 'instr' ? i.mnemonic : 'label'))).toEqual([
      'label',
      'DEX',
      'BPL',
    ]);
    expect(instr(r[1]!).operand.kind).toBe('none');
  });

  it('keeps the clobbers list', () => {
    const prog = parse(tokenize('program @ 0x0810 { asm clobbers(A, X, flags) { nop } }'));
    const decl = prog.decls.find((d) => d.tag === 'program') as { body: readonly Stmt[] };
    expect(decl.body[0]).toMatchObject({ tag: 'asm', clobbers: ['A', 'X', 'flags'] });
  });

  it('rejects a label named like an instruction, at its line', () => {
    try {
      items('asm {\n  lda:\n}');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ParseError);
      expect((err as ParseError).message).toMatch(/'lda' is an instruction/);
      expect((err as ParseError).line).toBe(3);
    }
  });

  it('rejects a malformed operand', () => {
    expect(() => items('asm {\n  lda ($10,y)\n}')).toThrow(/expected 'x'/);
    expect(() => items('asm {\n  lda $10,z\n}')).toThrow(/expected x or y/);
    expect(() => items('asm {\n  lda #\n}')).toThrow(ParseError);
  });
});
