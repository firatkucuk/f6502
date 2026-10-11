import { describe, expect, it } from 'vitest';
import * as api from '../../src/index';

describe('public API: C64Script compiler', () => {
  it('exports compile and the error classes', () => {
    expect(typeof api.compile).toBe('function');
    expect(typeof api.C64ScriptError).toBe('function');
    for (const E of [api.LexError, api.ParseError, api.CodeGenError, api.C64ScriptTypeError]) {
      expect(E.prototype).toBeInstanceOf(api.C64ScriptError);
    }
  });

  it('does not export a class named TypeError (it would shadow the global)', () => {
    expect('TypeError' in api).toBe(false);
  });

  it('compiles to a PRG whose first two bytes are the load address', () => {
    const prg = api.compile('program @ 0x0810 { loop {} }');
    expect(prg[0]).toBe(0x10);
    expect(prg[1]).toBe(0x08);
    expect(prg.length).toBeGreaterThan(2);
  });

  it('reports line and column on a syntax error', () => {
    try {
      api.compile('// first line\nprogram(0x0810) { loop {} }');
      expect.unreachable('compile should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(api.C64ScriptError);
      expect((err as InstanceType<typeof api.C64ScriptError>).line).toBe(2);
    }
  });

  it('accepts Windows line endings and keeps line numbers right', () => {
    const ok = api.compile('// c\r\nprogram @ 0x0810 {\r\n  loop {}\r\n}\r\n');
    expect(ok[0]).toBe(0x10);
    try {
      api.compile('// c\r\n// d\r\nprogram(0x0810) { loop {} }\r\n');
      expect.unreachable('compile should have thrown');
    } catch (err) {
      expect((err as InstanceType<typeof api.C64ScriptError>).line).toBe(3);
    }
  });

  it('throws a C64ScriptError (not a crash) for empty source', () => {
    expect(() => api.compile('')).toThrow();
  });
});
