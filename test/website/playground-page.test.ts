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

// The copy button lives inside the <pre> it copies, next to the Try-now link. Copying must
// return the code only, not the button labels ("copy", "▶ Try now").
describe('copy button', () => {
  const appJs = readFileSync('website/js/app.js', 'utf8');

  it('leaves its own label and the Try-now link out of the copied text', () => {
    expect(appJs).toMatch(/\.copy-btn,\s*\.try-now/);
  });
});

describe('usage docs', () => {
  const usage = readFileSync('website/usage.html', 'utf8');

  it('documents only C64 methods that exist', () => {
    expect(usage).not.toContain('peekRam');
    expect(usage).toContain('c64.peek(addr: number): number');
  });
});
