import type { Decl, HardwareDecl, VarDecl } from './ast';

type HardwareField = HardwareDecl['fields'][number];

export const COLOR_NAMES = [
  'BLACK', 'WHITE', 'RED', 'CYAN', 'PURPLE', 'GREEN', 'BLUE', 'YELLOW',
  'ORANGE', 'BROWN', 'LIGHT_RED', 'DARK_GREY', 'MEDIUM_GREY', 'LIGHT_GREEN', 'LIGHT_BLUE', 'LIGHT_GREY',
] as const;

/** Well-known addresses the language names. Hardware registers live in the VIC2/SID/CIA blocks. */
export const ADDRESS_NAMES = [
  ['SCREEN_RAM', 0x0400],
  ['COLOR_RAM', 0xD800],
  ['SPRITE_PTRS', 0x07F8],
] as const;

function constDecl(name: string, value: number, type: 'u8' | 'u16'): VarDecl {
  return {
    tag: 'varDecl', name, type: { tag: type },
    annotation: { kind: 'none' },
    isConst: true,
    init: { tag: 'intLit', value, line: 0 },
    line: 0,
  };
}

export function builtinDecls(): Decl[] {
  const colors: Decl[] = [
    ...COLOR_NAMES.map((n, i) => constDecl(`COLOR_${n}`, i, 'u8')),
    ...ADDRESS_NAMES.map(([n, v]) => constDecl(n, v, 'u16')),
  ];

  const vic2: Decl = {
    tag: 'hardware', name: 'VIC2', base: 0xD000, line: 0,
    fields: [
      { name: 'sprite0x',    type: { tag: 'u8' }, offset: 0x00, access: 'rw' },
      { name: 'sprite0y',    type: { tag: 'u8' }, offset: 0x01, access: 'rw' },
      { name: 'sprite1x',    type: { tag: 'u8' }, offset: 0x02, access: 'rw' },
      { name: 'sprite1y',    type: { tag: 'u8' }, offset: 0x03, access: 'rw' },
      ...[2, 3, 4, 5, 6, 7].flatMap((n): HardwareField[] => [
        { name: `sprite${n}x`, type: { tag: 'u8' }, offset: 2 * n, access: 'rw' },
        { name: `sprite${n}y`, type: { tag: 'u8' }, offset: 2 * n + 1, access: 'rw' },
      ]),
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
      ...[2, 3, 4, 5, 6, 7].map((n): HardwareField => ({
        name: `sprite${n}color`, type: { tag: 'u8' }, offset: 0x27 + n, access: 'rw',
      })),
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
      { name: 'v1freq_lo',   type: { tag: 'u8' }, offset: 0x00, access: 'rw' },
      { name: 'v1freq_hi',   type: { tag: 'u8' }, offset: 0x01, access: 'rw' },
      { name: 'v1pw_lo',     type: { tag: 'u8' }, offset: 0x02, access: 'rw' },
      { name: 'v1pw_hi',     type: { tag: 'u8' }, offset: 0x03, access: 'rw' },
      { name: 'v1ctrl',      type: { tag: 'u8' }, offset: 0x04, access: 'rw' },
      { name: 'v1atk_dec',   type: { tag: 'u8' }, offset: 0x05, access: 'rw' },
      { name: 'v1sus_rel',   type: { tag: 'u8' }, offset: 0x06, access: 'rw' },
      { name: 'v2freq_lo',   type: { tag: 'u8' }, offset: 0x07, access: 'rw' },
      { name: 'v2freq_hi',   type: { tag: 'u8' }, offset: 0x08, access: 'rw' },
      { name: 'v2pw_lo',     type: { tag: 'u8' }, offset: 0x09, access: 'rw' },
      { name: 'v2pw_hi',     type: { tag: 'u8' }, offset: 0x0A, access: 'rw' },
      { name: 'v2ctrl',      type: { tag: 'u8' }, offset: 0x0B, access: 'rw' },
      { name: 'v2atk_dec',   type: { tag: 'u8' }, offset: 0x0C, access: 'rw' },
      { name: 'v2sus_rel',   type: { tag: 'u8' }, offset: 0x0D, access: 'rw' },
      { name: 'v3freq_lo',   type: { tag: 'u8' }, offset: 0x0E, access: 'rw' },
      { name: 'v3freq_hi',   type: { tag: 'u8' }, offset: 0x0F, access: 'rw' },
      { name: 'v3pw_lo',     type: { tag: 'u8' }, offset: 0x10, access: 'rw' },
      { name: 'v3pw_hi',     type: { tag: 'u8' }, offset: 0x11, access: 'rw' },
      { name: 'v3ctrl',      type: { tag: 'u8' }, offset: 0x12, access: 'rw' },
      { name: 'v3atk_dec',   type: { tag: 'u8' }, offset: 0x13, access: 'rw' },
      { name: 'v3sus_rel',   type: { tag: 'u8' }, offset: 0x14, access: 'rw' },
      { name: 'filterCutLo', type: { tag: 'u8' }, offset: 0x15, access: 'rw' },
      { name: 'filterCutHi', type: { tag: 'u8' }, offset: 0x16, access: 'rw' },
      { name: 'filterRes',   type: { tag: 'u8' }, offset: 0x17, access: 'rw' },
      { name: 'modeVol',     type: { tag: 'u8' }, offset: 0x18, access: 'rw' },
    ],
  };

  return [...colors, vic2, cia1, cia2, sid];
}
