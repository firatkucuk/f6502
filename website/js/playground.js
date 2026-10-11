import { codeFromHash } from './code-hash.js';
import { renderLines } from './editor-render.js';
import { EXAMPLES } from './playground-examples.js';

const GRAMMAR = {
  comment: { pattern: /\/\/.*/, greedy: true },
  annotation: { pattern: /@(?:zp|inline|addr|0x[0-9a-fA-F]+)/, alias: 'attr-name' },
  keyword:
    /\b(?:program|fn|let|const|loop|while|for|if|else|break|continue|return|data|struct|hardware|asm)\b/,
  type: { pattern: /\b(?:u8|u16|bool|void)\b/, alias: 'class-name' },
  hardware: { pattern: /\b(?:VIC2|SID|CIA1|CIA2)\b/, alias: 'property' },
  constant: {
    pattern:
      /\b(?:BLACK|WHITE|RED|CYAN|PURPLE|GREEN|BLUE|YELLOW|ORANGE|BROWN|LIGHT_RED|DARK_GREY|MEDIUM_GREY|LIGHT_GREEN|LIGHT_BLUE|LIGHT_GREY)\b/,
    alias: 'boolean',
  },
  builtin: { pattern: /\b(?:poke|clrscr|lo|hi)\b/, alias: 'function' },
  number: /\b0x[0-9a-fA-F]+\b|\b\d+\b/,
  operator: /[-+*/=<>!&|^%]+/,
  punctuation: /[{}[\];(),.:]/,
};

const $ = (id) => document.getElementById(id);
const editor = $('editor');
const highlight = $('highlight');
const select = $('example-select');
const statusEl = $('status');
const canvas = $('emu-canvas');

let player = null;

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = `pg-status ${kind}`.trim();
}

function render(errorLine = 0) {
  // Without Prism (blocked CDN) the editor still works, just without colours.
  const highlighter = window.Prism
    ? (text) => window.Prism.highlight(text, GRAMMAR, 'c64script')
    : null;
  highlight.innerHTML = renderLines(editor.value, errorLine, highlighter);
  highlight.scrollTop = editor.scrollTop;
  highlight.scrollLeft = editor.scrollLeft;
}

function hex4(n) {
  return n.toString(16).toUpperCase().padStart(4, '0');
}

/** `focusScreen`: give the emulator keyboard focus (Run button), not when running from the editor. */
async function run(focusScreen = false) {
  if (!player) return;
  const source = editor.value.replace(/\r\n?/g, '\n');
  let prg;
  try {
    prg = window.F6502.compile(source);
  } catch (err) {
    const line = typeof err.line === 'number' ? err.line : 0;
    render(line);
    setStatus(err instanceof Error ? err.message : String(err), 'err');
    return; // keep the previous program running
  }
  render(0);
  try {
    player.reset();
    await player.load(new File([prg], 'play.prg'));
    const load = prg[0] | (prg[1] << 8);
    setStatus(`Compiled · ${prg.length - 2} bytes · loads at $${hex4(load)}`, 'ok');
    if (focusScreen) canvas.focus();
  } catch (err) {
    setStatus(`Could not start program: ${err instanceof Error ? err.message : err}`, 'err');
  }
}

function useSource(source) {
  // A trailing newline would show up as an empty numbered last line.
  editor.value = source.replace(/\n+$/, '');
  render(0);
}

function setup() {
  for (const ex of EXAMPLES) {
    const opt = document.createElement('option');
    opt.value = ex.id;
    opt.textContent = ex.title;
    select.append(opt);
  }
  const shared = codeFromHash(location.hash);
  if (shared !== null) {
    const custom = document.createElement('option');
    custom.value = '';
    custom.textContent = 'Shared sample';
    select.prepend(custom);
    select.value = '';
    useSource(shared);
  } else {
    select.value = EXAMPLES[0].id;
    useSource(EXAMPLES[0].source);
  }

  select.addEventListener('change', () => {
    const ex = EXAMPLES.find((e) => e.id === select.value);
    if (!ex) return;
    useSource(ex.source);
    run();
  });

  editor.addEventListener('input', () => render(0));
  editor.addEventListener('scroll', () => {
    highlight.scrollTop = editor.scrollTop;
    highlight.scrollLeft = editor.scrollLeft;
  });
  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      editor.setRangeText('  ', editor.selectionStart, editor.selectionEnd, 'end');
      render(0);
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      run();
    }
  });
  $('run-btn').addEventListener('click', () => run(true));
  $('reboot-btn').addEventListener('click', () => {
    if (!player) return;
    player.reset();
    setStatus('Machine rebooted. Press Run to start your program again.');
  });
}

async function main() {
  setup();
  if (!window.F6502 || typeof window.F6502.compile !== 'function') {
    setStatus('Emulator bundle missing or outdated. Run `npm run build`, then reload.', 'err');
    return;
  }
  try {
    player = await window.F6502.start({
      canvas,
      roms: {
        kernal: 'demos/kernal.bin',
        basic: 'demos/basic.bin',
        chargen: 'demos/chargen.bin',
      },
      scale: 'fit',
      audio: false,
    });
  } catch (err) {
    setStatus(`Could not start the emulator: ${err instanceof Error ? err.message : err}`, 'err');
    return;
  }
  setStatus('Ready.');
  await run();
}

main();
