import { describe, expect, it } from 'vitest';
import { escapeHtml, renderLines } from '../../website/js/editor-render.js';

describe('editor-render', () => {
  it('escapes HTML when no highlighter is available (Prism blocked)', () => {
    const html = renderLines('a < b && c > d\n// <img src=x onerror=1>', 0, null);
    expect(html).not.toContain('<img');
    expect(html).toContain('a &lt; b &amp;&amp; c &gt; d');
  });

  it('marks the error line and only that line', () => {
    const html = renderLines('one\ntwo\nthree', 2, null);
    expect(html).toContain('<span class="ln err">two</span>');
    expect(html).toContain('<span class="ln">one</span>');
    expect(html).toContain('<span class="ln">three</span>');
  });

  it('uses the highlighter output for each line when given one', () => {
    const html = renderLines('x\ny', 0, (t: string) => `<b>${t}</b>`);
    expect(html).toContain('<span class="ln"><b>x</b></span>');
    expect(html).toContain('<span class="ln"><b>y</b></span>');
  });

  it('falls back to escaping when the highlighter throws', () => {
    const html = renderLines('<x>', 0, () => {
      throw new Error('boom');
    });
    expect(html).toContain('&lt;x&gt;');
  });

  it('numbers only real source lines: the scroll padding is marked and not counted', () => {
    const html = renderLines('a\nb', 0, null);
    expect(html.match(/<span class="ln">/g)).toHaveLength(2);
    expect(html.match(/<span class="ln pad">/g)).toHaveLength(2);
  });

  it('keeps empty lines at full height', () => {
    expect(renderLines('', 0, null)).toContain('<span class="ln"> </span>');
  });

  it('escapeHtml handles the three characters that matter', () => {
    expect(escapeHtml('<&>')).toBe('&lt;&amp;&gt;');
  });
});
