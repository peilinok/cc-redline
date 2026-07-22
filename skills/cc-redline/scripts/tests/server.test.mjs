import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssr-server-'));
  const docDir = path.join(root, 'docs');
  fs.mkdirSync(docDir);
  const md = path.join(docDir, 'doc.md');
  fs.writeFileSync(md, '# 标题\n\n正文。\n');
  fs.writeFileSync(path.join(docDir, 'pic.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'top-secret');
  return { root, docDir, md, stateDir: path.join(root, 'state') };
}

async function listen(t, opts) {
  const app = createApp(opts);
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => app.server.close(r)));
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}

// Write `content`, then wait for the server to observe the change.
//
// fs.watchFile polls stat and compares each poll to the PREVIOUS one; libuv's
// first (baseline) stat lands only after the first interval, so on a loaded
// runner the edit can slip in before the baseline — the baseline then records
// the already-edited file and, with nothing changing afterwards, the change is
// never seen (the historical flake). We defend by re-touching mtime each round
// with a strictly-increasing value: consecutive polls always differ, so the
// change is caught regardless of when the baseline stat happens. `content` is
// written once and stays constant, so the server broadcasts exactly once (the
// first poll where it reads new content != its cached content). `check` returns
// the awaited value (truthy) once satisfied, else null.
async function editAndAwait(md, content, check, timeoutMs = 12000, stepMs = 200) {
  fs.writeFileSync(md, content);
  const deadline = Date.now() + timeoutMs;
  let bump = 0;
  while (Date.now() < deadline) {
    const t = new Date(Date.now() + ++bump * 1000); // strictly increasing mtime
    try { fs.utimesSync(md, t, t); } catch { /* file briefly busy; retry next round */ }
    await new Promise((r) => setTimeout(r, stepMs));
    const v = await check();
    if (v != null) return v;
  }
  return null;
}

test('GET /api/doc returns content and version 1', async (t) => {
  const { md, stateDir } = setup();
  const { base } = await listen(t, { file: md, stateDir });
  const res = await fetch(base + '/api/doc');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.version, 1);
  assert.match(body.content, /标题/);
  assert.equal(path.resolve(body.file), path.resolve(md));
});

test('doc-assets serves doc-dir files and blocks traversal', async (t) => {
  const { md, stateDir } = setup();
  const { base } = await listen(t, { file: md, stateDir });
  const ok = await fetch(base + '/doc-assets/pic.svg');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/svg+xml');
  for (const evil of ['/doc-assets/..%5Csecret.txt', '/doc-assets/..%2Fsecret.txt', '/doc-assets/%2e%2e/secret.txt']) {
    const res = await fetch(base + evil);
    assert.notEqual(res.status, 200, evil);
    assert.ok(!(await res.text()).includes('top-secret'), evil);
  }
});

test('POST /api/submit writes seq files; empty submission rejected', async (t) => {
  const { md, stateDir } = setup();
  const { base } = await listen(t, { file: md, stateDir });
  const post = (payload) => fetch(base + '/api/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const r1 = await post({ docVersion: 1, annotations: [{ scope: 'block', comment: '改简洁' }] });
  assert.deepEqual(await r1.json(), { ok: true, seq: 1 });
  const r2 = await post({ globalComment: '整体更正式' });
  assert.deepEqual(await r2.json(), { ok: true, seq: 2 });
  const saved = JSON.parse(fs.readFileSync(path.join(stateDir, 'submission-1.json'), 'utf8'));
  assert.equal(saved.type, 'submission');
  assert.equal(saved.annotations[0].comment, '改简洁');
  const bad = await post({ annotations: [] });
  assert.equal(bad.status, 400);
});

test('submit seq continues after restart (scans consumed files too)', async (t) => {
  const { md, stateDir } = setup();
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'submission-5.json.consumed'), '{}');
  const { base } = await listen(t, { file: md, stateDir });
  const res = await fetch(base + '/api/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ annotations: [{ comment: 'x' }] }),
  });
  assert.equal((await res.json()).seq, 6);
});

test('editing the doc bumps /api/doc version within a few polls', async (t) => {
  const { md, stateDir } = setup();
  const { base } = await listen(t, { file: md, stateDir, watchIntervalMs: 100 });
  const version = await editAndAwait(md, '# 标题\n\n改过的更长的正文。\n', async () => {
    const v = (await (await fetch(base + '/api/doc')).json()).version;
    return v >= 2 ? v : null;
  });
  assert.equal(version, 2);
});

test('POST /api/done writes done.json and schedules exit(0)', async (t) => {
  const { md, stateDir } = setup();
  let exitCode = null;
  const { base } = await listen(t, { file: md, stateDir, exit: (c) => { exitCode = c; }, doneExitDelayMs: 10 });
  const res = await fetch(base + '/api/done', { method: 'POST' });
  assert.equal(res.status, 200);
  const done = JSON.parse(fs.readFileSync(path.join(stateDir, 'done.json'), 'utf8'));
  assert.equal(done.type, 'done');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(exitCode, 0);
});

test('GET /api/events streams a hello frame then a doc-changed frame over SSE', async (t) => {
  const { md, stateDir } = setup();
  const { base } = await listen(t, { file: md, stateDir, watchIntervalMs: 100 });

  // Minimal SSE frame parser: no EventSource in Node, so read the response
  // stream by hand and split on the blank-line frame delimiter.
  const frames = [];
  let buf = '';
  const req = http.get(base + '/api/events', (res) => {
    res.setEncoding('utf8');
    res.on('error', () => {});
    res.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = /^event: (.+)$/m.exec(raw);
        const data = /^data: (.+)$/m.exec(raw);
        if (ev && data) frames.push({ event: ev[1], data: JSON.parse(data[1]) });
      }
    });
  });
  req.on('error', () => {});

  try {
    const waitForFrame = async (eventName, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      let frame = frames.find((f) => f.event === eventName);
      while (!frame && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        frame = frames.find((f) => f.event === eventName);
      }
      return frame;
    };

    const hello = await waitForFrame('hello', 2000);
    assert.ok(hello, 'expected a hello frame on connect');
    assert.equal(hello.data.version, 1);

    const changed = await editAndAwait(md, '# 标题\n\n改过的更长的正文。\n',
      async () => frames.find((f) => f.event === 'doc-changed') || null);
    assert.ok(changed, 'expected a doc-changed frame after the file edit');
    assert.equal(changed.data.version, 2);
  } finally {
    // Close the SSE connection before this test function returns, so the
    // socket is already gone by the time listen()'s t.after(server.close)
    // hook runs (server.close() waits for open connections to end).
    req.destroy();
  }
});

test('createApp rejects a missing file', () => {
  const { root } = setup();
  assert.throws(() => createApp({ file: path.join(root, 'nope.md'), stateDir: path.join(root, 's') }));
});

test('GET /api/history aggregates submissions + outcomes, seq-sorted, currentVersion', async (t) => {
  const { md, stateDir } = setup();
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'submission-1.json.consumed'), JSON.stringify({
    type: 'submission', seq: 1, submittedAt: 't1', docVersion: 1,
    globalComment: null, annotations: [{ id: 'a1', scope: 'block', comment: 'c1' }],
  }));
  fs.writeFileSync(path.join(stateDir, 'outcome-1.json'), JSON.stringify({
    type: 'outcome', seq: 1, results: [{ id: 'a1', status: 'applied', note: 'done' }],
  }));
  fs.writeFileSync(path.join(stateDir, 'submission-2.json'), JSON.stringify({
    type: 'submission', seq: 2, submittedAt: 't2', docVersion: 1,
    globalComment: 'be formal', annotations: [],
  }));
  const { base } = await listen(t, { file: md, stateDir });
  const body = await (await fetch(base + '/api/history')).json();
  assert.equal(body.currentVersion, 1);
  assert.equal(body.rounds.length, 2);
  assert.equal(body.rounds[0].seq, 1);
  assert.equal(body.rounds[0].outcome.results[0].status, 'applied');
  assert.equal(body.rounds[0].annotations[0].id, 'a1');
  assert.equal(body.rounds[1].seq, 2);
  assert.equal(body.rounds[1].outcome, null);
  assert.equal(body.rounds[1].globalComment, 'be formal');
});

test('GET /api/history tolerates corrupt outcome and corrupt submission files', async (t) => {
  const { md, stateDir } = setup();
  fs.mkdirSync(stateDir, { recursive: true });
  // corrupt outcome → outcome degrades to null, round still listed
  fs.writeFileSync(path.join(stateDir, 'submission-1.json.consumed'), JSON.stringify({
    seq: 1, submittedAt: 't', docVersion: 1, annotations: [{ id: 'a1' }],
  }));
  fs.writeFileSync(path.join(stateDir, 'outcome-1.json'), '{ this is not json');
  // corrupt submission → round still listed as a placeholder, not dropped
  fs.writeFileSync(path.join(stateDir, 'submission-2.json.consumed'), '{ broken');
  fs.writeFileSync(path.join(stateDir, 'outcome-2.json'), JSON.stringify({
    seq: 2, results: [{ id: 'zz', status: 'skipped', note: 'n' }],
  }));
  const { base } = await listen(t, { file: md, stateDir });
  const res = await fetch(base + '/api/history');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.rounds.length, 2);
  assert.equal(body.rounds[0].outcome, null);
  assert.deepEqual(body.rounds[1].annotations, []); // placeholder, not dropped
  assert.equal(body.rounds[1].outcome.results[0].status, 'skipped');
});
