export type Mode =
  | 'imp'
  | 'acc'
  | 'imm'
  | 'zp'
  | 'zpx'
  | 'zpy'
  | 'abs'
  | 'abx'
  | 'aby'
  | 'izx'
  | 'izy'
  | 'rel'
  | 'ind';

export type OpKind = 'implied' | 'read' | 'write' | 'rmw' | 'branch' | 'flow' | 'jam';

export interface OpInfo {
  readonly mnemonic: string;
  readonly mode: Mode;
  readonly kind: OpKind;
  readonly official: boolean;
}

// One row per high nibble, 16 entries per row (low nibble 0..F).
// prettier-ignore
const TABLE = [
  'BRK imp|ORA izx|JAM imp|SLO izx|NOP zp|ORA zp|ASL zp|SLO zp|PHP imp|ORA imm|ASL acc|ANC imm|NOP abs|ORA abs|ASL abs|SLO abs',
  'BPL rel|ORA izy|JAM imp|SLO izy|NOP zpx|ORA zpx|ASL zpx|SLO zpx|CLC imp|ORA aby|NOP imp|SLO aby|NOP abx|ORA abx|ASL abx|SLO abx',
  'JSR abs|AND izx|JAM imp|RLA izx|BIT zp|AND zp|ROL zp|RLA zp|PLP imp|AND imm|ROL acc|ANC imm|BIT abs|AND abs|ROL abs|RLA abs',
  'BMI rel|AND izy|JAM imp|RLA izy|NOP zpx|AND zpx|ROL zpx|RLA zpx|SEC imp|AND aby|NOP imp|RLA aby|NOP abx|AND abx|ROL abx|RLA abx',
  'RTI imp|EOR izx|JAM imp|SRE izx|NOP zp|EOR zp|LSR zp|SRE zp|PHA imp|EOR imm|LSR acc|ALR imm|JMP abs|EOR abs|LSR abs|SRE abs',
  'BVC rel|EOR izy|JAM imp|SRE izy|NOP zpx|EOR zpx|LSR zpx|SRE zpx|CLI imp|EOR aby|NOP imp|SRE aby|NOP abx|EOR abx|LSR abx|SRE abx',
  'RTS imp|ADC izx|JAM imp|RRA izx|NOP zp|ADC zp|ROR zp|RRA zp|PLA imp|ADC imm|ROR acc|ARR imm|JMP ind|ADC abs|ROR abs|RRA abs',
  'BVS rel|ADC izy|JAM imp|RRA izy|NOP zpx|ADC zpx|ROR zpx|RRA zpx|SEI imp|ADC aby|NOP imp|RRA aby|NOP abx|ADC abx|ROR abx|RRA abx',
  'NOP imm|STA izx|NOP imm|SAX izx|STY zp|STA zp|STX zp|SAX zp|DEY imp|NOP imm|TXA imp|ANE imm|STY abs|STA abs|STX abs|SAX abs',
  'BCC rel|STA izy|JAM imp|SHA izy|STY zpx|STA zpx|STX zpy|SAX zpy|TYA imp|STA aby|TXS imp|TAS aby|SHY abx|STA abx|SHX aby|SHA aby',
  'LDY imm|LDA izx|LDX imm|LAX izx|LDY zp|LDA zp|LDX zp|LAX zp|TAY imp|LDA imm|TAX imp|LXA imm|LDY abs|LDA abs|LDX abs|LAX abs',
  'BCS rel|LDA izy|JAM imp|LAX izy|LDY zpx|LDA zpx|LDX zpy|LAX zpy|CLV imp|LDA aby|TSX imp|LAS aby|LDY abx|LDA abx|LDX aby|LAX aby',
  'CPY imm|CMP izx|NOP imm|DCP izx|CPY zp|CMP zp|DEC zp|DCP zp|INY imp|CMP imm|DEX imp|SBX imm|CPY abs|CMP abs|DEC abs|DCP abs',
  'BNE rel|CMP izy|JAM imp|DCP izy|NOP zpx|CMP zpx|DEC zpx|DCP zpx|CLD imp|CMP aby|NOP imp|DCP aby|NOP abx|CMP abx|DEC abx|DCP abx',
  'CPX imm|SBC izx|NOP imm|ISC izx|CPX zp|SBC zp|INC zp|ISC zp|INX imp|SBC imm|NOP imp|SBC imm|CPX abs|SBC abs|INC abs|ISC abs',
  'BEQ rel|SBC izy|JAM imp|ISC izy|NOP zpx|SBC zpx|INC zpx|ISC zpx|SED imp|SBC aby|NOP imp|ISC aby|NOP abx|SBC abx|INC abx|ISC abx',
];

const BRANCHES = new Set(['BPL', 'BMI', 'BVC', 'BVS', 'BCC', 'BCS', 'BNE', 'BEQ']);
const FLOW = new Set(['BRK', 'JSR', 'RTS', 'RTI', 'JMP', 'PHA', 'PHP', 'PLA', 'PLP']);
const WRITES = new Set(['STA', 'STX', 'STY', 'SAX', 'SHA', 'SHX', 'SHY', 'TAS']);
const RMW = new Set([
  'ASL',
  'LSR',
  'ROL',
  'ROR',
  'INC',
  'DEC',
  'SLO',
  'RLA',
  'SRE',
  'RRA',
  'DCP',
  'ISC',
]);
const ILLEGAL = new Set([
  'SLO',
  'RLA',
  'SRE',
  'RRA',
  'SAX',
  'LAX',
  'DCP',
  'ISC',
  'ANC',
  'ALR',
  'ARR',
  'SBX',
  'ANE',
  'LXA',
  'LAS',
  'SHA',
  'SHX',
  'SHY',
  'TAS',
  'JAM',
]);

function kindOf(mnemonic: string, mode: Mode): OpKind {
  if (mnemonic === 'JAM') return 'jam';
  if (BRANCHES.has(mnemonic)) return 'branch';
  if (FLOW.has(mnemonic)) return 'flow';
  if (mode === 'imp' || mode === 'acc') return 'implied';
  if (WRITES.has(mnemonic)) return 'write';
  if (RMW.has(mnemonic)) return 'rmw';
  return 'read';
}

function build(): OpInfo[] {
  const ops: OpInfo[] = [];
  for (const row of TABLE) {
    for (const cell of row.split('|')) {
      const [mnemonic, mode] = cell.split(' ') as [string, Mode];
      const opcode = ops.length;
      const official =
        !ILLEGAL.has(mnemonic) && !(mnemonic === 'NOP' && opcode !== 0xea) && opcode !== 0xeb;
      ops.push({ mnemonic, mode, kind: kindOf(mnemonic, mode), official });
    }
  }
  return ops;
}

export const OPS: readonly OpInfo[] = build();
