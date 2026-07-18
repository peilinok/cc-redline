// Overview ruler: a thin whole-document map on the far right. Heading and
// annotation positions become colored ticks; a box tracks the viewport; click
// or drag jumps. Positions are in #doc-pane content coordinates, same basis as
// the comment rail, so ticks line up with the scroll.
import { tocTargetEl } from './toc.mjs';

export function initRuler({ docPane, ruler, getMarkers, getParsed, getMode }) {
  let viewportEl = null;
  let raf = 0;

  const contentTop = (el) => {
    const rect = el.getBoundingClientRect();
    if (!rect.height && !rect.top) return null; // hidden (wrong mode)
    return rect.top - docPane.getBoundingClientRect().top + docPane.scrollTop;
  };

  function moveViewport() {
    if (!viewportEl) return;
    const h = ruler.clientHeight;
    const total = docPane.scrollHeight || 1;
    viewportEl.style.top = (docPane.scrollTop / total) * h + 'px';
    viewportEl.style.height = Math.max(14, (docPane.clientHeight / total) * h) + 'px';
  }

  function tick(className, y, h, total, title) {
    const el = document.createElement('div');
    el.className = className;
    el.style.top = (y / total) * h + 'px';
    if (title) el.title = title;
    ruler.appendChild(el);
  }

  function rebuild() {
    ruler.textContent = '';
    viewportEl = null;
    const h = ruler.clientHeight;
    const total = docPane.scrollHeight || 1;
    const parsed = getParsed();
    if (parsed) {
      const mode = getMode();
      for (const item of parsed.toc) {
        const el = tocTargetEl(item, mode);
        const y = el && contentTop(el);
        if (y != null) tick('ruler-tick heading', y, h, total, item.text);
      }
    }
    for (const m of getMarkers()) {
      tick(`ruler-tick ann scope-${m.scope}`, m.y, h, total, m.comment);
    }
    viewportEl = document.createElement('div');
    viewportEl.className = 'ruler-viewport';
    ruler.appendChild(viewportEl);
    moveViewport();
  }

  docPane.addEventListener('scroll', () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; moveViewport(); });
  }, { passive: true });

  let dragging = false;
  const jumpTo = (clientY) => {
    const rect = ruler.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    docPane.scrollTop = frac * docPane.scrollHeight - docPane.clientHeight / 2;
  };
  ruler.addEventListener('mousedown', (e) => { dragging = true; jumpTo(e.clientY); e.preventDefault(); });
  window.addEventListener('mousemove', (e) => { if (dragging) jumpTo(e.clientY); });
  window.addEventListener('mouseup', () => { dragging = false; });

  return { update: rebuild };
}
