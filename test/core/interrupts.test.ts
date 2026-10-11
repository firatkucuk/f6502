import { describe, expect, it } from 'vitest';
import { B, I } from '../../src/core/flags';
import { boot, machine } from './helpers';

describe('IRQ', () => {
  it('is serviced after the current instruction: 7 cycles, B=0 pushed, I set', () => {
    const m = boot([0xea, 0xea]);
    m.cpu.regs.p &= ~I;
    m.cpu.setIrq(true);
    m.cpu.step(); // NOP executes, interrupt decided
    expect(m.cpu.regs.pc).toBe(0x0201);
    expect(m.cpu.step()).toBe(7);
    expect(m.cpu.regs.pc).toBe(0x0300);
    expect(m.cpu.regs.p & I).toBe(I);
    expect(m.bus.mem[0x01fd]).toBe(0x02);
    expect(m.bus.mem[0x01fc]).toBe(0x01);
    expect(m.bus.mem[0x01fb]! & B).toBe(0);
  });

  it('is never serviced while I is set, even if held for a long time', () => {
    const m = boot(new Array<number>(64).fill(0xea));
    m.cpu.setIrq(true); // I is set after reset
    for (let i = 0; i < 50; i++) m.cpu.step();
    expect(m.cpu.regs.pc).toBe(0x0200 + 50);
  });

  it('CLI delays servicing by one instruction', () => {
    const m = boot([0x58, 0xea, 0xea]);
    m.cpu.setIrq(true);
    m.cpu.step(); // CLI
    m.cpu.step(); // NOP still runs
    expect(m.cpu.regs.pc).toBe(0x0202);
    m.cpu.step(); // interrupt sequence
    expect(m.cpu.regs.pc).toBe(0x0300);
  });

  it('SEI does not mask an IRQ that was already pending when it started', () => {
    const m = boot([0x78, 0xea]);
    m.cpu.regs.p &= ~I;
    m.cpu.setIrq(true);
    m.cpu.step(); // SEI executes; the poll happened before I changed
    expect(m.cpu.regs.p & I).toBe(I);
    m.cpu.step(); // interrupt is taken anyway
    expect(m.cpu.regs.pc).toBe(0x0300);
    expect(m.bus.mem[0x01fd]).toBe(0x02); // return address is the instruction after SEI
    expect(m.bus.mem[0x01fc]).toBe(0x01);
    expect(m.bus.mem[0x01fb]! & I).toBe(I); // pushed P already shows I set
  });
});

describe('NMI', () => {
  it('is serviced via $FFFA regardless of I, and takes 7 cycles', () => {
    const m = boot([0xea, 0xea]);
    m.cpu.setNmi(true);
    m.cpu.step();
    expect(m.cpu.step()).toBe(7);
    expect(m.cpu.regs.pc).toBe(0x0400);
  });

  it('a held-low NMI line does not retrigger; a new edge does', () => {
    const m = boot(new Array<number>(32).fill(0xea));
    m.bus.mem[0x0400] = 0xea;
    m.bus.mem[0x0401] = 0xea;
    m.bus.mem[0x0402] = 0xea;
    m.cpu.setNmi(true);
    m.cpu.step(); // NOP
    m.cpu.step(); // NMI sequence -> $0400
    expect(m.cpu.regs.pc).toBe(0x0400);
    m.cpu.step();
    m.cpu.step();
    expect(m.cpu.regs.pc).toBe(0x0402); // line still held: no second NMI
    m.cpu.setNmi(false);
    m.cpu.setNmi(true);
    m.cpu.step();
    m.cpu.step();
    expect(m.cpu.regs.pc).toBe(0x0400); // fresh edge serviced again
  });

  it('has priority over IRQ', () => {
    const m = boot([0xea, 0xea]);
    m.cpu.regs.p &= ~I;
    m.cpu.setIrq(true);
    m.cpu.setNmi(true);
    m.cpu.step();
    m.cpu.step();
    expect(m.cpu.regs.pc).toBe(0x0400);
  });
});

describe('poll timing', () => {
  it('not-taken branch (2 cycles): IRQ asserted in its cycle 1 is serviced right after it', () => {
    const m = machine([0xf0, 0x00, 0xea, 0xea], {
      onCycle: () => {
        if (m.cpu.cycles === 8) m.cpu.setIrq(true);
      },
    });
    m.cpu.reset();
    m.cpu.regs.p &= ~I;
    m.cpu.step(); // BEQ not taken (Z=0)
    m.cpu.step(); // interrupt sequence
    expect(m.cpu.regs.pc).toBe(0x0300);
  });

  it('taken branch without page cross: IRQ asserted in cycle 2 is delayed by one instruction', () => {
    const m = machine([0xd0, 0x00, 0xea, 0xea], {
      onCycle: () => {
        if (m.cpu.cycles === 9) m.cpu.setIrq(true);
      },
    });
    m.cpu.reset();
    m.cpu.regs.p &= ~I;
    m.cpu.step(); // BNE taken (3 cycles: 8,9,10)
    m.cpu.step(); // NOP runs first
    expect(m.cpu.regs.pc).toBe(0x0203);
    m.cpu.step(); // now the interrupt
    expect(m.cpu.regs.pc).toBe(0x0300);
  });
});

describe('poll timing: branches that were already pending', () => {
  it('IRQ held across a taken, non-crossing branch-to-self is serviced right after the branch', () => {
    const m = boot([0xa9, 0x01, 0x58, 0xd0, 0xfe]); // LDA #1 ; CLI ; loop: BNE loop
    m.cpu.step(); // LDA
    m.cpu.step(); // CLI
    m.cpu.setIrq(true);
    m.cpu.step(); // BNE taken (first instruction: IRQ becomes visible only now)
    m.cpu.step(); // BNE taken again: the poll saw the IRQ before the branch started
    m.cpu.step(); // interrupt sequence
    expect(m.cpu.regs.pc).toBe(0x0300);
  });

  it('an NMI edge raised before a taken, non-crossing branch-to-self is not starved', () => {
    const m = boot([0xd0, 0xfe]); // BNE * (Z=0, always taken)
    m.cpu.step(); // branch executes once
    m.cpu.setNmi(true); // edge arrives between instructions
    m.cpu.step(); // branch again: pending NMI was sampled before its cycle 2
    m.cpu.step(); // interrupt sequence
    expect(m.cpu.regs.pc).toBe(0x0400);
  });
});

describe('NMI hijack of BRK', () => {
  it('NMI arriving before the vector fetch hijacks BRK; B is still pushed as 1', () => {
    const m = machine([0x00, 0xea], {
      onCycle: () => {
        if (m.cpu.cycles === 10) m.cpu.setNmi(true); // BRK cycles are 8..14
      },
    });
    m.cpu.reset();
    m.cpu.step();
    expect(m.cpu.regs.pc).toBe(0x0400);
    expect(m.bus.mem[0x01fb]! & B).toBe(B);
    m.bus.mem[0x0400] = 0xea;
    m.bus.mem[0x0401] = 0xea;
    m.cpu.step();
    m.cpu.step();
    expect(m.cpu.regs.pc).toBe(0x0402); // the NMI was consumed, not repeated
  });

  it('NMI arriving after the vector fetch is serviced after the first handler instruction', () => {
    const m = machine([0x00, 0xea], {
      onCycle: () => {
        if (m.cpu.cycles === 14) m.cpu.setNmi(true);
      },
    });
    m.cpu.reset();
    m.bus.mem[0x0300] = 0xea;
    m.cpu.step(); // BRK -> $0300 (normal vector)
    expect(m.cpu.regs.pc).toBe(0x0300);
    m.cpu.step(); // handler's first instruction
    expect(m.cpu.regs.pc).toBe(0x0301);
    m.cpu.step(); // NMI sequence
    expect(m.cpu.regs.pc).toBe(0x0400);
  });
});

describe('I flag effect timing (RTI, PLP) and last-cycle IRQ', () => {
  it('RTI that clears I takes a pending IRQ immediately, before any instruction at the return address', () => {
    const m = boot([0x40, 0xea, 0xea]); // RTI at $0200
    m.bus.mem[0x01fd] = 0x04; // return address $0400
    m.bus.mem[0x01fc] = 0x00;
    m.bus.mem[0x01fb] = 0x20; // P with I clear
    m.cpu.regs.sp = 0xfa;
    m.bus.mem[0x0400] = 0xea;
    m.cpu.setIrq(true);
    m.cpu.step(); // RTI
    expect(m.cpu.regs.pc).toBe(0x0400);
    m.cpu.step(); // interrupt sequence, not the NOP at $0400
    expect(m.cpu.regs.pc).toBe(0x0300);
    expect(m.bus.mem[0x01fd]).toBe(0x04);
    expect(m.bus.mem[0x01fc]).toBe(0x00);
  });

  it('PLP that clears I delays the IRQ by one instruction', () => {
    const m = boot([0x28, 0xea, 0xea]); // PLP, NOP, NOP
    m.bus.mem[0x01fd] = 0x20; // P with I clear
    m.cpu.regs.sp = 0xfc;
    m.cpu.setIrq(true);
    m.cpu.step(); // PLP
    expect(m.cpu.regs.p & I).toBe(0);
    m.cpu.step(); // NOP still runs
    expect(m.cpu.regs.pc).toBe(0x0202);
    m.cpu.step(); // now the interrupt
    expect(m.cpu.regs.pc).toBe(0x0300);
  });

  it('an IRQ asserted on the last cycle of an ordinary instruction waits one more instruction', () => {
    const m = machine([0xea, 0xea, 0xea], {
      onCycle: () => {
        if (m.cpu.cycles === 9) m.cpu.setIrq(true); // NOP occupies cycles 8 and 9
      },
    });
    m.cpu.reset();
    m.cpu.regs.p &= ~I;
    m.cpu.step(); // first NOP
    m.cpu.step(); // second NOP still executes
    expect(m.cpu.regs.pc).toBe(0x0202);
    m.cpu.step(); // interrupt
    expect(m.cpu.regs.pc).toBe(0x0300);
  });
});
