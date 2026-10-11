import { tryNowUrl } from './code-hash.js';

// Adds a "Try now" icon button to every <pre data-try>, next to its copy button in the code
// block's title bar. The source is the block's own text, so the page keeps a single copy of each
// sample. Works from any page depth.
const playground = new URL('../playground.html', import.meta.url).href;

const ICON_PLAY =
  '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M5 3.2v9.6a.5.5 0 0 0 .76.43l7.6-4.8a.5.5 0 0 0 0-.86l-7.6-4.8A.5.5 0 0 0 5 3.2z"/></svg>';

/** The block's code, without UI that scripts inject into it (the button group). */
function sourceOf(pre) {
  const clone = pre.cloneNode(true);
  for (const extra of clone.querySelectorAll('.terminal-actions')) extra.remove();
  return clone.textContent.replace(/\s+$/, '') + '\n';
}

/** The title bar's button group (app.js creates it with the copy button), or a floating one. */
function actionsFor(pre) {
  const bar = pre.closest('.terminal')?.querySelector('.terminal-bar');
  let group = (bar ?? pre).querySelector(bar ? '.terminal-actions' : ':scope > .terminal-actions');
  if (!group) {
    group = document.createElement('span');
    group.className = bar ? 'terminal-actions' : 'terminal-actions floating';
    if (bar) bar.append(group);
    else {
      pre.style.position = 'relative';
      pre.prepend(group);
    }
  }
  return group;
}

for (const pre of document.querySelectorAll('pre[data-try]')) {
  const group = actionsFor(pre);
  if (group.querySelector('a.term-btn.try')) continue;
  const link = document.createElement('a');
  link.className = 'term-btn try';
  link.target = '_blank';
  link.rel = 'noopener';
  link.title = 'Try it in the playground';
  link.setAttribute('aria-label', 'Try it in the playground (opens in a new tab)');
  link.innerHTML = ICON_PLAY;
  link.href = tryNowUrl(sourceOf(pre), playground);
  group.prepend(link); // play first, copy second
}
