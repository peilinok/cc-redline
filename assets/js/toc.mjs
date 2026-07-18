// Section directory: heading tree with click-to-jump and scroll spy.
// Works in both modes — a heading maps to its rendered block (render) or its
// source line (raw).
let observer = null;

// The element a TOC entry points at in the current mode.
export function tocTargetEl(item, mode) {
  return mode === 'raw'
    ? document.querySelector(`#raw-view .raw-line[data-line="${item.startLine}"]`)
    : document.getElementById(item.blockId);
}

export function renderToc(nav, toc, getMode) {
  nav.textContent = '';
  for (const item of toc) {
    const a = document.createElement('a');
    a.className = `toc-item depth-${item.depth}`;
    a.href = '#' + item.blockId;
    a.dataset.blockId = item.blockId;
    a.textContent = item.text;
    a.title = item.text;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      tocTargetEl(item, getMode())?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    nav.appendChild(a);
  }
}

export function setupScrollSpy(scrollRoot, nav, toc, mode) {
  observer?.disconnect();
  const targets = [];
  for (const t of toc) {
    const el = tocTargetEl(t, mode);
    if (el) { el.__tocBlockId = t.blockId; targets.push(el); }
  }
  if (!targets.length) return;
  const setActive = (blockId) => {
    for (const a of nav.querySelectorAll('.toc-item')) {
      a.classList.toggle('active', a.dataset.blockId === blockId);
    }
  };
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) setActive(entry.target.__tocBlockId);
      }
    },
    { root: scrollRoot, rootMargin: '0px 0px -75% 0px' },
  );
  targets.forEach((el) => observer.observe(el));
  setActive(targets[0].__tocBlockId);
}
