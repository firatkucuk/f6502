import { tryNowUrl } from './code-hash.js';
import { GRAMMAR } from './c64script-grammar.js';
import { EXAMPLES } from './playground-examples.js';

// The home page's "See it run" section: compile the slideshow example in the browser and run it
// on the emulator with the built-in stub ROMs, so a visitor sees a C64 working without loading
// anything. The same source is shown beside it, with a Try-now link into the playground.

const canvas = document.getElementById('slideshow-canvas');
const sourceEl = document.getElementById('slideshow-source');
const statusEl = document.getElementById('slideshow-status');
const tryLink = document.getElementById('slideshow-try');
const example = EXAMPLES.find((e) => e.id === 'slideshow');

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function showSource() {
  const code = example.source.replace(/\n+$/, '');
  sourceEl.innerHTML = window.Prism
    ? window.Prism.highlight(code, GRAMMAR, 'c64script')
    : escapeHtml(code);
  tryLink.href = tryNowUrl(example.source, new URL('../playground.html', import.meta.url).href);
}

async function run() {
  const f6502 = window.F6502;
  if (!f6502 || typeof f6502.compile !== 'function') {
    throw new Error('the emulator bundle is missing or out of date');
  }
  const prg = f6502.compile(example.source);
  const player = await f6502.start({
    canvas,
    roms: {
      kernal: 'demos/kernal.bin',
      basic: 'demos/basic.bin',
      chargen: 'demos/chargen.bin',
    },
    scale: 'fit',
    audio: false,
  });
  await player.load(new File([prg], 'slideshow.prg'));
  statusEl.textContent = `Compiled in your browser (${prg.length - 2} bytes) and running live.`;
}

if (canvas && sourceEl && example) {
  showSource();
  run().catch((err) => {
    console.error('[slideshow]', err);
    statusEl.textContent = `Could not start the demo here (${err.message}). Open it in the playground.`;
  });
}
