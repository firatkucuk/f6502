import { tryNowUrl } from './code-hash.js';

// Adds a "Try now" link to every <pre data-try>. The source is the block's own text, so the
// page keeps a single copy of each sample. Works from any page depth.
const playground = new URL('../playground.html', import.meta.url).href;

/** The block's code, without UI that scripts inject into it (copy button, Try-now link). */
function sourceOf(pre) {
  const clone = pre.cloneNode(true);
  for (const extra of clone.querySelectorAll('button, a.try-now')) extra.remove();
  return clone.textContent.replace(/\s+$/, '') + '\n';
}

for (const pre of document.querySelectorAll('pre[data-try]')) {
  if (pre.querySelector('a.try-now')) continue;
  const link = document.createElement('a');
  link.className = 'try-now';
  link.textContent = '▶ Try now';
  link.target = '_blank';
  link.rel = 'noopener';
  link.href = tryNowUrl(sourceOf(pre), playground);
  // Sit directly after the copy button (both float right) so the two always line up.
  const copy = pre.querySelector('.copy-btn');
  if (copy) copy.after(link);
  else pre.prepend(link);
}
