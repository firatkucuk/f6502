import { describe, expect, it } from 'vitest';
import { createGameRunner } from '../../scripts/lib/c64script-runner.mjs';

const program = (address = '0x0810') => `program @ ${address} {
  poke(0x0900, 42);
  puts(1, 1, "RUNNING", COLOR_WHITE);
  loop {}
}`;

const emptyRoms = () => ({
  kernal: new Uint8Array(8192).fill(0xea),
  basic: new Uint8Array(8192),
  chargen: new Uint8Array(4096),
});

describe('C64Script deterministic runner', () => {
  it('boots at $0810 and exposes screen and RAM observations', () => {
    const runner = createGameRunner({ maxFrames: 700 });
    const c64 = runner.boot(program());

    expect(c64.screenText().join('\n')).toContain('RUNNING');
    expect(runner.peek(0x0900)).toBe(42);
    expect(runner.framesRun).toBeGreaterThan(0);
  });

  it('rejects a PRG whose load address is not $0810', () => {
    const runner = createGameRunner({ maxFrames: 700 });

    expect(() => runner.boot(program('0x0900'))).toThrow(/load address.*0810/i);
  });

  it('reports when the KERNAL never displays READY', () => {
    const runner = createGameRunner({ maxFrames: 20, readyTimeoutFrames: 4, roms: emptyRoms() });

    expect(() => runner.boot(program())).toThrow(/READY.*4 frames/i);
  });

  it('bounds all boot and run frames', () => {
    const runner = createGameRunner({ maxFrames: 1 });

    expect(() => runner.boot(program())).toThrow(/frame limit.*1/i);
  });

  it('rejects invalid frame advances', () => {
    const runner = createGameRunner({ maxFrames: 700 });
    runner.boot(program());

    expect(() => runner.advance(0)).toThrow(/positive safe integer/i);
  });
});
