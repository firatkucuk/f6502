import { tryNowUrl } from './code-hash.js';

// Adds a "Try now" link to every <pre data-try>. The source is the block's own text, so the
// page keeps a single copy of each sample. Works from any page depth.
const playground = new URL('../playground.html', import.meta.url).href;

/** The block's code, without UI that other scripts inject into it (the copy button). */
function sourceOf(pre) {
  const clone = pre.cloneNode(true);
  for (const extra of clone.querySelectorAll('button')) extra.remove();
  return clone.textContent.replace(/\s+$/, '') + '\n';
}

for (const pre of document.querySelectorAll('pre[data-try]')) {
  const host = pre.parentElement;
  if (!host || host.querySelector(':scope > .try-now')) continue;
  const link = document.createElement('a');
  link.className = 'try-now';
  link.textContent = '▶ Try now';
  link.target = '_blank';
  link.rel = 'noopener';
  link.href = tryNowUrl(sourceOf(pre), playground);
  host.classList.add('try-now-host');
  host.append(link);
}
