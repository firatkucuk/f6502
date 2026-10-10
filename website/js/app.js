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
    { threshold: 0.12 }
  );
  document.querySelectorAll('.reveal').forEach((el) => observer.observe(el));

  /* copy buttons */
  document.querySelectorAll('pre').forEach((pre) => {
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.textContent = 'copy';
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(pre.textContent || '').then(() => {
        btn.textContent = 'copied!';
        setTimeout(() => (btn.textContent = 'copy'), 1500);
      });
    });
    pre.style.position = 'relative';
    pre.prepend(btn);
  });
})();
