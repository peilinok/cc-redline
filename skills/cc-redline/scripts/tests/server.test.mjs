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
  const { base } = await listen(t, { file: md, stateDir });
  fs.writeFileSync(md, '# 标题\n\n改过的更长的正文。\n');
  let version = 1;
  const deadline = Date.now() + 5000;
  while (version === 1 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    version = (await (await fetch(base + '/api/doc')).json()).version;
  }
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
  const { base } = await listen(t, { file: md, stateDir });

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

    fs.writeFileSync(md, '# 标题\n\n改过的更长的正文。\n');

    const changed = await waitForFrame('doc-changed', 5000);
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
