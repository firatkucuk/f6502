/* ── Navigation ──────────────────────────────────────────────── */
(function () {
  const nav = document.querySelector('.nav');
  const burger = document.querySelector('.nav-burger');
  const links = document.querySelector('.nav-links');

  /* active link */
  const path = location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav-links a').forEach((a) => {
    const href = a.getAttribute('href') || '';
    if (href === path || (path === '' && href === 'index.html')) {
      a.setAttribute('aria-current', 'page');
    }
  });

  /* mobile burger */
  if (burger && links) {
    burger.addEventListener('click', () => {
      const open = links.classList.toggle('open');
      burger.textContent = open ? '✕' : '☰';
      burger.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', (e) => {
      if (!nav.contains(e.target)) {
        links.classList.remove('open');
        burger.textContent = '☰';
        burger.setAttribute('aria-expanded', 'false');
      }
    });
  }

  /* scroll reveal */
  const observer = new IntersectionObserver(
    (entries) => entries.forEach((e) => e.isIntersecting && e.target.classList.add('visible')),
    { threshold: 0.12 },
  );
  document.querySelectorAll('.reveal').forEach((el) => observer.observe(el));

  /* copy buttons: a small icon button in the code block's title bar */
  const ICON_COPY =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">' +
    '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/>' +
    '<path d="M10.5 3.5v-.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h.5"/></svg>';
  const ICON_DONE =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
    '<path d="M3 8.5l3.2 3.2L13 4.8"/></svg>';

  /** The `.terminal-actions` group of `pre`'s window (created in its title bar), or a floating one. */
  function actionsFor(pre) {
    const bar = pre.closest('.terminal')?.querySelector('.terminal-bar');
    if (bar) {
      let group = bar.querySelector('.terminal-actions');
      if (!group) {
        group = document.createElement('span');
        group.className = 'terminal-actions';
        bar.append(group);
      }
      return group;
    }
    // A <pre> outside a terminal window: float the group in its top-right corner.
    let group = pre.querySelector(':scope > .terminal-actions');
    if (!group) {
      group = document.createElement('span');
      group.className = 'terminal-actions floating';
      pre.style.position = 'relative';
      pre.prepend(group);
    }
    return group;
  }

  document.querySelectorAll('pre:not([data-no-copy])').forEach((pre) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'term-btn copy';
    btn.setAttribute('aria-label', 'Copy code');
    btn.title = 'Copy code';
    btn.innerHTML = ICON_COPY;
    btn.addEventListener('click', () => {
      // A floating button group sits inside the <pre>: copy the code, not the buttons.
      const clone = pre.cloneNode(true);
      clone.querySelectorAll('.terminal-actions').forEach((el) => el.remove());
      navigator.clipboard.writeText(clone.textContent || '').then(() => {
        btn.innerHTML = ICON_DONE;
        btn.title = 'Copied';
        setTimeout(() => {
          btn.innerHTML = ICON_COPY;
          btn.title = 'Copy code';
        }, 1500);
      });
    });
    actionsFor(pre).append(btn);
  });
})();
