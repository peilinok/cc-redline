# cc-redline 评审历史闭环（R1+R2）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 cc-redline 的已处理批注不再"阅后即焚"——AI 编辑落地后批注转入右栏只读历史区（含每条 applied/skipped 及说明），解锁只由处理回执驱动（根除"全 skip 永久等待"），并在评审结束时把全过程落成持久 review log。

**Architecture:** 沿用"两进程 + STATE_DIR 文件协议"，全部加法。新增 `outcome-<seq>.json`（agent 原子写的处理回执）与 `GET /api/history`（聚合已提交轮次 + 回执）。**事件模型解耦**：server 广播新的 SSE `outcome` 事件负责解锁 + 落历史，现有 `doc-changed` 事件退化为只重渲染文档——两者不再互相等待，消除竞态。前端新增纯展示模块 `history.mjs` 渲染折叠历史区。R2 的 review log 是 agent 行为，由 `SKILL.md` 指令 + `evals.json` 断言驱动，无新增代码。

**Tech Stack:** 纯 Node ESM（`node:` builtins，零运行时依赖）；前端 vanilla ESM（无框架，vendored 库）；测试 `node:test` + Playwright E2E。

## Global Constraints

每个 task 的要求都隐含包含本节。值均从规格/CLAUDE.md 逐字复制。

- **Node.js >= 18**；`node --version` 校验。
- **零运行时依赖**：server 只用 `node:` builtins；前端库全部 vendored 于 `assets/vendor/`，不新增 npm 依赖（`@playwright/test` 仅 devDependency）。
- **状态文件原子写**：`.tmp` + `rename`。`outcome-<seq>.json` 由 agent 按此写（SKILL 指令）；server 侧 `/api/submit`、`/api/done` 既有原子写不变。
- **不碰**：`quotedSource` 字节精确、`sliceLines` 源保真（含 CRLF）、`serveStatic` 路径穿越防护、`wait_for_review.mjs` 的消费逻辑与退出码（0/2/3）、submission JSON 的既有字段。
- **协议三件套 lockstep**：改提交/回执/注解结构时，`SKILL.md`、`evals/evals.json`、实现必须同一 PR 同步。
- **i18n**：所有 UI/运行时串走 `i18n.mjs` 的 `t()`；写入 submission/outcome JSON 的值保持语言中立（英文 `scope` key、`DOC_START`、英文 `status` key）。
- **发布**：完成后 bump `.claude-plugin/plugin.json` 的 `version`。
- **前端改动**：跑 `SKILL.md` Manual acceptance checklist + E2E。
- **测试命令**（用 glob，勿用裸目录——node22/Windows 会 MODULE_NOT_FOUND）：
  - 全量单测：`node --test skills/cc-redline/scripts/tests/*.test.mjs`
  - 单文件：`node --test skills/cc-redline/scripts/tests/server.test.mjs`
  - E2E（需 `npm ci` 一次 + 系统 Chrome）：`npm run test:e2e`

**工作分支**：`spec/review-history`（已存在，含规格 commit）。所有实现 commit 落此分支。

---

## 数据契约（所有 task 共用，先读）

**`outcome-<seq>.json`**（agent 原子写；client 只读）：

```json
{
  "type": "outcome",
  "seq": 3,
  "results": [
    { "id": "a1", "status": "applied", "note": "改写为更具体的时机描述" },
    { "id": "a2", "status": "skipped", "note": "锚文本已被前一条改写，无法定位" }
  ],
  "globalComment": { "status": "applied", "note": "全文口径已统一" }
}
```

- `status` ∈ `"applied" | "skipped"`（语言中立）。部分完成记 `applied` + 在 `note` 说明。
- `globalComment` 仅当该轮提交含全局评论时出现，否则省略。
- `results` 与 submission 的 `annotations` **非强制双射**（agent 常只报改动项）。

**`GET /api/history`** 响应：

```json
{
  "currentVersion": 4,
  "rounds": [
    {
      "seq": 1,
      "submittedAt": "2026-07-22T10:00:00.000Z",
      "docVersion": 2,
      "globalComment": "整体更正式，或 null",
      "annotations": [ /* submission 的 annotations 原文 */ ],
      "outcome": { /* outcome-1.json 内容，或 null */ }
    }
  ]
}
```

- `rounds` 按 `seq` 升序。
- 逐文件容错：任一 submission/outcome 读取或解析失败按"缺失"降级，绝不使整个响应 500。

---

## Task 1: server `GET /api/history` 聚合路由

**Files:**
- Modify: `skills/cc-redline/scripts/server.mjs`（在 `/api/doc` 路由后、`/api/events` 前插入；约 `server.mjs:137` 之后）
- Test: `skills/cc-redline/scripts/tests/server.test.mjs`（新增 test）

**Interfaces:**
- Consumes: 既有 `createApp({ file, stateDir, ... })`、模块内 `version`、`json(res, code, obj)`、`stateDir`。
- Produces: 路由 `GET /api/history` → `{ currentVersion:number, rounds:Array<{seq,submittedAt,docVersion,globalComment,annotations,outcome}> }`。后续 Task 3/4/6 依赖此形状。

- [ ] **Step 1: 写失败测试**

在 `server.test.mjs` 末尾（`createApp rejects a missing file` 之前或之后）追加：

```js
test('GET /api/history aggregates submissions + outcomes, seq-sorted, currentVersion', async (t) => {
  const { md, stateDir } = setup();
  fs.mkdirSync(stateDir, { recursive: true });
  // seq 1: consumed submission with a matching outcome
  fs.writeFileSync(path.join(stateDir, 'submission-1.json.consumed'), JSON.stringify({
    type: 'submission', seq: 1, submittedAt: 't1', docVersion: 1,
    globalComment: null, annotations: [{ id: 'a1', scope: 'block', comment: 'c1' }],
  }));
  fs.writeFileSync(path.join(stateDir, 'outcome-1.json'), JSON.stringify({
    type: 'outcome', seq: 1, results: [{ id: 'a1', status: 'applied', note: 'done' }],
  }));
  // seq 2: pending submission, no outcome yet
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

test('GET /api/history tolerates a corrupt outcome file (degrades to null)', async (t) => {
  const { md, stateDir } = setup();
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'submission-1.json.consumed'), JSON.stringify({
    seq: 1, submittedAt: 't', docVersion: 1, annotations: [{ id: 'a1' }],
  }));
  fs.writeFileSync(path.join(stateDir, 'outcome-1.json'), '{ this is not json');
  const { base } = await listen(t, { file: md, stateDir });
  const body = await (await fetch(base + '/api/history')).json();
  assert.equal(body.rounds.length, 1);
  assert.equal(body.rounds[0].outcome, null); // corrupt → null, not a 500
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test --test-name-pattern="api/history" skills/cc-redline/scripts/tests/server.test.mjs`
Expected: FAIL（路由不存在，返回 404，`body.rounds` 为 undefined）

- [ ] **Step 3: 实现路由**

在 `server.mjs` 的 `if (req.method === 'GET' && pathname === '/api/doc') { ... }` 块之后插入：

```js
      if (req.method === 'GET' && pathname === '/api/history') {
        let names = [];
        try { names = fs.readdirSync(stateDir); } catch { /* dir not there yet */ }
        const seqs = new Set();
        for (const name of names) {
          const m = /^submission-(\d+)\.json(\.consumed)?$/.exec(name) || /^outcome-(\d+)\.json$/.exec(name);
          if (m) seqs.add(Number(m[1]));
        }
        const readJson = (f) => {
          try { return JSON.parse(fs.readFileSync(path.join(stateDir, f), 'utf8')); } catch { return null; }
        };
        const rounds = [];
        for (const seq of [...seqs].sort((a, b) => a - b)) {
          // .json may be renamed to .consumed mid-read (wait script); try both.
          const s = readJson(`submission-${seq}.json`) || readJson(`submission-${seq}.json.consumed`);
          const o = readJson(`outcome-${seq}.json`);
          if (!s && !o) continue;
          rounds.push({
            seq,
            submittedAt: s?.submittedAt ?? null,
            docVersion: s?.docVersion ?? null,
            globalComment: s?.globalComment ?? null,
            annotations: Array.isArray(s?.annotations) ? s.annotations : [],
            outcome: o,
          });
        }
        return json(res, 200, { currentVersion: version, rounds });
      }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test --test-name-pattern="api/history" skills/cc-redline/scripts/tests/server.test.mjs`
Expected: PASS（两条）

- [ ] **Step 5: 全量回归 + 提交**

Run: `node --test skills/cc-redline/scripts/tests/*.test.mjs`
Expected: 全绿

```bash
git add skills/cc-redline/scripts/server.mjs skills/cc-redline/scripts/tests/server.test.mjs
git commit -m "feat(server): add GET /api/history aggregating rounds + outcomes"
```

---

## Task 2: server outcome 探测 + SSE `outcome` 广播

**Files:**
- Modify: `skills/cc-redline/scripts/server.mjs`（`createApp` 内：新增 `watchOutcome`；`/api/submit` 末尾挂载；启动重建；`server.on('close')` 清理）
- Test: `skills/cc-redline/scripts/tests/server.test.mjs`

**Interfaces:**
- Consumes: 既有 `broadcast(event, data)`、`submitSeq`、`stateDir`、`watchIntervalMs`、`server.on('close')`。
- Produces: 当 `outcome-<seq>.json` 出现并解析成功时，向 SSE 客户端广播 `event: outcome` / `data: {"seq":<n>}`，每个 seq 至多一次。Task 6 的前端 `onOutcome` 依赖它。

- [ ] **Step 1: 写失败测试**

在 `server.test.mjs` 追加（复用文件顶部已 import 的 `http`，与既有 SSE 测试同款手写帧解析）：

```js
test('writing outcome-<seq>.json broadcasts an SSE outcome frame exactly once', async (t) => {
  const { md, stateDir } = setup();
  fs.mkdirSync(stateDir, { recursive: true });
  const { base } = await listen(t, { file: md, stateDir, watchIntervalMs: 100 });

  const frames = [];
  let buf = '';
  const req = http.get(base + '/api/events', (res) => {
    res.setEncoding('utf8');
    res.on('error', () => {});
    res.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const ev = /^event: (.+)$/m.exec(raw); const data = /^data: (.+)$/m.exec(raw);
        if (ev && data) frames.push({ event: ev[1], data: JSON.parse(data[1]) });
      }
    });
  });
  req.on('error', () => {});
  try {
    // Register the round first (server arms the watch at /api/submit).
    await fetch(base + '/api/submit', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ annotations: [{ id: 'a1', comment: 'x' }] }),
    });
    // The "agent" writes the outcome (atomic: tmp + rename).
    const tmp = path.join(stateDir, 'outcome-1.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify({ type: 'outcome', seq: 1, results: [{ id: 'a1', status: 'applied' }] }));
    fs.renameSync(tmp, path.join(stateDir, 'outcome-1.json'));

    const deadline = Date.now() + 3000;
    while (!frames.some((f) => f.event === 'outcome') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const outcomes = frames.filter((f) => f.event === 'outcome');
    assert.equal(outcomes.length, 1, 'exactly one outcome frame');
    assert.equal(outcomes[0].data.seq, 1);
    // give the poller a couple more intervals: must NOT re-broadcast
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(frames.filter((f) => f.event === 'outcome').length, 1, 'no re-broadcast');
  } finally {
    req.destroy();
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test --test-name-pattern="outcome SSE|outcome frame" skills/cc-redline/scripts/tests/server.test.mjs`
Expected: FAIL（无 outcome 帧）

- [ ] **Step 3: 实现 outcome 探测**

在 `server.mjs` 的 `broadcast` 函数定义之后（约 `server.mjs:78` 后）新增：

```js
  // Detect each round's outcome-<seq>.json without a standing poll loop: watch
  // the specific known path (reuses fs.watchFile, same as the doc watcher),
  // broadcast once, then stop watching. Missed broadcasts self-heal via the
  // client's /api/history refetch on (re)connect.
  const announcedOutcomes = new Set();
  const watchedOutcomeSeqs = new Set();
  function watchOutcome(seq) {
    if (announcedOutcomes.has(seq) || watchedOutcomeSeqs.has(seq)) return;
    const file = path.join(stateDir, `outcome-${seq}.json`);
    watchedOutcomeSeqs.add(seq);
    fs.watchFile(file, { interval: watchIntervalMs }, () => {
      try {
        JSON.parse(fs.readFileSync(file, 'utf8')); // not there yet / half-written → next poll retries
      } catch {
        return;
      }
      announcedOutcomes.add(seq);
      watchedOutcomeSeqs.delete(seq);
      fs.unwatchFile(file);
      broadcast('outcome', { seq });
    });
  }
  // Re-arm watches for any submitted round still lacking an outcome — survives a
  // restart with the same STATE_DIR.
  for (const name of (fs.existsSync(stateDir) ? fs.readdirSync(stateDir) : [])) {
    const m = /^submission-(\d+)\.json(\.consumed)?$/.exec(name);
    if (m && !fs.existsSync(path.join(stateDir, `outcome-${m[1]}.json`))) watchOutcome(Number(m[1]));
  }
```

在 `/api/submit` 处理里，`fs.renameSync(target + '.tmp', target);` 之后、`return json(...)` 之前加一行：

```js
        watchOutcome(submitSeq);
```

把 `server.on('close', ...)`（约 `server.mjs:203`）改为：

```js
  server.on('close', () => {
    clearInterval(heartbeat);
    fs.unwatchFile(docFile);
    for (const seq of watchedOutcomeSeqs) fs.unwatchFile(path.join(stateDir, `outcome-${seq}.json`));
  });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test --test-name-pattern="outcome frame" skills/cc-redline/scripts/tests/server.test.mjs`
Expected: PASS

- [ ] **Step 5: 全量回归 + 提交**

Run: `node --test skills/cc-redline/scripts/tests/*.test.mjs`
Expected: 全绿

```bash
git add skills/cc-redline/scripts/server.mjs skills/cc-redline/scripts/tests/server.test.mjs
git commit -m "feat(server): broadcast SSE outcome when outcome-<seq>.json lands"
```

---

## Task 3: `history.mjs` 纯推导函数（node 可测）

**Files:**
- Create: `skills/cc-redline/assets/js/history.mjs`
- Test: `skills/cc-redline/scripts/tests/history.test.mjs`

**Interfaces:**
- Consumes: `/api/history` 的 round 形状（Task 1）。
- Produces（纯函数，浏览器与 node:test 共享，无 DOM）：
  - `roundState(round, currentVersion) → 'resolved' | 'processed-no-outcome' | 'in-flight'`
  - `annotationResult(round, annId) → { status: 'applied'|'skipped'|'unknown', note: string }`
  - `roundChangedDoc(round) → boolean | null`（null = 无回执、未知）
  Task 4 的渲染与 Task 6 的横幅逻辑依赖这三个。

- [ ] **Step 1: 写失败测试**

创建 `skills/cc-redline/scripts/tests/history.test.mjs`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roundState, annotationResult, roundChangedDoc } from '../../assets/js/history.mjs';

test('roundState: resolved when an outcome exists', () => {
  assert.equal(roundState({ outcome: { results: [] }, docVersion: 1 }, 3), 'resolved');
});
test('roundState: processed-no-outcome when doc advanced past the round', () => {
  assert.equal(roundState({ outcome: null, docVersion: 1 }, 3), 'processed-no-outcome');
});
test('roundState: in-flight when no outcome and doc has not advanced', () => {
  assert.equal(roundState({ outcome: null, docVersion: 3 }, 3), 'in-flight');
});

test('annotationResult: matches by id', () => {
  const round = { outcome: { results: [{ id: 'a1', status: 'applied', note: 'ok' }] } };
  assert.deepEqual(annotationResult(round, 'a1'), { status: 'applied', note: 'ok' });
});
test('annotationResult: missing id in a resolved round → unknown', () => {
  const round = { outcome: { results: [{ id: 'a1', status: 'applied' }] } };
  assert.deepEqual(annotationResult(round, 'a2'), { status: 'unknown', note: '' });
});
test('annotationResult: unrecognised status → unknown', () => {
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test skills/cc-redline/scripts/tests/history.test.mjs`
Expected: FAIL（`history.mjs` 不存在，import 报错）

- [ ] **Step 3: 实现纯函数**

创建 `skills/cc-redline/assets/js/history.mjs`（本 step 只写纯函数区；DOM 渲染在 Task 4 追加到同文件）：

```js
// Read-only review history: pure derivations (shared by the browser and
// node:test — no DOM here) plus a DOM renderer (added in a later task).
// Data source is GET /api/history; this module never mutates state.

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

// Per-annotation outcome, matched by (round, id). Missing/unrecognised → unknown.
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test skills/cc-redline/scripts/tests/history.test.mjs`
Expected: PASS（全部）

- [ ] **Step 5: 提交**

```bash
git add skills/cc-redline/assets/js/history.mjs skills/cc-redline/scripts/tests/history.test.mjs
git commit -m "feat(history): pure round-state / result / changed-doc derivations"
```

---

## Task 4: 历史区 DOM 渲染 + 容器 + 样式 + i18n

**Files:**
- Modify: `skills/cc-redline/assets/js/history.mjs`（追加 `initHistory` DOM 渲染）
- Modify: `skills/cc-redline/assets/app.html`（新增 `#history` 容器）
- Modify: `skills/cc-redline/assets/app.css`（`#history` 样式）
- Modify: `skills/cc-redline/assets/js/i18n.mjs`（新增 en/zh 键）
- Test: 无 node 单测（DOM）；由 Task 7 E2E 覆盖。本 task 以"语法正确 + 现有测试仍绿 + i18n 键成对存在"为验收。

**Interfaces:**
- Consumes: Task 3 的 `roundState` / `annotationResult`；`i18n.mjs` 的 `t`；`/api/history` 数据。
- Produces: `initHistory({ historyEl }) → { render(data) }`，把 `data.rounds` 渲染为折叠手风琴。Task 6 调用 `render(data)`。

- [ ] **Step 1: 追加 i18n 键**

在 `i18n.mjs` 的 `en` 表内（`'render.failed'` 行之前）加：

```js
    'history.title': 'Processed ({n})',
    'history.empty': 'No processed rounds yet.',
    'history.round': 'Round {seq}',
    'history.global': 'Overall',
    'history.status.applied': 'Applied',
    'history.status.skipped': 'Skipped',
    'history.status.unknown': 'No per-item note',
    'history.state.processed': 'Processed (no outcome recorded)',
    'history.state.inflight': 'Processing…',
    'banner.roundNoChange': 'This round is processed (no changes to the document).',
    'banner.inflight': 'Processing your submitted annotations…',
```

在 `zh` 表内对应位置（`'render.failed'` 之前）加：

```js
    'history.title': '已处理（{n}）',
    'history.empty': '还没有已处理的批注。',
    'history.round': '第 {seq} 轮',
    'history.global': '整体意见',
    'history.status.applied': '已应用',
    'history.status.skipped': '已跳过',
    'history.status.unknown': '无单条说明',
    'history.state.processed': '已处理（无回执记录）',
    'history.state.inflight': '处理中…',
    'banner.roundNoChange': '本轮已处理（文档无改动）。',
    'banner.inflight': '正在处理已提交的批注…',
```

- [ ] **Step 2: 追加 DOM 渲染到 `history.mjs`**

在 `history.mjs` 顶部加 import（与纯函数区共存；node 测试只 import 纯函数，`t` 的 import 不执行 DOM，i18n 有 `typeof document` 保护）：

```js
import { t } from './i18n.mjs';
```

在文件末尾追加（`STATUS_BADGE` 常量 + `initHistory`；`card()` 复用、每轮卡片挂到该轮自己的 `<details>`、head 点击折叠）：

```js
const STATUS_BADGE = { applied: '✓', skipped: '⊘', unknown: '—' };

// Renders read-only history rounds into `historyEl`. Cards never re-anchor to the
// (edited) document — history is an archive, not a live overlay. Each round's
// cards are appended to that round's own <details>, so rounds stay separable.
export function initHistory({ historyEl }) {
  const head = historyEl.querySelector('#history-head');
  const list = historyEl.querySelector('#history-rounds');
  function card(status, commentText, note) {
    const el = document.createElement('div');
    el.className = 'history-card status-' + status;
    const badge = document.createElement('span');
    badge.className = 'history-badge';
    badge.textContent = STATUS_BADGE[status] || '—';
    badge.title = t('history.status.' + status);
    const cm = document.createElement('span');
    cm.className = 'history-card-comment';
    cm.textContent = commentText;
    el.append(badge, cm);
    if (note) {
      const n = document.createElement('div');
      n.className = 'history-card-note';
      n.textContent = note;
      el.append(n);
    }
    return el;
  }
  function render(data) {
    const rounds = (data && Array.isArray(data.rounds) ? data.rounds : []).slice().reverse(); // newest first
    const currentVersion = data ? data.currentVersion : null;
    historyEl.hidden = rounds.length === 0;
    head.textContent = t('history.title', { n: rounds.length });
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
        details.append(card(r.status, a.comment || '', r.note));
      }
      // A round may be global-only (zero annotations) or also carry a global comment.
      if (round.globalComment) {
        const gr = round.outcome && round.outcome.globalComment ? round.outcome.globalComment : null;
        const status = gr && (gr.status === 'applied' || gr.status === 'skipped') ? gr.status : 'unknown';
        details.append(card(status, t('history.global') + ': ' + round.globalComment, gr ? gr.note : ''));
      }
      list.append(details);
    });
  }
  head.addEventListener('click', () => historyEl.classList.toggle('collapsed'));
  return { render };
}
```

- [ ] **Step 3: 新增 `#history` 容器**

在 `app.html` 的 `<button id="selection-btn" ...>` 行之前插入：

```html
  <aside id="history" hidden>
    <button id="history-head" type="button"></button>
    <div id="history-rounds"></div>
  </aside>
```

- [ ] **Step 4: 新增样式**

在 `app.css` 末尾追加：

```css
#history {
  position: fixed;
  right: 16px;
  bottom: 16px;
  width: 320px;
  max-width: calc(100vw - 32px);
  max-height: 60vh;
  display: flex;
  flex-direction: column;
  background: #fff;
  border: 1px solid #d0d0d0;
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  z-index: 40;
  overflow: hidden;
  font-size: 13px;
}
#history-head {
  flex: 0 0 auto;
  text-align: left;
  padding: 8px 12px;
  font-weight: 600;
  background: #f4f4f4;
  border: none;
  border-bottom: 1px solid #e0e0e0;
  cursor: pointer;
}
#history.collapsed #history-rounds { display: none; }
#history-rounds { overflow-y: auto; padding: 6px; }
.history-round { margin-bottom: 6px; }
.history-round > summary { cursor: pointer; padding: 4px 6px; list-style: revert; }
.history-round-tag { margin-left: 6px; color: #888; font-size: 11px; }
.history-card { display: grid; grid-template-columns: auto 1fr; gap: 6px; padding: 4px 6px; color: #555; }
.history-card-note { grid-column: 2; color: #888; font-size: 12px; }
.history-badge { font-weight: 700; }
.history-card.status-applied .history-badge { color: #1a7f37; }
.history-card.status-skipped .history-badge { color: #b3261e; }
.history-card.status-unknown .history-badge { color: #999; }
body.ann-hidden #history { display: none; }
```

- [ ] **Step 5: 校验语法 + i18n 成对 + 现有测试不回归**

Run: `node --check skills/cc-redline/assets/js/history.mjs`
Expected: 无输出（语法 OK）

Run: `node --test skills/cc-redline/scripts/tests/*.test.mjs`
Expected: 全绿（history 纯函数 + i18n + 其余；确认新增 i18n 键不破坏 i18n.test.mjs）

- [ ] **Step 6: 提交**

```bash
git add skills/cc-redline/assets/js/history.mjs skills/cc-redline/assets/app.html skills/cc-redline/assets/app.css skills/cc-redline/assets/js/i18n.mjs
git commit -m "feat(history): render read-only history panel (accordion + badges + i18n)"
```

---

## Task 5: `annotate.mjs` — 提交捕获 seq + `consumeSubmitted(seq)`

**Files:**
- Modify: `skills/cc-redline/assets/js/annotate.mjs`
- Test: 无 node 单测（DOM 交互）；由 Task 7 E2E（多批在途）覆盖。验收：语法正确 + 现有 E2E 在 Task 6 更新后仍绿。

**Interfaces:**
- Consumes: `/api/submit` 响应 `{ ok, seq }`。
- Produces（public API 变更，Task 6 依赖）：
  - `consumeSubmitted(seq: number)`：只移除 `a.seq === seq` 的批注；仅当该 seq 拥有 globalComment 时清空它。
  - `hasSubmittedInFlight(): boolean`。

- [ ] **Step 1: 声明 `globalSeq`**

在 `annotate.mjs` 的 `let globalSubmitted = false;`（约 `annotate.mjs:42`）下一行加：

```js
  let globalSeq = null; // which submitted seq owns the current globalComment
```

- [ ] **Step 2: 提交时记录 seq**

在 submit handler 里，把这三行（约 `annotate.mjs:691-694`）：

```js
      if (!res.ok) throw new Error('HTTP ' + res.status);
      // Lock what we sent instead of clearing it — stays visible, awaiting the AI.
      drafts.forEach((a) => { a.submitted = true; });
      if (sendGlobal) globalSubmitted = true;
```

改为：

```js
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const { seq } = await res.json();
      // Lock what we sent instead of clearing it — stays visible, awaiting the AI.
      drafts.forEach((a) => { a.submitted = true; a.seq = seq; });
      if (sendGlobal) { globalSubmitted = true; globalSeq = seq; }
```

- [ ] **Step 3: `clean` 解构剔除 `seq`**

把 submit handler 里的解构（约 `annotate.mjs:675-679`）中的字段列表补上 `seq`（`seq` 是提交后才写，正常不会出现在 draft 上，剔除是防御性且保持 annotation JSON 干净）：

```js
    const clean = drafts.map(({
      selBlockIds, selStart, selEnd, blockId,
      selStartLine, selStartCol, selEndLine, selEndCol, origin, submitted, seq,
      ...rest
    }) => rest);
```

- [ ] **Step 4: 改 `consumeSubmitted` 为按 seq + 新增 `hasSubmittedInFlight`**

把 public API 里的 `consumeSubmitted`（约 `annotate.mjs:722-727`）：

```js
    // The AI's edit landed: drop the submitted batch it consumed, keep any new drafts.
    consumeSubmitted: () => {
      annotations = annotations.filter((a) => !a.submitted);
      if (globalSubmitted) { globalComment = ''; globalSubmitted = false; updateGlobalBtn(); }
      refreshUi();
    },
```

改为：

```js
    // A round's outcome landed: drop only that seq's submitted batch, keep drafts
    // and any other in-flight batches.
    consumeSubmitted: (seq) => {
      annotations = annotations.filter((a) => a.seq !== seq);
      if (globalSubmitted && globalSeq === seq) { globalComment = ''; globalSubmitted = false; globalSeq = null; updateGlobalBtn(); }
      refreshUi();
    },
    hasSubmittedInFlight: () => annotations.some((a) => a.submitted),
```

- [ ] **Step 5: 校验语法 + 提交**

Run: `node --check skills/cc-redline/assets/js/annotate.mjs`
Expected: 无输出

```bash
git add skills/cc-redline/assets/js/annotate.mjs
git commit -m "feat(annotate): tag submitted batches by seq; consumeSubmitted(seq)"
```

> 注：此 commit 后 `npm run test:e2e` 的 `applying the edit … consumes the submitted batch` 会暂时变红（它靠 doc-changed 消费、且改的是无参 `consumeSubmitted`）。这是预期的——Task 6 会把调用方与该用例一起改到 outcome 驱动，届时恢复全绿。若采用逐 task 门禁，把 Task 5+6 视为一个绿色门禁单元。

---

## Task 6: 事件模型接线（`sse.mjs` + `main.mjs`）

**Files:**
- Modify: `skills/cc-redline/assets/js/sse.mjs`
- Modify: `skills/cc-redline/assets/js/main.mjs`
- Modify: `skills/cc-redline/e2e/review.spec.mjs`（把受协议变更影响的既有用例改到 outcome 驱动）
- Test: `npm run test:e2e`（既有用例 + 改后的这条应全绿）

**Interfaces:**
- Consumes: Task 2 的 SSE `outcome` 事件、server `hello` 事件；Task 1 的 `/api/history`；Task 3 的 `roundChangedDoc`；Task 4 的 `initHistory`；Task 5 的 `consumeSubmitted(seq)` / `hasSubmittedInFlight`。
- Produces: 完整的解耦事件循环——`outcome` 解锁 + 落历史，`doc-changed` 只重渲染，`hello`(重连) 重拉历史对账，页面 load 拉历史。

- [ ] **Step 1: 扩展 `sse.mjs`**

把 `sse.mjs` 整体替换为：

```js
// Thin wrapper around EventSource for /api/events.
export function connectEvents({ onDocChanged, onOutcome, onHello, onStatus }) {
  const es = new EventSource('/api/events');
  es.onopen = () => onStatus(true);
  es.onerror = () => onStatus(false); // EventSource auto-reconnects
  es.addEventListener('hello', (e) => onHello && onHello(JSON.parse(e.data)));
  es.addEventListener('doc-changed', (e) => onDocChanged(JSON.parse(e.data)));
  es.addEventListener('outcome', (e) => onOutcome && onOutcome(JSON.parse(e.data)));
  return es;
}
```

- [ ] **Step 2: `main.mjs` 引入 history 模块**

在 `main.mjs` 顶部 import 区（`import { initRuler } ...` 之后）加：

```js
import { initHistory, roundChangedDoc } from './history.mjs';
```

在 `els` 对象（约 `main.mjs:9-22`）里加一项：

```js
  history: document.getElementById('history'),
```

- [ ] **Step 3: 初始化 history + refreshHistory**

在 `main.mjs` 里 `ruler = initRuler({...})` 之后加：

```js
const hist = initHistory({ historyEl: els.history });
async function refreshHistory() {
  try {
    const data = await (await fetch('/api/history')).json();
    hist.render(data);
    return data;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: 改 `connectEvents` 接线**

把 `main.mjs` 底部的 `connectEvents({...})`（约 `main.mjs:199-216`）替换为：

```js
connectEvents({
  onDocChanged: () => {
    refreshHistory(); // an applied round may now be resolved in history
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
    // Unlock is driven ONLY by the outcome — never by doc-changed. This is what
    // kills the "all-skip round waits forever" bug and the two-poller race.
    const data = await refreshHistory();
    ann.consumeSubmitted(seq);
    const round = data && data.rounds.find((r) => r.seq === seq);
    if (ann.hasSubmittedInFlight()) { showBanner(t('banner.inflight')); return; }
    if (round && roundChangedDoc(round) === false) { showBanner(t('banner.roundNoChange')); return; }
    // else: the doc changed → the doc-changed event will refreshDoc + hideBanner.
  },
  onHello: () => refreshHistory(), // (re)connect reconciliation: self-heals a missed outcome
  onStatus: (ok) => els.connDot.classList.toggle('ok', ok),
});
```

- [ ] **Step 5: 页面 load 拉一次历史**

把 `main.mjs` 末尾的：

```js
setMode('render');
await loadDoc();
```

改为：

```js
setMode('render');
await loadDoc();
await refreshHistory();
```

- [ ] **Step 6: 更新受协议变更影响的既有 E2E**

把 `e2e/review.spec.mjs` 的 `applying the edit (file change) consumes the submitted batch and refreshes`（约 153-167 行）整段替换为——改为"agent 先原子写 outcome，再改文档"，并断言卡片移出活动区、进入历史区：

```js
  test('an outcome + edit consumes the submitted batch, refreshes, and archives to history', async ({ page, review }) => {
    await page.goto(review.url);
    await addBlockAnnotation(page, 'Tail paragraph', 'expand this');
    await page.locator('#btn-submit').click();
    const sub = await waitForFile(path.join(review.stateDir, 'submission-1.json'));
    const annId = sub.annotations[0].id;

    // the "agent" writes the outcome atomically, then applies the edit
    const outcome = JSON.stringify({ type: 'outcome', seq: 1, results: [{ id: annId, status: 'applied', note: 'expanded' }] });
    fs.writeFileSync(path.join(review.stateDir, 'outcome-1.json.tmp'), outcome);
    fs.renameSync(path.join(review.stateDir, 'outcome-1.json.tmp'), path.join(review.stateDir, 'outcome-1.json'));
    fs.writeFileSync(review.mdPath, FIXTURE_MD.replace('Tail paragraph.', 'Tail paragraph, expanded by the agent.'));

    await expect(page.locator('#content')).toContainText('expanded by the agent', { timeout: 10_000 });
    await expect(page.locator('.rail-card')).toHaveCount(0); // active batch consumed by the outcome
    await expect(page.locator('#history')).toBeVisible();
    await expect(page.locator('#history .history-card.status-applied')).toContainText('expand this');
    await expect(page.locator('#content .block.changed')).toContainText('expanded by the agent');
  });
```

- [ ] **Step 7: 跑 E2E**

Run: `npm run test:e2e`
Expected: 全绿（含改后的这条 + 既有其余；`live reload safety` 两条不受影响，因为它们不涉及 submitted 批次的消费）

- [ ] **Step 8: 提交**

```bash
git add skills/cc-redline/assets/js/sse.mjs skills/cc-redline/assets/js/main.mjs skills/cc-redline/e2e/review.spec.mjs
git commit -m "feat(ui): decouple events — outcome unlocks + archives, doc-changed only re-renders"
```

---

## Task 7: 历史闭环专项 E2E

**Files:**
- Modify: `skills/cc-redline/e2e/review.spec.mjs`（新增一个 `test.describe('review history', ...)`）
- Test: `npm run test:e2e`

**Interfaces:**
- Consumes: Task 1-6 的完整链路；helpers 的 `startReview` / `waitForFile` / `FIXTURE_MD`。

- [ ] **Step 1: 写新用例**

在 `review.spec.mjs` 末尾追加：

```js
test.describe('review history', () => {
  test('an all-skip round unlocks via outcome (no doc change) and shows a no-change banner', async ({ page, review }) => {
    await page.goto(review.url);
    await addBlockAnnotation(page, 'First paragraph with', 'please rephrase');
    await page.locator('#btn-submit').click();
    const sub = await waitForFile(path.join(review.stateDir, 'submission-1.json'));
    const annId = sub.annotations[0].id;

    // agent skips it: writes an outcome, does NOT touch the doc
    const outcome = JSON.stringify({ type: 'outcome', seq: 1, results: [{ id: annId, status: 'skipped', note: 'anchor ambiguous' }] });
    fs.writeFileSync(path.join(review.stateDir, 'outcome-1.json.tmp'), outcome);
    fs.renameSync(path.join(review.stateDir, 'outcome-1.json.tmp'), path.join(review.stateDir, 'outcome-1.json'));

    // unlocked without any doc-changed event
    await expect(page.locator('.rail-card')).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator('#banner')).toContainText('no changes to the document');
    await expect(page.locator('#history .history-card.status-skipped')).toContainText('please rephrase');
  });

  test('multiple in-flight batches: the first outcome unlocks only its own seq', async ({ page, review }) => {
    await page.goto(review.url);
    await addBlockAnnotation(page, 'First paragraph with', 'note one');
    await page.locator('#btn-submit').click();
    const sub1 = await waitForFile(path.join(review.stateDir, 'submission-1.json'));
    await addBlockAnnotation(page, 'Tail paragraph', 'note two');
    await page.locator('#btn-submit').click();
    await waitForFile(path.join(review.stateDir, 'submission-2.json'));

    // two locked cards in flight
    await expect(page.locator('.rail-card.submitted')).toHaveCount(2);

    // outcome for seq 1 only
    const id1 = sub1.annotations[0].id;
    const o1 = JSON.stringify({ type: 'outcome', seq: 1, results: [{ id: id1, status: 'applied', note: 'ok' }] });
    fs.writeFileSync(path.join(review.stateDir, 'outcome-1.json.tmp'), o1);
    fs.renameSync(path.join(review.stateDir, 'outcome-1.json.tmp'), path.join(review.stateDir, 'outcome-1.json'));

    // seq 2 stays locked; seq 1 moved to history
    await expect(page.locator('.rail-card.submitted')).toHaveCount(1, { timeout: 10_000 });
    await expect(page.locator('#history .history-card.status-applied')).toContainText('note one');
  });

  test('history survives a page reload (rebuilt from /api/history)', async ({ page, review }) => {
    await page.goto(review.url);
    await addBlockAnnotation(page, 'First paragraph with', 'keep me');
    await page.locator('#btn-submit').click();
    const sub = await waitForFile(path.join(review.stateDir, 'submission-1.json'));
    const annId = sub.annotations[0].id;
    const outcome = JSON.stringify({ type: 'outcome', seq: 1, results: [{ id: annId, status: 'applied', note: 'kept' }] });
    fs.writeFileSync(path.join(review.stateDir, 'outcome-1.json.tmp'), outcome);
    fs.renameSync(path.join(review.stateDir, 'outcome-1.json.tmp'), path.join(review.stateDir, 'outcome-1.json'));
    await expect(page.locator('#history .history-card.status-applied')).toBeVisible({ timeout: 10_000 });

    await page.reload();
    await expect(page.locator('#history .history-card.status-applied')).toContainText('keep me');
  });
});
```

- [ ] **Step 2: 跑 E2E**

Run: `npm run test:e2e`
Expected: 全绿（新增三条 + 既有）

- [ ] **Step 3: 提交**

```bash
git add skills/cc-redline/e2e/review.spec.mjs
git commit -m "test(e2e): cover all-skip unlock, per-seq unlock, and history reload"
```

---

## Task 8: 协议与文档 lockstep（`SKILL.md` + `evals.json`）

**Files:**
- Modify: `skills/cc-redline/SKILL.md`（§3 写 outcome；§4 review log；Manual acceptance checklist）
- Modify: `skills/cc-redline/evals/evals.json`
- Test: `claude plugin validate . --strict`（清单校验，不覆盖 eval 语义）；文档一致性人工核对。

**Interfaces:**
- Consumes: Task 1-7 定义的 outcome 文件结构与解锁语义。
- Produces: agent 侧契约——每轮处理后原子写 `outcome-<seq>.json`；End review 生成 review log。

- [ ] **Step 1: `SKILL.md` §3 增加写回执步骤**

在 `SKILL.md` §3 的 "After applying: save the file ..."（约 94 行）那段之前，把该收尾段改写为（新增写 outcome 的要求，且明确"先写回执、再存文档、全 skip 也写"）：

```markdown
After processing every annotation in the submission, and **before saving the
file**, write a processing outcome so the browser can unlock the batch and show
each annotation's result (this also covers the all-skipped case, where the file
does not change at all):

- Write `$STATE_DIR/outcome-<seq>.json` **atomically** (write `outcome-<seq>.json.tmp`,
  then rename it into place — never a partial file). Shape:

      { "type": "outcome", "seq": <the submission's seq>,
        "results": [ { "id": "<annotation id>", "status": "applied" | "skipped",
                       "note": "<short free-text explanation>" }, ... ],
        "globalComment": { "status": "applied" | "skipped", "note": "..." } }

  - One entry per annotation you acted on, keyed by the annotation's `id`.
    Use `skipped` (with a `note` saying why) for anything you could not anchor
    or that was unclear — the same honest-skip rule as above, now visible in the
    page instead of only in chat. Partial work: use `applied` and say what you
    left out in the `note`.
  - Include `globalComment` only if the submission carried one.
  - `status` values are language-neutral English keys.

Then save the file. The browser refreshes itself via the file watcher (do not
try to notify it); reply with a 2-3 sentence summary, then loop back to the wait
command.
```

- [ ] **Step 2: `SKILL.md` §4 增加 review log**

在 `SKILL.md` §4 "Ending" 段落里，补一条（放在"summarize the whole review"相关处）：

```markdown
- On End review (the wait script returns `done`), before summarizing, offer to
  write a **review log**: read the `submission-<seq>.json(.consumed)` and
  `outcome-<seq>.json` files in `STATE_DIR` and append one dated section to a
  log file next to the reviewed doc. The file name is the doc's name with a
  trailing `.md` stripped, plus `.review-log.md` (e.g. `spec.md` →
  `spec.review-log.md`, `README` → `README.review-log.md`). Append a
  `## Review <YYYY-MM-DD HH:MM>` section listing, per round, each annotation's
  comment and its outcome (applied / skipped + note). If the user declines, skip
  it. If the target dir is not writable, report and skip — do not fail the
  ending.
```

- [ ] **Step 3: `SKILL.md` Manual acceptance checklist 更新**

把清单里这条（约 138-140 行）：

```markdown
- [ ] Submit writes `submission-<seq>.json`; submitted annotations lock in place as
      "Submitted" (edit/delete hidden) instead of clearing, new draft annotations can still be
      added, the waiting banner shows, and the submitted batch clears when the AI's edit lands
```

改为：

```markdown
- [ ] Submit writes `submission-<seq>.json`; submitted annotations lock in place as
      "Submitted" (edit/delete hidden) instead of clearing, new draft annotations can still be
      added, the waiting banner shows
- [ ] When the agent writes `outcome-<seq>.json`, that batch unlocks and moves into
      the right-hand "Processed" history panel with per-annotation ✓ applied / ⊘ skipped
      badges — including an all-skipped round (no file change), which still unlocks and
      shows a "no changes" banner (never a permanent wait)
- [ ] The history panel survives a page reload / SSE reconnect (rebuilt from
      `/api/history`); multiple in-flight batches unlock independently by seq
- [ ] On End review, a `<doc>.review-log.md` is offered/written next to the doc
```

- [ ] **Step 4: `evals.json` 更新**

把 `evals/evals.json` 的 eval `id: 2` 的 `expectations` 数组追加两条，并把 `expected_output` 补上写回执：

将 `id:2` 的 `expected_output` 改为：

```
"Apply the annotation by locating the quotedSource text verbatim and rewriting it per the comment, atomically write outcome-<seq>.json recording each annotation's applied/skipped status before saving the file, report the change in 2-3 sentences, then immediately re-run the wait script."
```

在其 `expectations` 数组末尾加：

```json
        "Before saving the file, writes $STATE_DIR/outcome-<seq>.json atomically (tmp + rename) with a results entry per annotation keyed by id, status applied or skipped.",
        "Uses status skipped with a note for any annotation it cannot anchor, rather than omitting it silently."
```

在 `evals` 数组末尾新增两条（注意在前一条对象后加逗号）：

```json
    {
      "id": 4,
      "prompt": "（review 进行中，wait 脚本输出了一份 submission：两条标注的 quotedSource 都已无法在当前文档中定位）请处理这份提交。",
      "expected_output": "Recognize that neither annotation can be anchored, make no edits to the document, write an outcome-<seq>.json marking both as skipped with a reason, report honestly in chat, then re-run the wait script.",
      "files": [],
      "expectations": [
        "Does not guess or fabricate edits when quotedSource cannot be located.",
        "Writes outcome-<seq>.json (atomically) with every result status = skipped and a note explaining why, even though the document did not change.",
        "Reports the skipped annotations honestly and loops back to wait_for_review.mjs."
      ]
    },
    {
      "id": 5,
      "prompt": "（用户在页面点了 End review，wait 脚本返回 done）请收尾。",
      "expected_output": "Offer to write a review log next to the reviewed doc, aggregating each round's annotations and their applied/skipped outcomes from the STATE_DIR files, then summarize the whole review.",
      "files": [],
      "expectations": [
        "Aggregates submission-<seq>.json(.consumed) and outcome-<seq>.json from STATE_DIR into a dated section appended to <doc>.review-log.md next to the reviewed document.",
        "Skips the log if the user declines or the target directory is not writable, without failing the ending.",
        "Summarizes rounds / annotations / main changes in chat."
      ]
    }
```

- [ ] **Step 5: 校验清单 + 提交**

Run: `claude plugin validate . --strict`
Expected: 通过（无 manifest 错误）

人工核对：outcome 结构在 `SKILL.md` §3、`evals.json`、`assets/js/history.mjs`、`docs/.../2026-07-22-review-history-design.md` §4.1 四处一致（字段名 `type/seq/results/id/status/note/globalComment`，`status` ∈ applied|skipped）。

```bash
git add skills/cc-redline/SKILL.md skills/cc-redline/evals/evals.json
git commit -m "docs(skill): lockstep outcome-write + review-log protocol (SKILL.md + evals)"
```

---

## Task 9: 收尾 —— 全量验证 + 版本 bump

**Files:**
- Modify: `.claude-plugin/plugin.json`（bump `version`）
- Test: 全量单测 + E2E。

- [ ] **Step 1: 全量单测**

Run: `node --test skills/cc-redline/scripts/tests/*.test.mjs`
Expected: 全绿（blocks / i18n / server / wait / history）

- [ ] **Step 2: 全量 E2E**

Run: `npm run test:e2e`
Expected: 全绿

- [ ] **Step 3: bump 插件版本**

读 `.claude-plugin/plugin.json` 当前 `version`（预期 `0.2.0`），minor +1（→ `0.3.0`）。用 Edit 精确替换该字段：

```json
  "version": "0.3.0",
```

（若当前不是 `0.2.0`，以实际值 minor +1，并在 commit message 注明实际跳变。）

- [ ] **Step 4: 提交**

```bash
git add .claude-plugin/plugin.json
git commit -m "chore: release v0.3.0 — review history closure (R1+R2)"
```

- [ ] **Step 5: 完成分支**

调用 `superpowers:finishing-a-development-branch` 决定合并/PR 方式（本仓库遵循分支 + PR，不直推 main）。

---

## Self-Review（写完计划后的清单核对）

**1. Spec coverage（规格逐节 → task）：**

| 规格条目 | 覆盖 task |
|---|---|
| R1 历史区渲染（折叠、徽标、note） | Task 4（DOM）+ Task 3（推导）+ Task 1（API） |
| R1 解锁由 outcome 驱动 | Task 2（SSE）+ Task 5（consumeSubmitted seq）+ Task 6（onOutcome） |
| R1 全 skip 解锁 + 无改动横幅 | Task 2 + Task 6 + Task 7（E2E） |
| R1 reload / SSE 重连恢复 | Task 6（load + onHello）+ Task 7 |
| §4.1 outcome 原子写、无 docChanged/partial | Task 8（SKILL/evals）+ Task 3（从 results 推导） |
| §5 /api/history 逐文件容错、currentVersion | Task 1 |
| §6 缺失/孤儿 id 展示、globalComment-only 轮次 | Task 3（annotationResult unknown）+ Task 4（渲染） |
| §6 完成态推断（processed-no-outcome / in-flight） | Task 3（roundState）+ Task 4 + Task 7 |
| §6 consumeSubmitted(seq) 防串轮 | Task 5 + Task 7（多批在途 E2E） |
| §7 review log（命名、写失败、同日标题） | Task 8（SKILL §4 + eval 5） |
| §9 测试计划 | Task 1/2/3（node）+ Task 6/7（E2E）+ Task 8（清单/eval） |
| §11 发布 bump version | Task 9 |
| Non-goals（R3 快照/回滚等） | 计划不含（正确） |

无缺口。

**2. Placeholder 扫描：** 无 TBD/TODO/"add error handling"占位；每个 code step 均给出完整可用代码（Task 4 Step 2 已收敛为单一 `initHistory`，无并列草稿）。

**3. 类型/命名一致性：**
- `consumeSubmitted(seq)` 在 Task 5 定义、Task 6 调用，签名一致。
- `hasSubmittedInFlight()` Task 5 定义、Task 6 调用，一致。
- `initHistory({ historyEl }) → { render(data) }`：Task 4 定义、Task 6 用 `hist.render(data)`，一致。
- `roundState` / `annotationResult` / `roundChangedDoc`：Task 3 定义并测试、Task 4/6 使用，签名一致。
- `connectEvents({ onDocChanged, onOutcome, onHello, onStatus })`：Task 6 sse.mjs 定义、main.mjs 传入一致。
- outcome 字段 `type/seq/results[{id,status,note}]/globalComment{status,note}`：Task 2 测试、Task 3 消费、Task 4 渲染、Task 6 E2E、Task 8 契约，四处字段名一致。
- `#history` / `#history-head` / `#history-rounds`：Task 4 app.html 定义、initHistory 查询、CSS、E2E 选择器一致。

无不一致。
