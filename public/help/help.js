'use strict';
// Help page: search, contents highlighting, and click-to-enlarge screenshots.
(() => {
  const sections = [...document.querySelectorAll('[data-s]')];
  const tocLinks = [...document.querySelectorAll('nav.toc a')];
  const q = document.getElementById('q');
  const none = document.getElementById('no-results');
  const originals = new Map(sections.map((s) => [s, s.innerHTML]));

  const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function highlight(root, re) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement.closest('script,style') || !re.test(n.nodeValue) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const n of nodes) {
      const span = document.createElement('span');
      span.innerHTML = n.nodeValue.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])).replace(re, (m) => `<mark>${m}</mark>`);
      n.replaceWith(...span.childNodes);
    }
  }

  function search() {
    const term = q.value.trim();
    let shown = 0;
    for (const s of sections) {
      s.innerHTML = originals.get(s);
      if (!term) { s.classList.remove('hidden'); continue; }
      const words = term.toLowerCase().split(/\s+/).filter(Boolean);
      const text = s.textContent.toLowerCase();
      const hit = words.every((w) => text.includes(w));
      s.classList.toggle('hidden', !hit);
      if (hit) {
        shown += 1;
        const re = new RegExp(`(${words.map(escapeRe).join('|')})`, 'gi');
        highlight(s, re);
        // Open FAQ answers that contain the search words; hide the rest.
        s.querySelectorAll('details').forEach((d) => {
          const match = words.every((w) => d.textContent.toLowerCase().includes(w));
          d.open = match; d.classList.toggle('hidden', !match);
        });
      }
    }
    none.style.display = term && !shown ? 'block' : 'none';
    bindZoom();
  }
  let t;
  q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(search, 150); });
  q.addEventListener('keydown', (e) => { if (e.key === 'Escape') { q.value = ''; search(); } });

  // Highlight the contents entry for the section on screen.
  const byId = new Map(tocLinks.map((a) => [a.getAttribute('href').slice(1), a]));
  const obs = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const a = byId.get(en.target.id);
      if (a) { tocLinks.forEach((x) => x.classList.remove('on')); a.classList.add('on'); }
    }
  }, { rootMargin: '-80px 0px -70% 0px' });
  document.querySelectorAll('main [id]').forEach((el) => { if (byId.has(el.id)) obs.observe(el); });

  // Click a screenshot to see it full size.
  function bindZoom() {
    document.querySelectorAll('figure img').forEach((img) => {
      img.onclick = () => {
        const z = document.createElement('div');
        z.className = 'zoom';
        z.innerHTML = `<img src="${img.getAttribute('src')}" alt="">`;
        z.onclick = () => z.remove();
        document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { z.remove(); document.removeEventListener('keydown', esc); } });
        document.body.appendChild(z);
      };
    });
  }
  bindZoom();

  // Opening a link like /help.html#verify from the app: make sure that FAQ entry is open.
  if (location.hash) {
    const el = document.getElementById(location.hash.slice(1));
    if (el && el.tagName === 'DETAILS') el.open = true;
  }
})();
