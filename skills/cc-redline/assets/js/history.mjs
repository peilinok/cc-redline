// Read-only review history: pure derivations (shared by the browser and
// node:test — no DOM here) plus a DOM renderer (added in the next task).
// Data source is GET /api/history; this module never mutates review state.

import { t } from './i18n.mjs';

// 'resolved'            — an outcome file exists for this round
// 'processed-no-outcome'— the agent consumed the round (submission renamed to
//                         .consumed) and the doc advanced past it, but wrote no
//                         outcome (old-protocol agent, or drift): treat as
//                         done-but-unrecorded
// 'in-flight'           — not yet consumed, or consumed but the doc has not
//                         advanced past it: still pending
//
// `consumed` matters because `docVersion` is the *client's* document version at
// submit time — it says nothing about whether the agent ever picked the round up.
// Without it, a second round queued while the agent is still on the first would
// satisfy `docVersion < currentVersion` the moment the first round's edit lands,
// and get misreported as processed before the agent has even seen it.
export function roundState(round, currentVersion) {
  if (round.outcome) return 'resolved';
  if (round.consumed && round.docVersion != null && currentVersion != null && round.docVersion < currentVersion) {
    return 'processed-no-outcome';
  }
  return 'in-flight';
}

// Per-annotation outcome, matched by (round, id). Missing/unrecognised → unknown:
// results and annotations are deliberately not a bijection (the agent only reports
// what it acted on), so "no entry" must read as neutral, never as skipped.
export function annotationResult(round, annId) {
  const results = round.outcome && Array.isArray(round.outcome.results) ? round.outcome.results : null;
  const r = results ? results.find((x) => x.id === annId) : null;
  if (!r) return { status: 'unknown', note: '' };
  const status = r.status === 'applied' || r.status === 'skipped' ? r.status : 'unknown';
  return { status, note: typeof r.note === 'string' ? r.note : '' };
}

// Did this round change the document? Derived from results, so no separate
// docChanged field is needed. null = unknown (no outcome).
export function roundChangedDoc(round) {
  const o = round.outcome;
  if (!o) return null;
  const anyApplied = Array.isArray(o.results) && o.results.some((r) => r.status === 'applied');
  const globalApplied = o.globalComment && o.globalComment.status === 'applied';
  return !!(anyApplied || globalApplied);
}

const STATUS_BADGE = { applied: '✓', skipped: '⊘', unknown: '—' };
const SCOPE_KEY = { block: 'scope.block', section: 'scope.section', selection: 'scope.selection', line: 'scope.line' };

// First 3 source lines of the quoted anchor, ellipsised — enough to tell which
// part of the (possibly since-rewritten) document a past annotation pointed at.
function excerpt3(text) {
  const lines = String(text || '').split('\n');
  const head = lines.slice(0, 3).join('\n');
  return lines.length > 3 ? head + '\n…' : head;
}

// Renders read-only history rounds into `historyEl`. Cards never re-anchor to the
// (edited) document — history is an archive, not a live overlay.
export function initHistory({ historyEl }) {
  const head = historyEl.querySelector('#history-head');
  const list = historyEl.querySelector('#history-rounds');

  function card({ status, scope, comment, quoted, note }) {
    const el = document.createElement('div');
    el.className = 'history-card status-' + status;
    const top = document.createElement('div');
    top.className = 'history-card-head';
    const badge = document.createElement('span');
    badge.className = 'history-badge';
    badge.textContent = STATUS_BADGE[status] || '—';
    badge.title = t('history.status.' + status);
    top.append(badge);
    if (scope) {
      const sc = document.createElement('span');
      sc.className = 'history-scope';
      sc.textContent = SCOPE_KEY[scope] ? t(SCOPE_KEY[scope]) : scope;
      top.append(sc);
    }
    const cm = document.createElement('span');
    cm.className = 'history-card-comment';
    cm.textContent = comment;
    top.append(cm);
    el.append(top);
    if (quoted) {
      const ex = document.createElement('div');
      ex.className = 'history-excerpt';
      ex.textContent = excerpt3(quoted);
      el.append(ex);
    }
    if (note) {
      const n = document.createElement('div');
      n.className = 'history-card-note';
      n.textContent = note;
      el.append(n);
    }
    return el;
  }

  function render(data) {
    const all = data && Array.isArray(data.rounds) ? data.rounds : [];
    const currentVersion = data ? data.currentVersion : null;
    const rounds = all.slice().reverse(); // newest first
    const doneCount = all.filter((r) => roundState(r, currentVersion) !== 'in-flight').length;
    historyEl.hidden = doneCount === 0;
    head.textContent = t('history.title', { n: doneCount });
    list.textContent = '';
    rounds.forEach((round, i) => {
      const st = roundState(round, currentVersion);
      const details = document.createElement('details');
      details.className = 'history-round state-' + st;
      if (i === 0) details.open = true; // newest expanded
      const summary = document.createElement('summary');
      const title = document.createElement('span');
      title.className = 'history-round-title';
      title.textContent = t('history.round', { seq: round.seq });
      summary.append(title);
      if (st !== 'resolved') {
        const tag = document.createElement('span');
        tag.className = 'history-round-tag';
        tag.textContent = st === 'processed-no-outcome' ? t('history.state.processed') : t('history.state.inflight');
        summary.append(tag);
      }
      details.append(summary);
      for (const a of round.annotations) {
        const r = annotationResult(round, a.id);
        details.append(card({ status: r.status, scope: a.scope, comment: a.comment || '', quoted: a.quotedSource, note: r.note }));
      }
      // A round may be global-only (zero annotations) or also carry a global comment.
      if (round.globalComment) {
        const gr = round.outcome && round.outcome.globalComment ? round.outcome.globalComment : null;
        const status = gr && (gr.status === 'applied' || gr.status === 'skipped') ? gr.status : 'unknown';
        details.append(card({ status, scope: null, comment: t('history.global') + ': ' + round.globalComment, quoted: null, note: gr ? gr.note : '' }));
      }
      list.append(details);
    });
  }

  head.addEventListener('click', () => historyEl.classList.toggle('collapsed'));
  return { render };
}
