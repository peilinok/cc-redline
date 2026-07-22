import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roundState, annotationResult, roundChangedDoc } from '../../assets/js/history.mjs';

test('roundState: resolved when an outcome exists', () => {
  assert.equal(roundState({ outcome: { results: [] }, docVersion: 1 }, 3), 'resolved');
});
test('roundState: processed-no-outcome when consumed and doc advanced past the round', () => {
  assert.equal(roundState({ outcome: null, docVersion: 1, consumed: true }, 3), 'processed-no-outcome');
});
test('roundState: in-flight when not consumed, even though the doc advanced past the round', () => {
  // Regression: docVersion is the client's version at submit time, not proof the
  // agent ever picked the round up. A round queued while the agent is still
  // working an earlier one must not be reported processed just because that
  // earlier round's edit advanced the document.
  assert.equal(roundState({ outcome: null, docVersion: 1, consumed: false }, 3), 'in-flight');
});
test('roundState: in-flight when no outcome and doc has not advanced', () => {
  assert.equal(roundState({ outcome: null, docVersion: 3 }, 3), 'in-flight');
});
test('roundState: in-flight when docVersion is unknown', () => {
  assert.equal(roundState({ outcome: null, docVersion: null }, 3), 'in-flight');
});

test('annotationResult: matches by id', () => {
  const round = { outcome: { results: [{ id: 'a1', status: 'applied', note: 'ok' }] } };
  assert.deepEqual(annotationResult(round, 'a1'), { status: 'applied', note: 'ok' });
});
test('annotationResult: missing id in a resolved round → unknown', () => {
  const round = { outcome: { results: [{ id: 'a1', status: 'applied' }] } };
  assert.deepEqual(annotationResult(round, 'a2'), { status: 'unknown', note: '' });
});
test('annotationResult: unrecognised status → unknown, note preserved', () => {
  const round = { outcome: { results: [{ id: 'a1', status: 'weird', note: 'n' }] } };
  assert.deepEqual(annotationResult(round, 'a1'), { status: 'unknown', note: 'n' });
});

test('roundChangedDoc: true when any annotation applied', () => {
  assert.equal(roundChangedDoc({ outcome: { results: [{ id: 'a1', status: 'skipped' }, { id: 'a2', status: 'applied' }] } }), true);
});
test('roundChangedDoc: true when globalComment applied', () => {
  assert.equal(roundChangedDoc({ outcome: { results: [], globalComment: { status: 'applied' } } }), true);
});
test('roundChangedDoc: false when all skipped and no global apply', () => {
  assert.equal(roundChangedDoc({ outcome: { results: [{ id: 'a1', status: 'skipped' }] } }), false);
});
test('roundChangedDoc: null when no outcome', () => {
  assert.equal(roundChangedDoc({ outcome: null }), null);
});
