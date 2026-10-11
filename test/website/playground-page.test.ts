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
