// Builds the HTML for the playground's highlight overlay: one block per source line, with the
// failing line marked. Pure and DOM-free so it can be unit-tested.

export function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * @param {string} source
 * @param {number} errorLine 1-based line to mark, or 0 for none
 * @param {((line: string) => string) | null} highlighter returns HTML for one line; null = plain
 */
export function renderLines(source, errorLine, highlighter) {
  const lines = source.split('\n').map((text, i) => {
    let html;
    try {
      html = highlighter ? highlighter(text) : escapeHtml(text);
    } catch {
      html = escapeHtml(text);
    }
    return `<span class="ln${i + 1 === errorLine ? ' err' : ''}">${html || ' '}</span>`;
  });
  // Two spare lines so the overlay can always scroll as far as the textarea does.
  return lines.join('') + '<span class="ln"> </span><span class="ln"> </span>';
}
