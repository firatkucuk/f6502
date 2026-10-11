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

// Sound showcases get a mute button in the control bar. It is hidden until the player reports it
// has sound, so the silent showcases do not show a dead button.
describe('showcase page mute button', () => {
  const page = readFileSync('website/showcase.html', 'utf8');
  const showcaseJs = readFileSync('website/js/showcase.js', 'utf8');
  const controls = readFileSync('website/js/emu-controls.js', 'utf8');
  const css = readFileSync('website/css/style.css', 'utf8');

  it('has a hidden mute button in the control bar', () => {
    const bar = page.slice(page.indexOf('class="emu-bar"'), page.indexOf('</main>'));
    expect(bar).toMatch(/<button[^>]*id="showcase-sound"[^>]*aria-label="Mute"[^>]*hidden/);
  });

  it('shows it only when the player has audio, and toggles the player mute', () => {
    expect(showcaseJs).toMatch(/soundBtn/);
    expect(controls).toMatch(/soundBtn && player\.hasAudio/);
    expect(controls).toMatch(/player\.muted = !player\.muted/);
  });

  it('lets the hidden attribute win over the button display rule', () => {
    expect(css).toMatch(/\.emu-bar button\[hidden\]\s*\{\s*display:\s*none/);
  });
});
