// Read-only review history: pure derivations (shared by the browser and
// node:test — no DOM here) plus a DOM renderer (added in the next task).
// Data source is GET /api/history; this module never mutates review state.

// 'resolved'            — an outcome file exists for this round
// 'processed-no-outcome'— no outcome, but the doc advanced past it (old-protocol
//                         agent, or drift): treat as done-but-unrecorded
// 'in-flight'           — no outcome and the doc has not advanced: still pending
export function roundState(round, currentVersion) {
  if (round.outcome) return 'resolved';
  if (round.docVersion != null && currentVersion != null && round.docVersion < currentVersion) {
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
