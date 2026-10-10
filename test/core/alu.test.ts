import { describe, expect, it } from 'vitest';
import { C, D, N, V, Z } from '../../src/core/flags';
import { boot } from './helpers';

type Regs = ReturnType<typeof boot>['cpu']['regs'];

function run(program: number[], steps: number, setup?: (regs: Regs) => void) {
  const m = boot(program);
  setup?.(m.cpu.regs);
  for (let i = 0; i < steps; i++) m.cpu.step();
  return m;
}

describe('ADC / SBC binary', () => {
  it('ADC sets overflow and negative', () => {
    const { cpu } = run([0x69, 0x50], 1, (r) => (r.a = 0x50));
    expect(cpu.regs.a).toBe(0xa0);
    expect(cpu.regs.p & V).toBe(V);
    expect(cpu.regs.p & N).toBe(N);
    expect(cpu.regs.p & C).toBe(0);
  });

  it('ADC wraps with carry out and Z', () => {
    const { cpu } = run([0x69, 0x01], 1, (r) => (r.a = 0xff));
    expect(cpu.regs.a).toBe(0x00);
    expect(cpu.regs.p & C).toBe(C);
    expect(cpu.regs.p & Z).toBe(Z);
  });

  it('SBC uses carry as not-borrow', () => {
    const { cpu } = run([0xe9, 0x01], 1, (r) => {
      r.a = 0x00;
      r.p |= C;
    });
    expect(cpu.regs.a).toBe(0xff);
    expect(cpu.regs.p & C).toBe(0);
    expect(cpu.regs.p & N).toBe(N);
  });
});

describe('ADC / SBC decimal (NMOS)', () => {
  it('15 + 27 = 42', () => {
    const { cpu } = run([0x69, 0x27], 1, (r) => {
      r.a = 0x15;
      r.p |= D;
    });
    expect(cpu.regs.a).toBe(0x42);
    expect(cpu.regs.p & C).toBe(0);
  });

  it('99 + 01 = 00 with carry; Z comes from the binary sum (NMOS quirk)', () => {
    const { cpu } = run([0x69, 0x01], 1, (r) => {
      r.a = 0x99;
      r.p |= D;
    });
    expect(cpu.regs.a).toBe(0x00);
    expect(cpu.regs.p & C).toBe(C);
    expect(cpu.regs.p & Z).toBe(0); // binary 0x99+0x01 = 0x9a, not zero
  });

  it('invalid BCD digits: $0F + $01 in decimal mode', () => {
    const { cpu } = run([0x69, 0x01], 1, (r) => {
      r.a = 0x0f;
      r.p |= D;
    });
    expect(cpu.regs.a).toBe(0x16);
  });

  it('invalid BCD digits: $FF + $01 in decimal mode', () => {
    const { cpu } = run([0x69, 0x01], 1, (r) => {
      r.a = 0xff;
      r.p |= D;
    });
    expect(cpu.regs.a).toBe(0x66);
    expect(cpu.regs.p & C).toBe(C);
  });

  it('SBC 42 - 15 = 27', () => {
    const { cpu } = run([0xe9, 0x15], 1, (r) => {
      r.a = 0x42;
      r.p |= D | C;
    });
    expect(cpu.regs.a).toBe(0x27);
    expect(cpu.regs.p & C).toBe(C);
  });

  it('SBC 00 - 01 = 99 with borrow', () => {
    const { cpu } = run([0xe9, 0x01], 1, (r) => {
      r.a = 0x00;
      r.p |= D | C;
    });
    expect(cpu.regs.a).toBe(0x99);
    expect(cpu.regs.p & C).toBe(0);
  });
});

describe('logic, compare, BIT', () => {
  it('AND / ORA / EOR', () => {
    // $F5 & $0F = $05; | $80 = $85; ^ $FF = $7A
    const { cpu } = run([0x29, 0x0f, 0x09, 0x80, 0x49, 0xff], 3, (r) => (r.a = 0xf5));
    expect(cpu.regs.a).toBe(0x7a);
  });

  it('CMP sets C when A >= operand and Z when equal', () => {
    const { cpu } = run([0xc9, 0x40], 1, (r) => (r.a = 0x40));
    expect(cpu.regs.p & C).toBe(C);
    expect(cpu.regs.p & Z).toBe(Z);
  });

  it('CPX / CPY immediate', () => {
    const { cpu } = run([0xe0, 0x05, 0xc0, 0x09], 2, (r) => {
      r.x = 0x04;
      r.y = 0x09;
    });
    // CPY ran last: Y == $09 -> C and Z set
    expect(cpu.regs.p & C).toBe(C);
    expect(cpu.regs.p & Z).toBe(Z);
  });

  it('BIT copies bits 7/6 of memory into N/V and Z from A & M', () => {
    const m = boot([0x24, 0x10]);
    m.bus.mem[0x10] = 0xc0;
    m.cpu.regs.a = 0x01;
    expect(m.cpu.step()).toBe(3);
    expect(m.cpu.regs.p & N).toBe(N);
    expect(m.cpu.regs.p & V).toBe(V);
    expect(m.cpu.regs.p & Z).toBe(Z);
  });
});

describe('shifts and INC/DEC', () => {
  it('ASL A / LSR A / ROL A / ROR A (2 cycles each)', () => {
    // A=$81: ASL -> $02 C=1 ; LSR -> $01 C=0 ; ROL -> $02 C=0 ; ROR -> $01 C=0
    const m = boot([0x0a, 0x4a, 0x2a, 0x6a]);
    m.cpu.regs.a = 0x81;
    expect(m.cpu.step()).toBe(2);
    expect(m.cpu.regs.a).toBe(0x02);
    expect(m.cpu.regs.p & C).toBe(C);
    m.cpu.step();
    expect(m.cpu.regs.a).toBe(0x01);
    m.cpu.step();
    expect(m.cpu.regs.a).toBe(0x02);
    m.cpu.step();
    expect(m.cpu.regs.a).toBe(0x01);
  });

  it('INC zp performs read, dummy write of the old value, then write (5 cycles)', () => {
    const m = boot([0xe6, 0x10]);
    m.bus.mem[0x10] = 0x7f;
    m.bus.trace = [];
    expect(m.cpu.step()).toBe(5);
    expect(m.bus.trace).toEqual([
      [0x0200, 0xe6, 'read'],
      [0x0201, 0x10, 'read'],
      [0x0010, 0x7f, 'read'],
      [0x0010, 0x7f, 'write'],
      [0x0010, 0x80, 'write'],
    ]);
    expect(m.cpu.regs.p & N).toBe(N);
  });

  it('DEC abs,X always takes 7 cycles', () => {
    const m = boot([0xde, 0x00, 0x12]);
    m.cpu.regs.x = 0x01;
    m.bus.mem[0x1201] = 0x01;
    expect(m.cpu.step()).toBe(7);
    expect(m.bus.mem[0x1201]).toBe(0x00);
    expect(m.cpu.regs.p & Z).toBe(Z);
  });

  it('INX/INY/DEX/DEY wrap', () => {
    const { cpu } = run([0xe8, 0xc8, 0xca, 0x88], 4, (r) => {
      r.x = 0xff;
      r.y = 0x00;
    });
    // X: $FF -> $00 (INX) -> $FF (DEX); Y: $00 -> $01 (INY) -> $00 (DEY)
    expect(cpu.regs.x).toBe(0xff);
    expect(cpu.regs.y).toBe(0x00);
  });
});
