import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// website/js/app.js prepends a copy button into every <pre> and sets `position: relative` inline.
// The playground's highlight overlay is a <pre> that must stay `position: absolute` to scroll in
// step with the textarea, so it has to opt out.
describe('playground highlight overlay', () => {
  const appJs = readFileSync('website/js/app.js', 'utf8');
  const page = readFileSync('website/playground.html', 'utf8');

  it('opts out of the copy-button script', () => {
    expect(page).toMatch(/<pre[^>]*id="highlight"[^>]*data-no-copy/);
  });

  it('app.js skips elements marked data-no-copy', () => {
    expect(appJs).toMatch(/pre:not\(\[data-no-copy\]\)/);
  });
});

// Copy and Try-now are small icon buttons in the code block's title bar. They must never end up
// in the copied text (the fallback for a <pre> outside a terminal floats inside it).
describe('code block buttons', () => {
  const appJs = readFileSync('website/js/app.js', 'utf8');
  const tryNow = readFileSync('website/js/try-now.js', 'utf8');
  const css = readFileSync('website/css/style.css', 'utf8');
  const index = readFileSync('website/index.html', 'utf8');

  it('the copy button goes into the title bar and is left out of the copied text', () => {
    expect(appJs).toMatch(/terminal-bar/);
    expect(appJs).toMatch(/terminal-actions/);
    expect(appJs).toMatch(/querySelectorAll\('\.terminal-actions'\)/);
  });

  it('the Try-now button joins the same group, and is left out of the encoded source', () => {
    expect(tryNow).toMatch(/terminal-actions/);
    expect(tryNow).toMatch(/\.terminal-actions/);
  });

  it('the home page slideshow has its Try-now button in the title bar', () => {
    const bar = index.slice(
      index.indexOf('slideshow.c64s') - 400,
      index.indexOf('terminal-body slideshow-source'),
    );
    expect(bar).toMatch(/terminal-actions/);
    expect(bar).toMatch(/id="slideshow-try"/);
  });

  it('styles the icon buttons', () => {
    expect(css).toMatch(/\.terminal-actions\s*\{/);
    expect(css).toMatch(/\.term-btn\s*\{/);
  });
});

describe('usage docs', () => {
  const usage = readFileSync('website/usage.html', 'utf8');

  it('documents only C64 methods that exist', () => {
    expect(usage).not.toContain('peekRam');
    expect(usage).toContain('c64.peek(addr: number): number');
  });
});
