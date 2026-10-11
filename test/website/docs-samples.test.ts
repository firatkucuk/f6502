import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../../src/c64script/index';

const ROOT = 'website';

function htmlFiles(): string[] {
  const out: string[] = [];
  for (const dir of [ROOT, join(ROOT, 'demos')]) {
    for (const f of readdirSync(dir)) if (f.endsWith('.html')) out.push(join(dir, f));
  }
  return out;
}

function decode(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

const blocks: Array<{ name: string; source: string }> = [];
for (const file of htmlFiles()) {
  const html = readFileSync(file, 'utf8');
  const re = /<pre\b[^>]*\bdata-try\b[^>]*>([\s\S]*?)<\/pre>/g;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(html))) blocks.push({ name: `${file}#${n++}`, source: decode(m[1]!) });
}

describe('website C64Script samples', () => {
  it('has Try-now blocks on the site', () => {
    expect(blocks.length).toBeGreaterThanOrEqual(5);
  });

  it.each(blocks.map((b) => [b.name, b.source] as const))('%s compiles', (_name, source) => {
    expect(() => compile(source)).not.toThrow();
  });

  it('no page documents the old dialect', () => {
    for (const file of htmlFiles()) {
      const text = decode(readFileSync(file, 'utf8'));
      expect(text, file).not.toMatch(/program\(0x[0-9a-fA-F]+\)/);
      expect(text, file).not.toMatch(/\bc64\.(border|background)\b/);
      expect(text, file).not.toMatch(/f6502\/c64script/);
    }
  });
});
