import { describe, expect, it } from 'vitest';
import { border, boot, expectError } from './helpers';

const NAMES = [
  'BLACK',
  'WHITE',
  'RED',
  'CYAN',
  'PURPLE',
  'GREEN',
  'BLUE',
  'YELLOW',
  'ORANGE',
  'BROWN',
  'LIGHT_RED',
  'DARK_GREY',
  'MEDIUM_GREY',
  'LIGHT_GREEN',
  'LIGHT_BLUE',
  'LIGHT_GREY',
];

describe('COLOR_ names', () => {
  it.each(NAMES.map((n, i) => [n, i] as const))('COLOR_%s is colour %i', (name, value) => {
    // Paint a different colour first so a missing store cannot pass by accident.
    const src = `program @ 0x0810 { VIC2.borderColor = ${value === 7 ? 3 : 7}; VIC2.borderColor = COLOR_${name}; loop {} }`;
    expect(border(boot(src))).toBe(value);
  });

  it('are constants: usable in const expressions and initialisers', () => {
    const c = boot(`
      const PAIR: u8 = COLOR_RED + COLOR_BLUE;
      let @zp c: u8 = COLOR_YELLOW;
      program @ 0x0810 { VIC2.borderColor = PAIR; VIC2.bgColor0 = c; loop {} }`);
    expect(border(c)).toBe(8);
  });

  it('the bare names are gone, and the error points at the new name', () => {
    expectError(
      'program @ 0x0810 {\n  VIC2.borderColor = RED;\n  loop {}\n}',
      'type',
      /undefined variable 'RED'.*COLOR_RED/,
      2,
    );
    expectError(
      'program @ 0x0810 {\n  VIC2.bgColor0 = LIGHT_BLUE;\n  loop {}\n}',
      'type',
      /undefined variable 'LIGHT_BLUE'.*COLOR_LIGHT_BLUE/,
      2,
    );
  });

  it('cannot be redefined or assigned', () => {
    expectError(
      'const COLOR_RED: u8 = 3;\nprogram @ 0x0810 { loop {} }',
      'type',
      /'COLOR_RED' already defined/,
      1,
    );
    expectError(
      'program @ 0x0810 {\n  COLOR_RED = 3;\n  loop {}\n}',
      'type',
      /cannot assign to constant 'COLOR_RED'/,
      2,
    );
  });

  it('leave lowercase variable names alone', () => {
    const c = boot(
      'let @zp color: u8 = 5;\nprogram @ 0x0810 { VIC2.borderColor = color; loop {} }',
    );
    expect(border(c)).toBe(5);
  });

  it('a program may now use RED as its own name', () => {
    const c = boot('const RED: u8 = 9;\nprogram @ 0x0810 { VIC2.borderColor = RED; loop {} }');
    expect(border(c)).toBe(9);
  });
});
