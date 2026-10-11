// The pause / reboot / fullscreen buttons under an emulator screen (showcase and playground).
//
// `reboot` is the page's own reboot: the showcase resets and loads its program again, the
// playground only resets the machine. Pause, resume and fullscreen are the same everywhere.

/**
 * @param {object} opts
 * @param {{ running: boolean, pause(): void, resume(): void }} opts.player
 * @param {HTMLElement} opts.crt        the element that goes fullscreen (screen and bar)
 * @param {HTMLCanvasElement} opts.canvas
 * @param {HTMLButtonElement} opts.pauseBtn
 * @param {HTMLButtonElement} opts.rebootBtn
 * @param {HTMLButtonElement} opts.fullscreenBtn
 * @param {() => Promise<void>} opts.reboot
 * @returns {{ sync(): void }} `sync` re-reads the pause button state after the page resumes the player
 */
export function wireEmuControls({
  player,
  crt,
  canvas,
  pauseBtn,
  rebootBtn,
  fullscreenBtn,
  reboot,
}) {
  const setLabel = (btn, label, pressed) => {
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-pressed', String(pressed));
  };
  const sync = () => setLabel(pauseBtn, player.running ? 'Pause' : 'Resume', !player.running);

  pauseBtn.disabled = false;
  rebootBtn.disabled = false;
  sync();

  pauseBtn.addEventListener('click', () => {
    if (player.running) player.pause();
    else player.resume();
    sync();
  });

  rebootBtn.addEventListener('click', async () => {
    rebootBtn.disabled = true;
    try {
      await reboot();
      // A paused machine would show a frozen frame, so a reboot always runs it again.
      if (!player.running) player.resume();
      sync();
    } finally {
      rebootBtn.disabled = false;
    }
  });

  if (!document.fullscreenEnabled || typeof crt.requestFullscreen !== 'function') {
    fullscreenBtn.hidden = true;
    return { sync };
  }
  fullscreenBtn.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else crt.requestFullscreen();
  });
  document.addEventListener('fullscreenchange', () => {
    const on = Boolean(document.fullscreenElement);
    setLabel(fullscreenBtn, on ? 'Exit fullscreen' : 'Fullscreen', on);
    if (on) canvas.focus(); // keys go to the emulator, not to whatever had focus on the page
  });
  return { sync };
}
