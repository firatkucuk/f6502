import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { C64 } from '../../src/machine/c64';
import { compile } from '../../src/c64script/index';

const rom = (name: string) => new Uint8Array(readFileSync(`website/demos/${name}`));

function bootWith(source: string, frames = 5): C64 {
  const c64 = new C64({
    kernal: rom('kernal.bin'),
    basic: rom('basic.bin'),
    chargen: rom('chargen.bin'),
  });
  expect(c64.runUntilReady(600)).toBe(true);
  c64.loadPrg(compile(source), { whenReady: false });
  for (let i = 0; i < frames; i++) c64.runFrame();
  return c64;
}

describe('stub KERNAL hands over a clean 40-column screen', () => {
  const idle = 'program @ 0x0810 { VIC2.borderColor = BLUE; loop {} }';

  it('selects 40-column mode, so column 0 is not clipped', () => {
    const c64 = bootWith(idle);
    expect(c64.peek(0xd016) & 0x08).toBe(0x08);
  });

  it('clears the boot text before the program starts', () => {
    const c64 = bootWith(idle);
    for (const addr of [0x0400, 0x04c8, 0x04cd, 0x0500, 0x0600, 0x0700, 0x07e7]) {
      expect(c64.peek(addr), `screen RAM at $${addr.toString(16)}`).toBe(0x20);
    }
  });

  it('does not touch what the program itself writes', () => {
    const c64 = bootWith('program @ 0x0810 { poke(0x05ef, 8); loop {} }');
    expect(c64.peek(0x05ef)).toBe(8);
  });

  it('leaves the sprite pointers alone', () => {
    const c64 = bootWith('program @ 0x0810 { poke(0x07f8, 53); loop {} }');
    expect(c64.peek(0x07f8)).toBe(53);
  });
});

describe('stub KERNAL boot screen (what Reboot shows)', () => {
  const colourRam = (c64: C64, addr: number): number => c64.peek(addr) & 0x0f;

  function newMachine(): C64 {
    const c64 = new C64({
      kernal: rom('kernal.bin'),
      basic: rom('basic.bin'),
      chargen: rom('chargen.bin'),
    });
    expect(c64.runUntilReady(600)).toBe(true);
    return c64;
  }

  it('is the classic light-blue-on-blue C64 screen with a visible READY.', () => {
    const c64 = newMachine();
    expect(c64.peek(0xd020) & 0x0f).toBe(14); // border: light blue
    expect(c64.peek(0xd021) & 0x0f).toBe(6); // background: blue
    for (let i = 0; i < 6; i++) expect(colourRam(c64, 0xd8c8 + i), `READY. cell ${i}`).toBe(14);
    expect(c64.peek(0x04c8)).toBe(18); // R
  });

  it('comes back after a program has changed the colours and filled the screen', () => {
    const c64 = newMachine();
    c64.loadPrg(
      compile(`program @ 0x0810 {
        VIC2.borderColor = RED; VIC2.bgColor0 = GREEN;
        poke(0x0400, 1); poke(0xD800, 5);
        loop {}
      }`),
      { whenReady: false },
    );
    for (let i = 0; i < 5; i++) c64.runFrame();
    expect(c64.peek(0xd020) & 0x0f).toBe(2); // the program is running

    c64.reset();
    expect(c64.runUntilReady(600)).toBe(true);
    expect(c64.peek(0xd020) & 0x0f).toBe(14);
    expect(c64.peek(0xd021) & 0x0f).toBe(6);
    expect(c64.peek(0x0400)).toBe(0x20); // the old text is gone
    expect(colourRam(c64, 0xd800)).toBe(14);
  });

  it('still hands a program black border, black background and black colour RAM', () => {
    const c64 = newMachine();
    c64.loadPrg(compile('program @ 0x0810 { loop {} }'), { whenReady: false });
    for (let i = 0; i < 5; i++) c64.runFrame();
    expect(c64.peek(0xd020) & 0x0f).toBe(0);
    expect(c64.peek(0xd021) & 0x0f).toBe(0);
    expect(colourRam(c64, 0xd800)).toBe(0);
    expect(colourRam(c64, 0xdbe7)).toBe(0);
  });
});
