import { parseDocument, diffChangedBlocks } from './blocks.mjs';
import { renderDocument } from './render.mjs';
import { renderToc, setupScrollSpy } from './toc.mjs';
import { connectEvents } from './sse.mjs';
import { initAnnotations } from './annotate.mjs';
import { initRuler } from './ruler.mjs';
import { initLang, setLang, getLang, applyStaticI18n, t } from './i18n.mjs';
import { initHistory, roundState, roundChangedDoc } from './history.mjs';

const els = {
  docName: document.getElementById('doc-name'),
  connDot: document.getElementById('conn-dot'),
  content: document.getElementById('content'),
  rawView: document.getElementById('raw-view'),
  toc: document.getElementById('toc'),
  banner: document.getElementById('banner'),
  docPane: document.getElementById('doc-pane'),
  rail: document.getElementById('rail'),
  ruler: document.getElementById('ruler'),
  navCounter: document.getElementById('nav-counter'),
  navPrev: document.getElementById('nav-prev'),
  navNext: document.getElementById('nav-next'),
  history: document.getElementById('history'),
};

initLang();
applyStaticI18n(document);
document.getElementById('btn-submit').textContent = t('btn.submit', { n: 0 }); // avoid a blank button before first render
const langSelect = document.getElementById('lang-select');
langSelect.value = getLang();
langSelect.addEventListener('change', () => setLang(langSelect.value));

function updateNavCounter({ index, total }) {
  els.navCounter.textContent = `${index} / ${total}`;
  els.navPrev.disabled = els.navNext.disabled = total === 0;
}

const state = { doc: null, parsed: null, mode: 'render' };

function setMode(mode) {
  state.mode = mode;
  document.body.dataset.mode = mode;
  for (const btn of document.querySelectorAll('[data-mode-btn]')) {
    btn.classList.toggle('active', btn.dataset.modeBtn === mode);
  }
  ann.reflow(); // rebuilds the rail + ruler for the new mode
  if (state.parsed) setupScrollSpy(els.docPane, els.toc, state.parsed.toc, mode);
}
for (const btn of document.querySelectorAll('[data-mode-btn]')) {
  btn.addEventListener('click', () => setMode(btn.dataset.modeBtn));
}

function showBanner(text, actions = []) {
  els.banner.textContent = '';
  const span = document.createElement('span');
  span.textContent = text;
  els.banner.appendChild(span);
  for (const [label, fn] of actions) {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', fn);
    els.banner.appendChild(b);
  }
  els.banner.hidden = false;
}
function hideBanner() {
  els.banner.hidden = true;
}

function renderRaw() {
  els.rawView.textContent = '';
  state.doc.content.split('\n').forEach((text, i) => {
    const row = document.createElement('div');
    row.className = 'raw-line';
    row.dataset.line = String(i + 1);
    const ln = document.createElement('span');
    ln.className = 'raw-ln';
    ln.textContent = String(i + 1);
    const tx = document.createElement('span');
    tx.className = 'raw-tx';
    tx.textContent = text;
    row.append(ln, tx);
    els.rawView.appendChild(row);
  });
}

function rerender() {
  state.parsed = parseDocument(state.doc.content);
  renderDocument(els.content, state.parsed);
  renderRaw(); // build raw lines before scroll-spy: raw mode observes them
  renderToc(els.toc, state.parsed.toc, () => state.mode);
  // #doc-pane is the scroll container; the observer roots on it, not #content
  setupScrollSpy(els.docPane, els.toc, state.parsed.toc, state.mode);
  ann.onDocRerendered();
  // async mermaid/KaTeX/image layout can shift anchor positions; realign once settled
  setTimeout(() => ann.reflow(), 350);
}

async function loadDoc() {
  const res = await fetch('/api/doc');
  state.doc = await res.json();
  els.docName.textContent = state.doc.file;
  document.title = `${t('app.title')}: ${state.doc.file}`;
  rerender();
}

async function refreshDoc() {
  hideBanner();
  const oldContent = state.doc ? state.doc.content : null;
  await loadDoc();
  if (oldContent !== null) markChanged(oldContent);
}

// Flash-highlight what a refresh changed (agent edits land this way): the
// new/modified blocks in Render, and their source lines in Raw.
function markChanged(oldContent) {
  for (const id of diffChangedBlocks(oldContent, state.parsed.blocks)) {
    const el = document.getElementById(id);
    if (el) el.classList.add('changed');
    const b = state.parsed.blocks.find((x) => x.id === id);
    if (!b) continue;
    for (let ln = b.startLine; ln <= b.endLine; ln++) {
      const row = els.rawView.querySelector(`.raw-line[data-line="${ln}"]`);
      if (row) row.classList.add('changed');
    }
  }
}

let ruler; // overview ruler; created after `ann` because it reads ann.getMarkers
const ann = initAnnotations({
  contentEl: els.content,
  rawViewEl: els.rawView,
  docPane: els.docPane,
  rail: els.rail,
  globalBtn: document.getElementById('btn-global'),
  submitBtn: document.getElementById('btn-submit'),
  doneBtn: document.getElementById('btn-done'),
  selectionBtn: document.getElementById('selection-btn'),
  popover: {
    root: document.getElementById('popover'),
    target: document.getElementById('popover-target'),
    text: document.getElementById('popover-text'),
    save: document.getElementById('popover-save'),
    cancel: document.getElementById('popover-cancel'),
  },
  getDoc: () => state.doc,
  getParsed: () => state.parsed,
  onSubmitted: () => showBanner(t('banner.submitted')),
  onDone: () => showBanner(t('banner.done')),
  onReflow: () => ruler && ruler.update(),
  onNav: updateNavCounter,
});

ruler = initRuler({
  docPane: els.docPane,
  ruler: els.ruler,
  getMarkers: () => ann.getMarkers(),
  getParsed: () => state.parsed,
  getMode: () => state.mode,
});

const hist = initHistory({ historyEl: els.history });
let lastHistory = null;

async function refreshHistory() {
  let data;
  try {
    data = await (await fetch('/api/history')).json();
  } catch {
    return null; // transient; the next event or reconnect reconciles
  }
  lastHistory = data;
  hist.render(data);
  // /api/history is the source of truth for unlocking: any round that is no
  // longer in flight releases its batch, even if its SSE outcome was missed.
  for (const r of data.rounds) {
    if (roundState(r, data.currentVersion) !== 'in-flight') ann.consumeSubmitted(r.seq);
  }
  return data;
}

window.addEventListener('cc-redline:langchange', () => {
  applyStaticI18n(document); // topbar + popover + #content handles (data-i18n-label)
  ann.reflow();              // rebuild rail cards / scope labels in the new language
  if (lastHistory) hist.render(lastHistory); // history panel is rendered via t(), not data-i18n
});

// Prev/next annotation navigation: topbar buttons + N (next) / P (prev) keys.
els.navPrev.addEventListener('click', () => ann.navigate(-1));
els.navNext.addEventListener('click', () => ann.navigate(1));
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target instanceof Element && e.target.closest('input, textarea, select')) return;
  if (!document.getElementById('popover').hidden) return; // don't hijack while editing
  if (e.key === 'n' || e.key === 'N') { e.preventDefault(); ann.navigate(1); }
  else if (e.key === 'p' || e.key === 'P') { e.preventDefault(); ann.navigate(-1); }
});

// Raw view: double-click a source line to annotate exactly that line.
els.rawView.addEventListener('dblclick', (e) => {
  const row = e.target instanceof Element ? e.target.closest('.raw-line') : null;
  if (!row) return;
  ann.annotateLine(Number(row.dataset.line), { x: e.clientX, y: e.clientY });
});

// Topbar: global comment + hide-all-annotations toggle.
document.getElementById('btn-global').addEventListener('click', () => ann.editGlobal());
const hlBtn = document.getElementById('btn-hl-toggle');
hlBtn.addEventListener('click', () => {
  const hidden = document.body.classList.toggle('ann-hidden');
  hlBtn.classList.toggle('active', hidden);
  hlBtn.textContent = hidden ? t('btn.show') : t('btn.hide');
});

// Re-align the rail when the layout width changes.
let reflowTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(reflowTimer);
  reflowTimer = setTimeout(() => ann.reflow(), 150);
});

connectEvents({
  onDocChanged: () => {
    // Only re-renders. Unlocking is handled by refreshHistory()'s reconciliation.
    refreshHistory();
    if (ann.hasPending()) {
      // Never auto-rerender over unsubmitted draft annotations.
      showBanner(t('banner.docChanged'), [
        [t('banner.refreshNow'), () => { ann.discardPending(); refreshDoc(); }],
        [t('banner.later'), () => showBanner(t('banner.docChangedSoft'), [
          [t('banner.refresh'), () => { ann.discardPending(); refreshDoc(); }],
        ])],
      ]);
      return;
    }
    refreshDoc();
  },
  onOutcome: async ({ seq }) => {
    const data = await refreshHistory(); // releases this round (and any other settled one)
    const round = data && data.rounds.find((r) => r.seq === seq);
    if (ann.hasSubmittedInFlight()) { showBanner(t('banner.inflight')); return; }
    const changed = round ? roundChangedDoc(round) : null;
    // Never gate the banner on a doc-changed that may never come (no-op edit,
    // agent crash): settle it here, and let refreshDoc() clear it if one arrives.
    showBanner(changed === false ? t('banner.roundNoChange') : t('banner.roundApplied'));
  },
  onHello: () => refreshHistory(), // (re)connect reconciliation: self-heals a missed outcome
  onStatus: (ok) => els.connDot.classList.toggle('ok', ok),
});

setMode('render');
await loadDoc();
await refreshHistory();
