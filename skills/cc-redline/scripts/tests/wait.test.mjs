import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { waitOnce } from '../wait_for_review.mjs';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ssr-wait-'));

test('consumes submissions in numeric seq order and renames them', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'submission-10.json'), '{"seq":10}');
  fs.writeFileSync(path.join(dir, 'submission-2.json'), '{"seq":2}');
  const first = await waitOnce(dir, 1000, 10);
  assert.equal(first.code, 0);
  assert.equal(JSON.parse(first.output).seq, 2);
  assert.ok(fs.existsSync(path.join(dir, 'submission-2.json.consumed')));
  const second = await waitOnce(dir, 1000, 10);
  assert.equal(JSON.parse(second.output).seq, 10);
});

test('submission wins over done.json; done is returned next and not renamed', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'done.json'), '{"type":"done"}');
  fs.writeFileSync(path.join(dir, 'submission-1.json'), '{"type":"submission","seq":1}');
  const r1 = await waitOnce(dir, 1000, 10);
  assert.equal(JSON.parse(r1.output).type, 'submission');
  const r2 = await waitOnce(dir, 1000, 10);
  assert.equal(JSON.parse(r2.output).type, 'done');
  assert.ok(fs.existsSync(path.join(dir, 'done.json')));
});

test('times out with code 2 and empty output', async () => {
  const r = await waitOnce(tmpDir(), 300, 10);
  assert.deepEqual(r, { code: 2, output: '' });
});

test('reports dead server with code 3', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'server-info.json'), JSON.stringify({ pid: 987654321 }));
  const r = await waitOnce(dir, 2000, 10);
  assert.equal(r.code, 3);
  assert.equal(JSON.parse(r.output).type, 'server-dead');
});

test('live server (our own pid) keeps waiting until timeout', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'server-info.json'), JSON.stringify({ pid: process.pid }));
  const r = await waitOnce(dir, 300, 10);
  assert.equal(r.code, 2);
});

test('picks up a submission that appears while waiting', async () => {
  const dir = tmpDir();
  setTimeout(() => fs.writeFileSync(path.join(dir, 'submission-1.json'), '{"seq":1}'), 200);
  const r = await waitOnce(dir, 3000, 10);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.output).seq, 1);
});
