import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The showcase page never has keyboard focus on load, so its keys must come from the document.
// A canvas-only listener ignores SPACE, A and D until the user clicks the screen.
describe('showcase page keyboard input', () => {
  const showcaseJs = readFileSync('website/js/showcase.js', 'utf8');
  const showcaseList = readFileSync('website/js/showcase-list.js', 'utf8');

  it('starts the player with keyboardTarget document', () => {
    expect(showcaseJs).toMatch(/keyboardTarget:\s*'document'/);
  });

  it('does not tell the user to click the screen for keyboard focus', () => {
    expect(showcaseList).not.toMatch(/Click the screen/);
  });
});
