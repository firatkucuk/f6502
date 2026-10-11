import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { boot, expectError } from '../c64script/helpers';

const html = readFileSync('website/c64script.html', 'utf8');
const text = html
  .replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&');
const P = (body: string, pre = '') => `${pre}\nprogram @ 0x0810 {\n${body}\n  loop {}\n}`;

describe('the language guide is on the page', () => {
  for (const heading of [
    'Program structure',
    'Variables and constants',
    'Literals and expressions',
    'Control flow',
    'Functions',
    'Not in the language yet',
  ]) {
    it(`has a "${heading}" section`, () => {
      expect(html).toMatch(new RegExp(`<h2 class="section-title">${heading}</h2>`));
    });
  }

  it('does not advertise elif as part of an if / elif / else chain', () => {
    expect(html).not.toMatch(/<code>elif<\/code>\s*\/\s*<code>else/);
    expect(html).not.toMatch(/<code>if<\/code>\s*\/\s*<code>elif/);
    expect(text).toMatch(/else if/);
  });
});

describe('documented behaviour is real', () => {
  it('a program that reaches its end starts over', () => {
    const c = boot('let @zp n: u8 = 0;\nprogram @ 0x0810 { n++; poke(0x0400, n); }', 4);
    expect(c.peek(0x0400)).toBeGreaterThan(1);
  });

  it('only one program block is allowed', () => {
    expectError(
      'program @ 0x0810 { loop {} }\nprogram @ 0x0820 { loop {} }',
      'type',
      /only one program block/,
      2,
    );
  });

  it('functions and constants may be used before they are declared', () => {
    const c = boot(
      'program @ 0x0810 { f(); VIC2.borderColor = K; loop {} }\nfn f(): void { VIC2.bgColor0 = 5; }\nconst K: u8 = 3;',
    );
    expect(c.peek(0xd021) & 15).toBe(5);
    expect(c.peek(0xd020) & 15).toBe(3);
  });

  it('else if chains, for with a let, while, loop/break, continue', () => {
    const c = boot(
      P(`
        let s: u8 = 0;
        for (let i: u8 = 0; i < 6; i++) {
          if (i == 1) { continue; }
          else if (i == 4) { break; }
          s++;
        }
        VIC2.borderColor = s;`),
    );
    expect(c.peek(0xd020) & 15).toBe(3);
  });

  it('constants fold + - * & | ^ << >>', () => {
    const c = boot(P('const A: u8 = ((2 + 3) * 4 - 1) & 0x0F | (1 << 2); VIC2.borderColor = A;'));
    expect(c.peek(0xd020) & 15).toBe(((((2 + 3) * 4 - 1) & 0x0f) | (1 << 2)) & 15);
  });

  it('u8 arithmetic wraps modulo 256 and compares unsigned', () => {
    const c = boot(
      P(
        'let a: u8 = 250; a += 10; VIC2.borderColor = a; let b: u8 = 200; if (b > 100) { VIC2.bgColor0 = 5; }',
      ),
    );
    expect(c.peek(0xd020) & 15).toBe(4);
    expect(c.peek(0xd021) & 15).toBe(5);
  });

  it('a left operand may be any expression, a right operand may not', () => {
    const c = boot(P('let a: u8 = 1; VIC2.borderColor = (a + 2) & 6;'));
    expect(c.peek(0xd020) & 15).toBe(2);
    expectError(
      P('let a: u8 = 1;\n  let b: u8 = 2;\n  VIC2.borderColor = a + (b + 1);'),
      'codegen',
      /right-hand operand/,
      5,
    );
  });
});

describe('every row of the "not in the language yet" table is true', () => {
  const parseErr = /expected|unexpected/;
  const rows: Array<[string, string, RegExp, 'parse' | 'codegen' | 'type']> = [
    [
      'elif',
      P('let x: u8 = 2; if (x == 1) { x = 0; } elif (x == 2) { x = 1; }'),
      parseErr,
      'parse',
    ],
    ['braceless if', P('let x: u8 = 2; if (x == 2) x = 1;'), parseErr, 'parse'],
    [
      '&&',
      P('let a: u8 = 1; if (a == 1 && a == 2) { a = 0; }'),
      /'&&' is not supported yet/,
      'codegen',
    ],
    [
      '||',
      P('let a: u8 = 1; if (a == 1 || a == 2) { a = 0; }'),
      /'\|\|' is not supported yet/,
      'codegen',
    ],
    ['switch', P('let n: u8 = 0; switch (n) { case 0: break; }'), parseErr, 'parse'],
    ['do/while', P('let n: u8 = 0; do { n++; } while (n < 3);'), parseErr, 'parse'],
    [
      'ternary',
      P('let n: u8 = 1; VIC2.borderColor = n == 1 ? 5 : 6;'),
      /unexpected character '\?'/,
      'parse',
    ],
    ['runtime *', P('let a: u8 = 3; a = a * 2;'), /operator '\*' is not supported yet/, 'codegen'],
    [
      'runtime <<',
      P('let a: u8 = 1; a = a << 2;'),
      /operator '<<' is not supported yet/,
      'codegen',
    ],
    ['runtime %', P('let a: u8 = 7; a = a % 3;'), /operator '%' is not supported yet/, 'codegen'],
    ['unary -', P('let a: u8 = 3; a = -a;'), /unary operator '-' is not supported yet/, 'codegen'],
    ['unary ~', P('let a: u8 = 3; a = ~a;'), /unary operator '~' is not supported yet/, 'codegen'],
    ['/ in a constant', P('const A: u8 = 8 / 2;'), /compile-time constant/, 'type'],
    ['for step +=', P('for (let i: u8 = 0; i < 8; i += 2) { }'), parseErr, 'parse'],
    ['for empty init', P('let i: u8 = 0; for (; i < 3; i++) { }'), parseErr, 'parse'],
    [
      'array indexing',
      P('buf[1] = 5;', 'let @zp buf: [u8; 4];'),
      /array indexing is not supported yet/,
      'codegen',
    ],
    ['block comment', P('/* hi */ VIC2.borderColor = 1;'), parseErr, 'parse'],
    [
      'recursion',
      'fn f(): void {\n  f();\n}\nprogram @ 0x0810 { f(); loop {} }',
      /called from within itself/,
      'type',
    ],
    [
      'f(f(1))',
      P('VIC2.borderColor = twice(twice(1));', 'fn twice(x: u8): u8 { return x + x; }'),
      /argument of 'twice' calls 'twice'/,
      'type',
    ],
  ];

  it.each(rows)('%s', (_name, source, message, kind) => {
    let caught: unknown;
    try {
      boot(source);
    } catch (err) {
      caught = err;
    }
    expect(caught, `expected a compile error for ${_name}`).toBeDefined();
    expect((caught as Error).message).toMatch(message);
    const ctor = (caught as Error).constructor.name;
    if (kind === 'parse') expect(['ParseError', 'LexError']).toContain(ctor);
    if (kind === 'codegen') expect(ctor).toBe('CodeGenError');
    if (kind === 'type') expect(ctor).toBe('TypeError');
  });
});

describe('the types table', () => {
  const start = html.indexOf('<h2 class="section-title">Types and annotations</h2>');
  const table = html.slice(start, html.indexOf('</table>', start));

  it('keeps a range on one line', () => {
    const ranges = [...table.matchAll(/<td[^>]*>([^<]*\d+ – \d+[^<]*)<\/td>/g)];
    expect(ranges.length).toBeGreaterThanOrEqual(2);
    for (const m of ranges) expect(m[0]).toMatch(/white-space:\s*nowrap/);
  });

  it('lists u8, u16 and bool', () => {
    for (const t of ['u8', 'u16', 'bool']) expect(table).toContain(`<code>${t}</code>`);
  });

  it('describes u16 as it behaves today (arithmetic and comparison are compile errors)', () => {
    expect(table).not.toMatch(/arithmetic on it is incomplete/);
    expect(table).toMatch(/compile error/);
  });
});

describe('named addresses', () => {
  it('the guide says constants work in address positions', () => {
    expect(html).toMatch(/Naming an address/);
    expect(text).toMatch(/program @ START/);
    expect(text).toMatch(/data @addr\(TABLE\)/);
  });

  it('the addresses sample does what its comments say', () => {
    const at = html.indexOf('addresses.c64s');
    const pre = html.slice(html.indexOf('<pre', at), html.indexOf('</pre>', at));
    const source = pre
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
    expect(source).toMatch(/counting down, so it ends on the first entry: red/);
    const c = boot(source, 3);
    expect(c.peek(0xd020) & 15).toBe(2); // COLOR_RED, shades[0]
    expect(c.peek(0x0c00)).toBe(2);
    expect(c.peek(0x0c03)).toBe(1);
  });

  it('what it promises is true', () => {
    // program and data addresses may use a constant declared anywhere; let @addr needs it above
    const c = boot('program @ START { loop {} }\nconst START: u16 = 0x0810;');
    expect(c.peek(0xd020) & 15).toBeGreaterThanOrEqual(0);
    expectError(
      'let @addr(LATER) cell: u8;\nconst LATER: u16 = 0x0400;\nprogram @ 0x0810 { loop {} }',
      'type',
      /@addr\(\.\.\.\) must be a compile-time constant/,
      1,
    );
  });
});

describe('16-bit values in the guide', () => {
  it('the sixteen-bit sample sums to 3000 and finishes', () => {
    const at = html.indexOf('sixteen-bit.c64s');
    expect(at).toBeGreaterThan(0);
    const pre = html.slice(html.indexOf('<pre', at), html.indexOf('</pre>', at));
    const src = pre
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
    const c = boot(src, 60);
    expect(c.peek(0x0900) | (c.peek(0x0901) << 8)).toBe(3000);
    expect(c.peek(0xd020) & 15).toBe(5);
  });
});

describe('computed addresses in the guide', () => {
  it('the diagonal sample fills the diagonal', () => {
    const at = html.indexOf('computed-address.c64s');
    expect(at).toBeGreaterThan(0);
    const pre = html.slice(html.indexOf('<pre', at), html.indexOf('</pre>', at));
    const src = pre
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
    const c = boot(src, 6);
    for (const r of [0, 7, 24]) {
      expect(c.peek(0x0400 + r * 40 + r)).toBe(0xa0);
      expect(c.peek(0xd800 + r * 40 + r) & 15).toBe(7);
    }
    expect(c.peek(0x0400 + 1)).not.toBe(0xa0);
  });
});
