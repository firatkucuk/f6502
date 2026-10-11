/* ── C64 Emulator Demo ───────────────────────────────────────── */
(function () {
  const ROM_KEYS = ['kernal', 'basic', 'chargen'];
  const LS_PREFIX = 'f6502_rom_';

  /* ---------- local storage helpers ---------- */
  function saveRom(name, ab) {
    try {
      const b64 = btoa(String.fromCharCode(...new Uint8Array(ab)));
      localStorage.setItem(LS_PREFIX + name, b64);
    } catch (_) {
      /* storage full or unavailable */
    }
  }

  function loadRomFromStorage(name) {
    try {
      const b64 = localStorage.getItem(LS_PREFIX + name);
      if (!b64) return null;
      const bin = atob(b64);
      const ab = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) ab[i] = bin.charCodeAt(i);
      return ab.buffer;
    } catch (_) {
      return null;
    }
  }

  /* ---------- DOM refs ---------- */
  const loader = document.getElementById('rom-loader');
  const canvas = document.getElementById('c64-canvas');
  const statusEl = document.getElementById('rom-status');
  const btnLoad = document.getElementById('btn-load-roms');
  const fileInput = document.getElementById('rom-file-input');
  const btnPause = document.getElementById('btn-pause');
  const btnReset = document.getElementById('btn-reset');
  const btnPrg = document.getElementById('btn-load-prg');
  const prgInput = document.getElementById('prg-file-input');
  const led = document.getElementById('crt-led');

  if (!canvas || !loader) return; /* not on the demo page */

  let player = null;
  let paused = false;

  /* ---------- collect ROMs (from files or localStorage) ---------- */
  async function startEmulator(roms) {
    loader.style.display = 'none';
    if (led) led.style.display = 'block';

    if (!window.F6502) {
      setStatus('f6502.min.js not loaded');
      loader.style.display = '';
      return;
    }

    try {
      player = await F6502.start({
        canvas: canvas,
        roms,
        scale: 'fit',
        keyboardTarget: 'canvas',
        audio: true,
      });
      if (btnPause) btnPause.disabled = false;
      if (btnReset) btnReset.disabled = false;
      if (btnPrg) btnPrg.disabled = false;
    } catch (err) {
      loader.style.display = '';
      setStatus('Error: ' + (err.message || err));
    }
  }

  function setStatus(msg) {
    if (statusEl) statusEl.textContent = msg;
  }

  /* ---------- try loading from localStorage on page load ---------- */
  const cached = {};
  let allCached = true;
  for (const k of ROM_KEYS) {
    const ab = loadRomFromStorage(k);
    if (ab) {
      cached[k] = ab;
    } else {
      allCached = false;
    }
  }

  if (allCached) {
    setStatus('ROMs loaded from cache…');
    startEmulator(cached);
  }

  /* ---------- file upload flow ---------- */
  if (btnLoad && fileInput) {
    btnLoad.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const files = Array.from(fileInput.files || []);
      if (!files.length) return;

      const roms = {};
      const names = files.map((f) => f.name.toLowerCase());

      setStatus('Reading files…');

      for (const f of files) {
        const n = f.name.toLowerCase();
        const ab = await f.arrayBuffer();
        if (n.includes('kernal')) {
          roms.kernal = ab;
          saveRom('kernal', ab);
        } else if (n.includes('basic')) {
          roms.basic = ab;
          saveRom('basic', ab);
        } else if (n.includes('char')) {
          roms.chargen = ab;
          saveRom('chargen', ab);
        }
      }

      const missing = ROM_KEYS.filter((k) => !roms[k]);
      if (missing.length) {
        setStatus('Missing: ' + missing.join(', ') + '. Need kernal, basic, chargen.');
        return;
      }

      setStatus('Starting emulator…');
      await startEmulator(roms);
    });
  }

  /* ---------- controls ---------- */
  if (btnPause) {
    btnPause.addEventListener('click', () => {
      if (!player) return;
      if (paused) {
        player.resume();
        paused = false;
        btnPause.textContent = 'Pause';
      } else {
        player.pause();
        paused = true;
        btnPause.textContent = 'Resume';
      }
    });
  }

  if (btnReset) {
    btnReset.addEventListener('click', () => {
      if (!player) return;
      player.reset();
      if (paused) {
        player.resume();
        paused = false;
        if (btnPause) btnPause.textContent = 'Pause';
      }
    });
  }

  if (btnPrg && prgInput) {
    btnPrg.addEventListener('click', () => prgInput.click());
    prgInput.addEventListener('change', async () => {
      const f = prgInput.files?.[0];
      if (!f || !player) return;
      try {
        await player.load(f);
      } catch (err) {
        alert('Load error: ' + (err.message || err));
      }
    });
  }
})();
