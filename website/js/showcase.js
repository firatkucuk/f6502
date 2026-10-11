import { tryNowUrl } from './code-hash.js';
import { GRAMMAR } from './c64script-grammar.js';
import { SHOWCASES } from './showcase-list.js';
import { wireEmuControls } from './emu-controls.js';

// showcase.html?id=<id>: fetch the program's C64Script source, compile it in the browser and run
// it on the emulator with the built-in stub ROMs, next to the highlighted code.

const params = new URLSearchParams(window.location.search);
const showcase = SHOWCASES.find((s) => s.id === params.get('id'));

const canvas = document.getElementById('showcase-canvas');
const sourceEl = document.getElementById('showcase-source');
const statusEl = document.getElementById('showcase-status');
const tryLink = document.getElementById('showcase-try');
const titleEl = document.getElementById('showcase-title');
const blurbEl = document.getElementById('showcase-blurb');
const fileEl = document.getElementById('showcase-file');
const hintEl = document.getElementById('showcase-hint');
const crtEl = document.getElementById('showcase-crt');
const pauseBtn = document.getElementById('showcase-pause');
const rebootBtn = document.getElementById('showcase-reboot');
const soundBtn = document.getElementById('showcase-sound');
const fullscreenBtn = document.getElementById('showcase-fullscreen');

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function showUnknown() {
  titleEl.textContent = 'Showcase not found';
  blurbEl.innerHTML = 'Pick one from the <a href="showcases.html">showcase list</a>.';
  statusEl.textContent = '';
}

async function run() {
  titleEl.textContent = showcase.title;
  blurbEl.textContent = showcase.blurb;
  hintEl.textContent = showcase.hint ?? '';
  fileEl.textContent = `${showcase.id}.c64s`;
  document.title = `${showcase.title} — f6502`;

  const response = await fetch(`showcases/${showcase.id}.c64s`);
  if (!response.ok) throw new Error(`could not load the source (${response.status})`);
  const source = await response.text();

  const code = source.replace(/\n+$/, '');
  sourceEl.innerHTML = window.Prism
    ? window.Prism.highlight(code, GRAMMAR, 'c64script')
    : escapeHtml(code);
  tryLink.href = tryNowUrl(source, new URL('playground.html', window.location.href).href);

  const f6502 = window.F6502;
  if (!f6502 || typeof f6502.compile !== 'function') {
    throw new Error('the emulator bundle is missing or out of date');
  }
  const prg = f6502.compile(source);
  const file = () => new File([prg], `${showcase.id}.prg`);
  const player = await f6502.start({
    canvas,
    roms: {
      kernal: 'demos/kernal.bin',
      basic: 'demos/basic.bin',
      chargen: 'demos/chargen.bin',
    },
    scale: 'fit',
    // Only the showcases that make sound ask for Web Audio; it starts at the first click or key.
    audio: showcase.sound === true,
    // Keys come from the document, not the canvas: the page has no focus when it loads, so a
    // canvas-only listener would ignore SPACE, A and D until the user clicked the screen.
    keyboardTarget: 'document',
  });
  await player.load(file());
  statusEl.textContent = `Compiled in your browser (${prg.length - 2} bytes) and running live.`;
  wireEmuControls({
    player,
    crt: crtEl,
    canvas,
    pauseBtn,
    rebootBtn,
    fullscreenBtn,
    soundBtn,
    reboot: async () => {
      try {
        player.reset();
        await player.load(file());
        statusEl.textContent = 'Rebooted and running the showcase again.';
      } catch (err) {
        console.error('[showcase]', err);
        statusEl.textContent = `Reboot failed (${err.message}).`;
      }
    },
  });
}

if (canvas && sourceEl) {
  if (showcase === undefined) showUnknown();
  else {
    run().catch((err) => {
      console.error('[showcase]', err);
      statusEl.textContent = `Could not start the demo here (${err.message}).`;
    });
  }
}
