import type { Decl, VarDecl } from './ast';

const COLOR_NAMES = [
  'BLACK', 'WHITE', 'RED', 'CYAN', 'PURPLE', 'GREEN', 'BLUE', 'YELLOW',
  'ORANGE', 'BROWN', 'LIGHT_RED', 'DARK_GREY', 'MEDIUM_GREY', 'LIGHT_GREEN', 'LIGHT_BLUE', 'LIGHT_GREY',
] as const;

function colorConst(name: string, value: number): VarDecl {
  return {
    tag: 'varDecl', name, type: { tag: 'u8' },
    annotation: { kind: 'none' },
    init: { tag: 'intLit', value, line: 0 },
    line: 0,
  };
}

export function builtinDecls(): Decl[] {
  const colors: Decl[] = COLOR_NAMES.map((n, i) => colorConst(n, i));

  const vic2: Decl = {
    tag: 'hardware', name: 'VIC2', base: 0xD000, line: 0,
    fields: [
      { name: 'sprite0x',    type: { tag: 'u8' }, offset: 0x00, access: 'rw' },
      { name: 'sprite0y',    type: { tag: 'u8' }, offset: 0x01, access: 'rw' },
      { name: 'sprite1x',    type: { tag: 'u8' }, offset: 0x02, access: 'rw' },
      { name: 'sprite1y',    type: { tag: 'u8' }, offset: 0x03, access: 'rw' },
      { name: 'spriteXmsb',  type: { tag: 'u8' }, offset: 0x10, access: 'rw' },
      { name: 'ctrl1',       type: { tag: 'u8' }, offset: 0x11, access: 'rw' },
      { name: 'rasterLine',  type: { tag: 'u8' }, offset: 0x12, access: 'readonly' },
      { name: 'rasterIRQ',   type: { tag: 'u8' }, offset: 0x12, access: 'writeonly' },
      { name: 'spriteEnable',type: { tag: 'u8' }, offset: 0x15, access: 'rw' },
      { name: 'ctrl2',       type: { tag: 'u8' }, offset: 0x16, access: 'rw' },
      { name: 'spriteYexp',  type: { tag: 'u8' }, offset: 0x17, access: 'rw' },
      { name: 'memPointers', type: { tag: 'u8' }, offset: 0x18, access: 'rw' },
      { name: 'irqStatus',   type: { tag: 'u8' }, offset: 0x19, access: 'rw' },
      { name: 'irqMask',     type: { tag: 'u8' }, offset: 0x1A, access: 'rw' },
      { name: 'spSprCol',    type: { tag: 'u8' }, offset: 0x1E, access: 'read_to_clear' },
      { name: 'spBgCol',     type: { tag: 'u8' }, offset: 0x1F, access: 'read_to_clear' },
      { name: 'borderColor', type: { tag: 'u8' }, offset: 0x20, access: 'rw' },
      { name: 'bgColor0',    type: { tag: 'u8' }, offset: 0x21, access: 'rw' },
      { name: 'sprite0color',type: { tag: 'u8' }, offset: 0x27, access: 'rw' },
      { name: 'sprite1color',type: { tag: 'u8' }, offset: 0x28, access: 'rw' },
    ],
  };

  const cia1: Decl = {
    tag: 'hardware', name: 'CIA1', base: 0xDC00, line: 0,
    fields: [
      { name: 'portA',    type: { tag: 'u8' }, offset: 0x00, access: 'rw' },
      { name: 'portB',    type: { tag: 'u8' }, offset: 0x01, access: 'rw' },
      { name: 'ddrA',     type: { tag: 'u8' }, offset: 0x02, access: 'rw' },
      { name: 'ddrB',     type: { tag: 'u8' }, offset: 0x03, access: 'rw' },
      { name: 'timerAlo', type: { tag: 'u8' }, offset: 0x04, access: 'rw' },
      { name: 'timerAhi', type: { tag: 'u8' }, offset: 0x05, access: 'rw' },
      { name: 'icr',      type: { tag: 'u8' }, offset: 0x0D, access: 'rw' },
      { name: 'cra',      type: { tag: 'u8' }, offset: 0x0E, access: 'rw' },
    ],
  };

  const cia2: Decl = {
    tag: 'hardware', name: 'CIA2', base: 0xDD00, line: 0,
    fields: [
      { name: 'portA', type: { tag: 'u8' }, offset: 0x00, access: 'rw' },
      { name: 'portB', type: { tag: 'u8' }, offset: 0x01, access: 'rw' },
      { name: 'ddrA',  type: { tag: 'u8' }, offset: 0x02, access: 'rw' },
      { name: 'ddrB',  type: { tag: 'u8' }, offset: 0x03, access: 'rw' },
      { name: 'icr',   type: { tag: 'u8' }, offset: 0x0D, access: 'rw' },
    ],
  };

  const sid: Decl = {
    tag: 'hardware', name: 'SID', base: 0xD400, line: 0,
    fields: [
      { name: 'v1freq_lo', type: { tag: 'u8' }, offset: 0x00, access: 'rw' },
      { name: 'v1freq_hi', type: { tag: 'u8' }, offset: 0x01, access: 'rw' },
      { name: 'v1ctrl',    type: { tag: 'u8' }, offset: 0x04, access: 'rw' },
      { name: 'v1atk_dec', type: { tag: 'u8' }, offset: 0x05, access: 'rw' },
      { name: 'v1sus_rel', type: { tag: 'u8' }, offset: 0x06, access: 'rw' },
      { name: 'modeVol',   type: { tag: 'u8' }, offset: 0x18, access: 'rw' },
    ],
  };

  return [...colors, vic2, cia1, cia2, sid];
}
