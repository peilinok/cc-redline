# cc-redline 评审历史闭环（R1+R2）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 cc-redline 的已处理批注不再"阅后即焚"——AI 编辑落地后批注转入右栏只读历史区（含每条 applied/skipped 及说明），解锁由处理回执驱动并以 `/api/history` 对账兜底（根除"永久等待/永久锁死"），并在评审结束时把全过程落成持久 review log。

**Architecture:** 沿用"两进程 + STATE_DIR 文件协议"，全部加法。新增 `outcome-<seq>.json`（agent 原子写的处理回执）与 `GET /api/history`（聚合已提交轮次 + 回执）。**事件模型解耦**：SSE `outcome` 事件负责落历史 + 横幅，`doc-changed` 退化为只重渲染文档；**解锁的唯一事实源是 `/api/history`**——每次刷新历史时，凡不再 `in-flight` 的轮次即释放其批次（按 seq 幂等），于是 load / SSE 重连 / doc-changed / outcome 四条路径都能自愈。前端新增纯展示模块 `history.mjs`。R2 的 review log 是 agent 行为，由 `SKILL.md` + `evals.json` 驱动，无新增代码。

**Tech Stack:** 纯 Node ESM（`node:` builtins，零运行时依赖）；前端 vanilla ESM（无框架，vendored 库）；测试 `node:test` + Playwright E2E。

## Global Constraints

每个 task 的要求都隐含包含本节。

- **Node.js >= 18**。
- **零运行时依赖**：server 只用 `node:` builtins；前端库全部 vendored 于 `assets/vendor/`，不新增 npm 依赖。
- **状态文件原子写**：`.tmp` + `rename`。`outcome-<seq>.json` 由 agent 按此写（SKILL 指令）。
- **不碰**：`quotedSource` 字节精确、`sliceLines` 源保真（含 CRLF）、`serveStatic` 路径穿越防护、`wait_for_review.mjs` 的消费逻辑与退出码（0/2/3）、submission JSON 的既有字段。
- **协议三件套 lockstep**：`SKILL.md`、`evals/evals.json`、实现必须同一 PR 同步（本期还需同步 `CLAUDE.md` 的架构清单）。
- **i18n**：所有 UI 串走 `t()`；写入 submission/outcome JSON 的值语言中立（英文 `scope` key、`DOC_START`、英文 `status` key）。**新增键必须 en/zh 成对**——`i18n.test.mjs` 有 key 集合对称断言，漏一侧即红。
- **前端改动**：跑 `SKILL.md` Manual acceptance checklist + E2E。
- **关键路径事实**（已核实，勿再假设）：
  - E2E 在**仓库根** `e2e/`（`playwright.config.mjs` 的 `testDir: './e2e'`），**不在** `skills/cc-redline/e2e/`。
  - `app.css:17` 是 `#banner[hidden], #popover[hidden], #selection-btn[hidden] { display: none !important; }`——本仓库**没有**通用 `[hidden]` reset，任何带 `display:` 的新 id 想用 `hidden` 属性都必须加进这条规则。
  - `#rail` 是 `position:absolute; top:0; right:16px; width:300px`（在 `#doc-pane` 内）；`#ruler` 是最右的 16px flex 列。
  - `anchorEl()`（`annotate.mjs:456-474`）在 raw 模式与 selection 分支都会 **fallback 到 `a.startLine`**——仅清空 `blockId` 无法阻止重锚。
- **测试命令**（用 glob，勿用裸目录）：
  - 全量单测：`node --test skills/cc-redline/scripts/tests/*.test.mjs`
  - 单文件：`node --test skills/cc-redline/scripts/tests/server.test.mjs`
  - E2E（需 `npm ci` 一次 + 系统 Chrome）：`npm run test:e2e`

**工作分支**：`spec/review-history`（已存在）。

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

- `status` ∈ `"applied" | "skipped"`。部分完成记 `applied` + 在 `note` 说明。
- `globalComment` 仅当该轮提交含全局评论时出现。
- **`results` 与 submission 的 `annotations` 非强制双射**：agent 只为"它实际处理过的"批注写条目；未列出的批注在 UI 中显示中性 `—`。SKILL.md 与 evals 的措辞必须与此一致（不得要求逐条齐全）。

**`GET /api/history`** 响应：

```json
{
  "currentVersion": 4,
  "rounds": [
    { "seq": 1, "submittedAt": "...", "docVersion": 2,
      "globalComment": "…或 null",
      "annotations": [ /* submission 的 annotations 原文 */ ],
      "outcome": { /* outcome-1.json 内容，或 null */ } }
  ]
}
```

- `rounds` 按 `seq` 升序；逐文件容错（任一文件损坏按"缺失"降级，绝不 500）。
- **损坏的 submission 不丢弃整轮**：降级为 `annotations: []` 的占位轮次，保证用户能看到"有这么一轮"。

---

## Task 1: server `GET /api/history` 聚合路由

**Files:**
- Modify: `skills/cc-redline/scripts/server.mjs`（在 `/api/doc` 路由块之后插入）
- Test: `skills/cc-redline/scripts/tests/server.test.mjs`

**Interfaces:**
- Consumes: 既有 `createApp({file, stateDir, ...})`、闭包 `version`、`json(res, code, obj)`、`stateDir`。
- Produces: `GET /api/history` → `{ currentVersion:number, rounds:[{seq,submittedAt,docVersion,globalComment,annotations,outcome}] }`。Task 3/4/6 依赖此形状。

- [ ] **Step 1: 写失败测试**

在 `server.test.mjs` 末尾追加：

```js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test --test-name-pattern="api/history" skills/cc-redline/scripts/tests/server.test.mjs`
Expected: FAIL（路由不存在 → 404，`body.rounds` undefined）

- [ ] **Step 3: 实现路由**

在 `server.mjs` 中，紧接以下这行所在的 `if` 块之后插入新块（该行全文唯一，可作锚点）：

```js
        return json(res, 200, { file: docFile, content, version });
```

插入：

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

Run: `node --test skills/cc-redline/scripts/tests/*.test.mjs` → 全绿

```bash
git add skills/cc-redline/scripts/server.mjs skills/cc-redline/scripts/tests/server.test.mjs
git commit -m "feat(server): add GET /api/history aggregating rounds + outcomes"
```

---

## Task 2: server outcome 探测 + SSE `outcome` 广播

**Files:**
- Modify: `skills/cc-redline/scripts/server.mjs`
- Test: `skills/cc-redline/scripts/tests/server.test.mjs`

**Interfaces:**
- Consumes: 既有 `broadcast(event, data)`、`submitSeq`、`stateDir`、`watchIntervalMs`（`createApp` 默认 500）。
- Produces: `outcome-<seq>.json` 出现并解析成功时广播 `event: outcome` / `data: {"seq":<n>}`，每 seq 至多一次。Task 6 的 `onOutcome` 依赖它。
- **副作用须知**：`watchOutcome` 会为每个未完成 seq 留一个 `fs.watchFile`，它 **ref 住事件循环**，只在 `server.close()` 时解开。任何"只调 `createApp()` 而不 `listen()`/`close()`"的新测试会让 `node --test` 挂住——新测试一律走既有的 `listen(t, opts)` helper（它注册了 `t.after(server.close)`）。

- [ ] **Step 1: 写失败测试（含真正的去重断言 + 重启重建）**

在 `server.test.mjs` 追加两条。注意"只播一次"必须用**递增 mtime 再触发一次 stat 变化**来验证（否则任何实现都能通过——`unwatchFile` 已同步执行且 mtime 不再变）：

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
    await fetch(base + '/api/submit', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ annotations: [{ id: 'a1', comment: 'x' }] }),
    });
    const file = path.join(stateDir, 'outcome-1.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify({ type: 'outcome', seq: 1, results: [{ id: 'a1', status: 'applied' }] }));
    fs.renameSync(file + '.tmp', file);

    const deadline = Date.now() + 5000;
    while (!frames.some((f) => f.event === 'outcome') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(frames.filter((f) => f.event === 'outcome').length, 1, 'exactly one outcome frame');
    assert.equal(frames.find((f) => f.event === 'outcome').data.seq, 1);

    // Force several further stat changes: a still-watching implementation would
    // re-broadcast. This is what makes the de-dup assertion real.
    for (let i = 1; i <= 4; i++) {
      const ts = new Date(Date.now() + i * 1000);
      fs.utimesSync(file, ts, ts);
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(frames.filter((f) => f.event === 'outcome').length, 1, 'no re-broadcast after further mtime changes');
  } finally {
    req.destroy();
  }
});

test('outcome watches are re-armed on restart for consumed rounds lacking an outcome', async (t) => {
  const { md, stateDir } = setup();
  fs.mkdirSync(stateDir, { recursive: true });
  // a round submitted+consumed before this server started, with no outcome yet
  fs.writeFileSync(path.join(stateDir, 'submission-1.json.consumed'), JSON.stringify({
    seq: 1, submittedAt: 't', docVersion: 1, annotations: [{ id: 'a1' }],
  }));
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
    const file = path.join(stateDir, 'outcome-1.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify({ type: 'outcome', seq: 1, results: [] }));
    fs.renameSync(file + '.tmp', file);
    const deadline = Date.now() + 5000;
    while (!frames.some((f) => f.event === 'outcome') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(frames.some((f) => f.event === 'outcome' && f.data.seq === 1), 're-armed watch broadcast');
  } finally {
    req.destroy();
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test --test-name-pattern="outcome" skills/cc-redline/scripts/tests/server.test.mjs`
Expected: FAIL（无 outcome 帧）

- [ ] **Step 3: 实现 outcome 探测**

(a) 在 `broadcast` 函数定义之后（锚点：`  function broadcast(event, data) {` 所在块的结束 `}` 之后）插入：

```js
  // Detect each round's outcome-<seq>.json without a standing poll loop: watch
  // the specific known path (reuses fs.watchFile, same as the doc watcher),
  // broadcast once, then stop watching. A missed broadcast self-heals via the
  // client's /api/history reconciliation.
  const announcedOutcomes = new Set();
  const watchedOutcomeSeqs = new Set();
  function watchOutcome(seq) {
    if (announcedOutcomes.has(seq) || watchedOutcomeSeqs.has(seq)) return;
    const file = path.join(stateDir, `outcome-${seq}.json`);
    const announce = () => {
      announcedOutcomes.add(seq);
      if (watchedOutcomeSeqs.delete(seq)) fs.unwatchFile(file);
      broadcast('outcome', { seq });
    };
    // Already on disk (stale STATE_DIR / outcome landed while we were down):
    // fs.watchFile would never fire for a file that does not change again.
    try {
      JSON.parse(fs.readFileSync(file, 'utf8'));
      announcedOutcomes.add(seq);
      return; // nothing to broadcast to: no client can be waiting on a pre-existing file
    } catch { /* not there yet → watch for it */ }
    watchedOutcomeSeqs.add(seq);
    // watchFile fires on stat changes; the first fire may be the ENOENT baseline,
    // whose readFileSync throws and is swallowed until the file really lands.
    fs.watchFile(file, { interval: watchIntervalMs }, () => {
      if (announcedOutcomes.has(seq)) return;
      try { JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
      announce();
    });
  }
  // Re-arm watches for any submitted round still lacking an outcome — survives a
  // restart with the same STATE_DIR.
  for (const name of (fs.existsSync(stateDir) ? fs.readdirSync(stateDir) : [])) {
    const m = /^submission-(\d+)\.json(\.consumed)?$/.exec(name);
    if (m) watchOutcome(Number(m[1]));
  }
```

(b) 在 `/api/submit` 处理里挂载。**锚点必须用两行**——`fs.renameSync(target + '.tmp', target);` 单独一行在本文件出现 **2 次**（submit 与 done 分支逐字节相同），只有配上下一行才唯一。把：

```js
        fs.renameSync(target + '.tmp', target); // atomic: the wait script never sees partial JSON
        return json(res, 200, { ok: true, seq: submitSeq });
```

改为：

```js
        fs.renameSync(target + '.tmp', target); // atomic: the wait script never sees partial JSON
        watchOutcome(submitSeq);
        return json(res, 200, { ok: true, seq: submitSeq });
```

(c) 把 `server.on('close', ...)` 整块改为：

```js
  server.on('close', () => {
    clearInterval(heartbeat);
    fs.unwatchFile(docFile);
    for (const seq of watchedOutcomeSeqs) fs.unwatchFile(path.join(stateDir, `outcome-${seq}.json`));
    watchedOutcomeSeqs.clear();
  });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test --test-name-pattern="outcome" skills/cc-redline/scripts/tests/server.test.mjs`
Expected: PASS（两条）

- [ ] **Step 5: 全量回归 + 提交**

Run: `node --test skills/cc-redline/scripts/tests/*.test.mjs` → 全绿

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
- Produces（纯函数，浏览器与 node:test 共享，无 DOM）：
  - `roundState(round, currentVersion) → 'resolved' | 'processed-no-outcome' | 'in-flight'`
  - `annotationResult(round, annId) → { status: 'applied'|'skipped'|'unknown', note: string }`
  - `roundChangedDoc(round) → boolean | null`
  Task 4 渲染、Task 6 解锁与横幅都依赖这三个。

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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test skills/cc-redline/scripts/tests/history.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现纯函数**

创建 `skills/cc-redline/assets/js/history.mjs`：

```js
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test skills/cc-redline/scripts/tests/history.test.mjs`
Expected: PASS（全部 11 条）

- [ ] **Step 5: 提交**

```bash
git add skills/cc-redline/assets/js/history.mjs skills/cc-redline/scripts/tests/history.test.mjs
git commit -m "feat(history): pure round-state / result / changed-doc derivations"
```

---

## Task 4: 历史区 DOM 渲染 + 容器 + 样式 + i18n

**Files:**
- Modify: `skills/cc-redline/assets/js/history.mjs`（追加 `initHistory`）
- Modify: `skills/cc-redline/assets/app.html`
- Modify: `skills/cc-redline/assets/app.css`
- Modify: `skills/cc-redline/assets/js/i18n.mjs`
- Test: 无 node 单测（DOM）；Task 7 E2E 覆盖。验收 = 语法 OK + i18n 对称断言绿 + 现有测试不回归。

**Interfaces:**
- Consumes: Task 3 的 `roundState`/`annotationResult`；`i18n.mjs` 的 `t`。
- Produces: `initHistory({ historyEl }) → { render(data) }`。Task 6 调用 `hist.render(data)`。

- [ ] **Step 1: 追加 i18n 键（en/zh 必须成对）**

在 `i18n.mjs` 的 `en` 表内、`'render.failed': 'Render failed: {err}',` 这一行之前插入：

```js
    'history.title': 'Processed ({n})',
    'history.round': 'Round {seq}',
    'history.global': 'Overall',
    'history.status.applied': 'Applied',
    'history.status.skipped': 'Skipped',
    'history.status.unknown': 'No per-item note',
    'history.state.processed': 'Processed (no outcome recorded)',
    'history.state.inflight': 'Processing…',
    'banner.roundApplied': 'This round is processed; updating the document…',
    'banner.roundNoChange': 'This round is processed (no changes to the document).',
    'banner.inflight': 'Processing your submitted annotations…',
```

在 `zh` 表内、`'render.failed': '渲染失败：{err}',` 这一行之前插入：

```js
    'history.title': '已处理（{n}）',
    'history.round': '第 {seq} 轮',
    'history.global': '整体意见',
    'history.status.applied': '已应用',
    'history.status.skipped': '已跳过',
    'history.status.unknown': '无单条说明',
    'history.state.processed': '已处理（无回执记录）',
    'history.state.inflight': '处理中…',
    'banner.roundApplied': '本轮已处理，文档更新中…',
    'banner.roundNoChange': '本轮已处理（文档无改动）。',
    'banner.inflight': '正在处理已提交的批注…',
```

- [ ] **Step 2: 追加 DOM 渲染到 `history.mjs`**

在 `history.mjs` 顶部加 import（node 单测安全：`i18n.mjs` 模块顶层无 DOM 访问）：

```js
import { t } from './i18n.mjs';
```

在文件末尾追加。卡片按规格 §6 展示 **scope 标签 + comment + quotedSource 摘录（前 3 行）+ 徽标 + note**；标题只计**非 in-flight** 轮次，避免刚提交就显示"已处理"：

```js
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
```

- [ ] **Step 3: 新增 `#history` 容器（默认折叠）**

在 `app.html` 的 `<button id="selection-btn" hidden data-i18n="selection.btn"></button>` 这一行之前插入：

```html
  <aside id="history" class="collapsed" hidden>
    <button id="history-head" type="button"></button>
    <div id="history-rounds"></div>
  </aside>
```

- [ ] **Step 4: 样式（含 `hidden` 修复）**

(a) **必做**：把 `app.css` 的这一行

```css
#banner[hidden], #popover[hidden], #selection-btn[hidden] { display: none !important; }
```

改为

```css
#banner[hidden], #popover[hidden], #selection-btn[hidden], #history[hidden] { display: none !important; }
```

> 本仓库没有通用 `[hidden]` reset。少了这条，`#history { display:flex }` 会压过 UA 的 `[hidden]{display:none}`，空面板常驻，且 Task 7 的可见性断言会退化为永真。

(b) 在 `app.css` 末尾追加（`right: 26px` 让出最右 16px 的 `#ruler`；默认折叠只占一条，不遮挡 `#rail`）：

```css
#history {
  position: fixed;
  right: 26px;
  bottom: 16px;
  width: 300px;
  max-width: calc(100vw - 42px);
  max-height: 50vh;
  display: flex;
  flex-direction: column;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(140, 149, 159, .25);
  z-index: 35;
  overflow: hidden;
  font-size: 13px;
}
#history-head {
  flex: 0 0 auto;
  text-align: left;
  padding: 6px 12px;
  font-weight: 600;
  color: var(--muted);
  background: #f6f8fa;
  border: none;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
}
#history.collapsed #history-rounds { display: none; }
#history.collapsed #history-head { border-bottom: none; }
#history-rounds { overflow-y: auto; padding: 6px; }
.history-round { margin-bottom: 6px; }
.history-round > summary { cursor: pointer; padding: 4px 6px; color: var(--muted); }
.history-round-tag { margin-left: 6px; color: var(--muted); font-size: 11px; }
.history-card { padding: 4px 6px; color: var(--muted); }
.history-card-head { display: flex; align-items: baseline; gap: 6px; }
.history-badge { font-weight: 700; flex: none; }
.history-scope { flex: none; font-size: 11px; border: 1px solid var(--border); border-radius: 3px; padding: 0 4px; }
.history-card-comment { color: #1f2328; }
.history-excerpt { margin-left: 20px; font-size: 12px; white-space: pre-wrap; opacity: .75; max-height: 4.5em; overflow: hidden; }
.history-card-note { margin-left: 20px; font-size: 12px; opacity: .8; }
.history-card.status-applied .history-badge { color: #1a7f37; }
.history-card.status-skipped .history-badge { color: var(--danger); }
.history-card.status-unknown .history-badge { color: var(--muted); }
body.ann-hidden #history { display: none; }
```

- [ ] **Step 5: 校验语法 + i18n 对称 + 现有测试不回归**

Run: `node --check skills/cc-redline/assets/js/history.mjs` → 无输出

Run: `node --test skills/cc-redline/scripts/tests/*.test.mjs`
Expected: 全绿（尤其 `i18n.test.mjs` 的 en/zh key 集合对称断言）

- [ ] **Step 6: 提交**

```bash
git add skills/cc-redline/assets/js/history.mjs skills/cc-redline/assets/app.html skills/cc-redline/assets/app.css skills/cc-redline/assets/js/i18n.mjs
git commit -m "feat(history): render read-only history panel (accordion + badges + i18n)"
```

---

## Task 5: `annotate.mjs` — 按 seq 标记/释放 + 在途批注不重锚

> **门禁提示**：Task 5 与 Task 6 是**一个绿色单元**。Task 5 单独提交后，`main.mjs` 仍在无参调用 `consumeSubmitted()`，两条既有 E2E 会暂红（见 Step 5）。不要在 Task 5 之后 push 或验收 E2E；Task 6 完成后一并转绿。

**Files:**
- Modify: `skills/cc-redline/assets/js/annotate.mjs`
- Test: 语法检查 + Task 6/7 的 E2E。

**Interfaces:**
- Consumes: `/api/submit` 响应 `{ ok, seq }`。
- Produces（public API，Task 6 依赖）：
  - `consumeSubmitted(seq: number)` — 只移除 `a.seq === seq` 的批注；`seq` 非数字时**直接返回**（防御）。
  - `hasSubmittedInFlight(): boolean`。

- [ ] **Step 1: 声明 `globalSeq`**

把这一整行（注意带行尾注释）：

```js
  let globalSubmitted = false; // globalComment sent and awaiting the AI's edit
```

改为：

```js
  let globalSubmitted = false; // globalComment sent and awaiting the AI's edit
  let globalSeq = null; // which submitted seq owns the current globalComment
```

- [ ] **Step 2: 提交时记录 seq**

把 submit handler 里的这四行：

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

- [ ] **Step 3: 在途批注在文档刷新后停止锚定**

规格 §6 要求 doc-changed 刷新时**不重锚在途 submitted 批注**。仅清空 `blockId` 不够——`anchorEl()` 在 raw 模式与 selection 分支都会 fallback 到 `a.startLine`，仍会锚到编辑后文档的**错误**位置（`blocks.mjs` 的块 id 是位置序号 `'b'+idx++`，一定命中某个块）。用显式标记跳过。

> **锚点警告（已核实）**：`for (const a of annotations) {` 在本文件出现 **4 次**——applyHighlights 内 2 次（`:403` 4 空格缩进、`:429` 6 空格）、`renderRail`（`:550` 6 空格）、`getMarkers`（`:581` 4 空格）。两两缩进相同，**单行锚点必然改错函数**。下面每处都给出**两行**锚点（含精确缩进），必须整体匹配。

(a) `applyHighlights` 开头引入 `live`。把：

```js
  function applyHighlights() {
    clearHighlights();
    const srcLines = getDoc().content.split('\n');
```

改为：

```js
  function applyHighlights() {
    clearHighlights();
    // In-flight batches whose document has since been replaced must not be
    // re-anchored: their line/block anchors point at the pre-edit document.
    const live = annotations.filter((a) => !a.staleAnchor);
    const srcLines = getDoc().content.split('\n');
```

(b) 该函数体内 4 处读取改用 `live`（1、3 单行唯一；2、4 必须两行匹配）：

1. `      const touching = annotations.filter((a) =>` → `      const touching = live.filter((a) =>`
2. render-selection 段（4 空格 + 6 空格）：把

```js
    for (const a of annotations) {
      if (a.scope !== 'selection') continue;
```

改为

```js
    for (const a of live) {
      if (a.scope !== 'selection') continue;
```

3. `        if (annotations.some((a) => a.scope !== 'selection' && a.startLine <= ln && a.endLine >= ln)) {` → 把 `annotations.some` 换成 `live.some`，整行其余不变
4. raw-selection 段（6 空格 + 8 空格）：把

```js
      for (const a of annotations) {
        if (a.scope !== 'selection') continue;
```

改为

```js
      for (const a of live) {
        if (a.scope !== 'selection') continue;
```

末尾 "Tag submitted annotations' inline marks" 那段继续用 `annotations`，**不要改**（它只给已存在的 mark 加 class；stale 批注已无 mark）。

(c) `renderRail` 跳过 stale（两行，6 空格 + 8 空格）。把：

```js
      for (const a of annotations) {
        const anchor = anchorEl(a);
```

改为：

```js
      for (const a of annotations) {
        if (a.staleAnchor) continue;
        const anchor = anchorEl(a);
```

(d) `getMarkers` 跳过 stale（两行，4 空格 + 6 空格）。把：

```js
    for (const a of annotations) {
      const anchor = anchorEl(a);
```

改为：

```js
    for (const a of annotations) {
      if (a.staleAnchor) continue;
      const anchor = anchorEl(a);
```

(e) `orderedAnns` 过滤（`return annotations` 全文唯一）。把：

```js
    return annotations
      .map((a) => { const el = anchorEl(a); return el ? { a, y: el.getBoundingClientRect().top - paneRect.top + scrollTop } : null; })
```

改为：

```js
    return annotations
      .filter((a) => !a.staleAnchor)
      .map((a) => { const el = anchorEl(a); return el ? { a, y: el.getBoundingClientRect().top - paneRect.top + scrollTop } : null; })
```

(f) 在 public API 的 `onDocRerendered: () => {`（全文唯一）之后第一行插入：

```js
    onDocRerendered: () => {
      // The document was replaced (an agent edit landed). Anchors of still-in-flight
      // batches are stale; stop drawing them — their round's history entry takes over.
      for (const a of annotations) if (a.submitted) a.staleAnchor = true;
```

- [ ] **Step 4: `consumeSubmitted(seq)` + `hasSubmittedInFlight`**

把 public API 里的这一整块：

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
    // A round's outcome landed (or /api/history says it is no longer in flight):
    // release only that seq's batch, keeping drafts and other in-flight batches.
    // Idempotent, so load / reconnect / doc-changed / outcome can all call it.
    consumeSubmitted: (seq) => {
      if (typeof seq !== 'number') return; // guard: never let a stray call wipe drafts
      const before = annotations.length;
      annotations = annotations.filter((a) => a.seq !== seq);
      const hadGlobal = globalSubmitted && globalSeq === seq;
      if (hadGlobal) { globalComment = ''; globalSubmitted = false; globalSeq = null; updateGlobalBtn(); }
      if (before !== annotations.length || hadGlobal) refreshUi();
    },
    hasSubmittedInFlight: () => annotations.some((a) => a.submitted),
```

- [ ] **Step 5: 校验语法 + 提交（暂不验收 E2E）**

Run: `node --check skills/cc-redline/assets/js/annotate.mjs` → 无输出

Run: `node --test skills/cc-redline/scripts/tests/*.test.mjs` → 全绿（单测不碰 annotate）

> 此时 `e2e/review.spec.mjs` 有**两条**会暂红，因为 `main.mjs` 还在无参调用 `consumeSubmitted()`（`seq` 为 `undefined`，被新守卫拦下，什么都不释放）：
> - `submit → agent protocol / applying the edit … consumes the submitted batch`
> - `live reload safety / a file change with pending drafts shows a confirm banner`
> 两者都在 Task 6 转绿。

```bash
git add skills/cc-redline/assets/js/annotate.mjs
git commit -m "feat(annotate): per-seq batch release; stop re-anchoring in-flight batches"
```

---

## Task 6: 事件模型接线（`sse.mjs` + `main.mjs`）+ 修复既有 E2E

**Files:**
- Modify: `skills/cc-redline/assets/js/sse.mjs`
- Modify: `skills/cc-redline/assets/js/main.mjs`
- Modify: `e2e/review.spec.mjs`（**仓库根**目录）
- Test: `npm run test:e2e`

**Interfaces:**
- Consumes: Task 2 的 SSE `outcome`、server `hello`；Task 1 的 `/api/history`；Task 3 的 `roundState`/`roundChangedDoc`；Task 4 的 `initHistory`；Task 5 的 `consumeSubmitted(seq)`/`hasSubmittedInFlight`。
- Produces: 解耦事件循环 + **以 `/api/history` 为解锁事实源的对账**。

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

在 import 区的 `import { initRuler } from './ruler.mjs';` 之后加：

```js
import { initHistory, roundState, roundChangedDoc } from './history.mjs';
```

在 `els` 对象里，`navNext: document.getElementById('nav-next'),` 之后加：

```js
  history: document.getElementById('history'),
```

- [ ] **Step 3: 初始化 history + 带对账解锁的 refreshHistory**

在 `ruler = initRuler({...});` 整块之后插入。**这是解锁的唯一事实源**——凡不再 in-flight 的轮次即释放其批次，因此 load / 重连 / doc-changed / outcome 四条路径全都自愈；`consumeSubmitted(seq)` 按 seq 幂等，重复调用无害：

```js
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
```

- [ ] **Step 4: 改 `connectEvents` 接线**

把 `main.mjs` 底部的 `connectEvents({ ... });` 整块替换为：

```js
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
```

- [ ] **Step 5: 语言切换重渲染历史区 + 页面 load 拉历史**

(a) 把 langchange 监听整块：

```js
window.addEventListener('cc-redline:langchange', () => {
  applyStaticI18n(document); // topbar + popover + #content handles (data-i18n-label)
  ann.reflow();              // rebuild rail cards / scope labels in the new language
});
```

改为：

```js
window.addEventListener('cc-redline:langchange', () => {
  applyStaticI18n(document); // topbar + popover + #content handles (data-i18n-label)
  ann.reflow();              // rebuild rail cards / scope labels in the new language
  if (lastHistory) hist.render(lastHistory); // history panel is rendered via t(), not data-i18n
});
```

(b) 把文件末尾这两行（必须**两行一起**匹配——`await loadDoc();` 单行在本文件出现 2 次）：

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

- [ ] **Step 6: 更新受协议变更影响的既有 E2E（仓库根 `e2e/review.spec.mjs`）**

把 `applying the edit (file change) consumes the submitted batch and refreshes` 整个 `test(...)` 块替换为：

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
    await expect(page.locator('.rail-card')).toHaveCount(0); // active batch released
    await expect(page.locator('#history')).toBeVisible();
    await expect(page.locator('#history .history-card.status-applied')).toContainText('expand this');
    await expect(page.locator('#content .block.changed')).toContainText('expanded by the agent');
  });
```

- [ ] **Step 7: 跑 E2E**

Run: `npm run test:e2e`
Expected: 全绿——包括 Task 5 提到的两条（`pending drafts shows a confirm banner` 因守卫 + 按 seq 释放而恢复）。

- [ ] **Step 8: 提交**

```bash
git add skills/cc-redline/assets/js/sse.mjs skills/cc-redline/assets/js/main.mjs e2e/review.spec.mjs
git commit -m "feat(ui): outcome + /api/history reconciliation drives unlock; doc-changed only re-renders"
```

---

## Task 7: 历史闭环专项 E2E

**Files:**
- Modify: `e2e/review.spec.mjs`（**仓库根**目录）
- Test: `npm run test:e2e`

- [ ] **Step 1: 写新用例**

在 `e2e/review.spec.mjs` 末尾追加：

```js
test.describe('review history', () => {
  test('the history panel is hidden until a round settles', async ({ page, review }) => {
    await page.goto(review.url);
    await expect(page.locator('#history')).toBeHidden();
    await addBlockAnnotation(page, 'First paragraph with', 'still in flight');
    await page.locator('#btn-submit').click();
    await waitForFile(path.join(review.stateDir, 'submission-1.json'));
    await expect(page.locator('#history')).toBeHidden(); // in-flight rounds do not count
  });

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
    await expect(page.locator('#history .history-card.status-skipped')).toContainText('anchor ambiguous');
  });

  test('multiple in-flight batches: the first outcome releases only its own seq', async ({ page, review }) => {
    await page.goto(review.url);
    await addBlockAnnotation(page, 'First paragraph with', 'note one');
    await page.locator('#btn-submit').click();
    const sub1 = await waitForFile(path.join(review.stateDir, 'submission-1.json'));
    await addBlockAnnotation(page, 'Tail paragraph', 'note two');
    await page.locator('#btn-submit').click();
    await waitForFile(path.join(review.stateDir, 'submission-2.json'));
    await expect(page.locator('.rail-card.submitted')).toHaveCount(2);

    const id1 = sub1.annotations[0].id;
    const o1 = JSON.stringify({ type: 'outcome', seq: 1, results: [{ id: id1, status: 'applied', note: 'ok' }] });
    fs.writeFileSync(path.join(review.stateDir, 'outcome-1.json.tmp'), o1);
    fs.renameSync(path.join(review.stateDir, 'outcome-1.json.tmp'), path.join(review.stateDir, 'outcome-1.json'));

    await expect(page.locator('.rail-card.submitted')).toHaveCount(1, { timeout: 10_000 });
    await expect(page.locator('#history .history-card.status-applied')).toContainText('note one');
  });

  test('a round whose doc advanced without an outcome is released and marked processed', async ({ page, review }) => {
    await page.goto(review.url);
    await addBlockAnnotation(page, 'Tail paragraph', 'old-protocol agent');
    await page.locator('#btn-submit').click();
    await waitForFile(path.join(review.stateDir, 'submission-1.json'));

    // "old" agent: edits the doc, never writes an outcome
    fs.writeFileSync(review.mdPath, FIXTURE_MD.replace('Tail paragraph.', 'Tail paragraph, edited without an outcome.'));

    await expect(page.locator('#content')).toContainText('edited without an outcome', { timeout: 10_000 });
    await expect(page.locator('.rail-card')).toHaveCount(0); // released by reconciliation, never stuck
    await expect(page.locator('#history .history-round-tag')).toContainText('no outcome recorded');
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
    await expect(page.locator('#history .history-card.status-applied')).toContainText('keep me', { timeout: 10_000 });
  });
});
```

- [ ] **Step 2: 跑 E2E**

Run: `npm run test:e2e`
Expected: 全绿（新增 5 条 + 既有）

- [ ] **Step 3: 提交**

```bash
git add e2e/review.spec.mjs
git commit -m "test(e2e): history panel visibility, all-skip unlock, per-seq release, no-outcome reconciliation, reload"
```

---

## Task 8: 协议与文档 lockstep（`SKILL.md` + `evals.json` + `CLAUDE.md`）

**Files:**
- Modify: `skills/cc-redline/SKILL.md`
- Modify: `skills/cc-redline/evals/evals.json`
- Modify: `CLAUDE.md`（仓库根：架构清单需同步新增的状态文件 / 路由 / SSE 事件 / 前端模块）
- Test: `claude plugin validate . --strict` + 字段级人工核对。

- [ ] **Step 1: `SKILL.md` §3 增加写回执步骤**

把 §3 结尾这一整段（3 行）：

```markdown
After applying: save the file (the browser refreshes itself via the file watcher — do
not try to notify it), reply with a 2-3 sentence summary of what changed and anything
skipped, then loop back to the wait command.
```

整段替换为：

```markdown
After processing every annotation in the submission, and **before saving the file**,
write a processing outcome so the browser can release the batch and show each
annotation's result. This also covers the all-skipped case, where the file does not
change at all:

- Write `$STATE_DIR/outcome-<seq>.json` **atomically** (write `outcome-<seq>.json.tmp`,
  then rename it into place — never a partial file). Shape:

      { "type": "outcome", "seq": <the submission's seq>,
        "results": [ { "id": "<annotation id>", "status": "applied" | "skipped",
                       "note": "<short free-text explanation>" }, ... ],
        "globalComment": { "status": "applied" | "skipped", "note": "..." } }

  - One entry per annotation you acted on, keyed by the annotation's `id`. You do
    not have to list every annotation — anything you omit simply shows as having no
    per-item note.
  - Use `skipped` (with a `note` saying why) for anything you could not anchor or
    that was unclear — the same honest-skip rule as above, now visible in the page
    instead of only in chat. Partial work: use `applied` and say what you left out
    in the `note`.
  - Include `globalComment` only if the submission carried one.
  - `status` values are language-neutral English keys.

Then save the file (the browser refreshes itself via the file watcher — do not try to
notify it), reply with a 2-3 sentence summary of what changed and anything skipped,
then loop back to the wait command.
```

- [ ] **Step 2: `SKILL.md` §4 增加 review log**

在 §4 "Ending" 的 `- Page button "End review" → ...` 那条之后插入：

```markdown
- On End review, before summarizing, offer to write a **review log**: read the
  `submission-<seq>.json(.consumed)` and `outcome-<seq>.json` files in `STATE_DIR`
  and append one dated section to a log file next to the reviewed doc. The file name
  is the doc's name with a trailing `.md` stripped, plus `.review-log.md` (e.g.
  `spec.md` → `spec.review-log.md`, `README` → `README.review-log.md`,
  `notes.txt` → `notes.txt.review-log.md`). Append a `## Review <YYYY-MM-DD HH:MM>`
  section (the time avoids colliding with an earlier review the same day) listing,
  per round, each annotation's comment and its outcome (applied / skipped + note),
  and mention the log's path in your closing summary. If the user declines, skip it.
  If the target directory is not writable, report and skip — do not fail the ending.
```

- [ ] **Step 3: `SKILL.md` Manual acceptance checklist 更新（两处）**

(a) 把这一条：

```markdown
- [ ] Submit writes `submission-<seq>.json`; submitted annotations lock in place as
      "Submitted" (edit/delete hidden) instead of clearing, new draft annotations can still be
      added, the waiting banner shows, and the submitted batch clears when the AI's edit lands
```

替换为：

```markdown
- [ ] Submit writes `submission-<seq>.json`; submitted annotations lock in place as
      "Submitted" (edit/delete hidden) instead of clearing, new draft annotations can still be
      added, the waiting banner shows
- [ ] When the agent writes `outcome-<seq>.json`, that batch is released into the
      right-hand "Processed" history panel with per-annotation ✓ applied / ⊘ skipped
      badges, scope label and quoted excerpt — including an all-skipped round (no file
      change), which still releases and shows a "no changes" banner (never a permanent wait)
- [ ] The history panel is hidden until a round settles, survives a page reload /
      SSE reconnect (rebuilt from `/api/history`), and follows the language switch
- [ ] A round whose document advanced but which never got an outcome is still released
      and shown as "no outcome recorded" (old-protocol agents never strand the page)
- [ ] On End review, a `<doc>.review-log.md` is offered/written next to the doc
```

(b) 把这一条：

```markdown
- [ ] Multiple submissions queue and are consumed in seq order
```

替换为（按 seq 精确释放后，多轮不再要求按序消费）：

```markdown
- [ ] Multiple submissions queue; each batch is released independently by its own
      seq, so an outcome for one round never clears another round's cards
```

- [ ] **Step 4: `evals.json` 更新**

(a) 把 `id: 2` 的 `expected_output` 值替换为：

```
"Apply the annotation by locating the quotedSource text verbatim and rewriting it per the comment, atomically write outcome-<seq>.json recording what it applied or skipped before saving the file, report the change in 2-3 sentences, then immediately re-run the wait script."
```

(b) 在 `id: 2` 的 `expectations` 数组里，给现有最后一条末尾**补一个逗号**，再追加两条（措辞与 SKILL.md 一致——**不要**要求逐条齐全，契约是非双射）：

```json
        "Before saving the file, writes $STATE_DIR/outcome-<seq>.json atomically (tmp + rename), with an entry for each annotation it acted on, keyed by that annotation's id, using status applied or skipped.",
        "Records anything it could not anchor as status skipped with a note explaining why, rather than silently omitting the fact from the outcome."
```

(c) 在 `evals` 数组末尾（`id: 3` 对象之后，记得给它补逗号）追加：

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
        "Mentions the review log's path in the closing summary.",
        "Skips the log if the user declines or the target directory is not writable, without failing the ending.",
        "Summarizes rounds / annotations / main changes in chat."
      ]
    }
```

- [ ] **Step 5: `CLAUDE.md` 架构清单同步**

在 "Two processes + a file-based state protocol" 一节的 `STATE_DIR` 文件列表里加上 `outcome-<seq>.json`（agent 写的处理回执，原子写）；在 "Server" 一节的路由列表里加 `/api/history`，并说明新增 SSE `outcome` 事件与"解锁以 `/api/history` 对账为准"；在 "Front-end" 模块列表里加 `history.mjs`（只读历史区，纯推导函数被 node:test 共享）。改动保持该文件既有的简洁行文风格。

- [ ] **Step 6: 校验 + 提交**

Run: `claude plugin validate . --strict` → 通过

字段级人工核对：outcome 结构（`type/seq/results[{id,status,note}]/globalComment{status,note}`，`status` ∈ applied|skipped，**非双射**）在 `SKILL.md` §3、`evals.json`、`assets/js/history.mjs`、规格 §4.1 四处一致。

```bash
git add skills/cc-redline/SKILL.md skills/cc-redline/evals/evals.json CLAUDE.md
git commit -m "docs(skill): lockstep outcome-write + review-log protocol (SKILL.md + evals + CLAUDE.md)"
```

---

## Task 9: 收尾 —— 全量验证 + 发布

**Files:**
- Modify: `package.json`、`.claude-plugin/plugin.json`、`.claude-plugin/marketplace.json`（三处 `version` 当前均为 `0.2.0`）
- Modify: `CHANGELOG.md`（若存在；参照上次 release commit `12d20c6` 的做法）

- [ ] **Step 1: 全量单测**

Run: `node --test skills/cc-redline/scripts/tests/*.test.mjs` → 全绿（blocks / i18n / server / wait / history）

- [ ] **Step 2: 全量 E2E**

Run: `npm run test:e2e` → 全绿

- [ ] **Step 3: 三处版本同步 bump + CHANGELOG**

先确认现状：

```bash
git show --stat 12d20c6
grep -n '"version"' package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json
```

把三处 `"version": "0.2.0"` 全部改为 `"0.3.0"`（若实际值不是 0.2.0，按实际值 minor +1），并按上次 release 的格式给 `CHANGELOG.md` 追加一节，概述：处理回执 `outcome-<seq>.json`、只读历史面板、按 seq 释放批次、`/api/history` 对账解锁、review log。

- [ ] **Step 4: 重新校验清单并提交**

Run: `claude plugin validate . --strict` → 通过（bump 后需再校验一次）

```bash
git add package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json CHANGELOG.md
git commit -m "chore: release v0.3.0 — review history closure (R1+R2)"
```

- [ ] **Step 5: 打 tag 并完成分支**

```bash
git tag v0.3.0
```

调用 `superpowers:finishing-a-development-branch` 决定合并/PR 方式（本仓库遵循分支 + PR，不直推 main）。

---

## Self-Review

**1. Spec coverage（规格逐节 → task）：**

| 规格条目 | 覆盖 task |
|---|---|
| R1 历史区（分组、徽标、scope、摘录、note） | T1 + T3 + T4 Step 2 |
| R1 解锁由回执驱动 **且有对账兜底** | T2 + T5 Step 4 + T6 Step 3/4；E2E T7（全 skip、按 seq、无回执） |
| R1 全 skip 解锁 + 无改动横幅 | T2 + T6 Step 4 + T7 |
| R1 reload / SSE 重连恢复 | T6 Step 3/5 + T7 |
| §4.1 outcome 原子写、非双射、无 docChanged/partial | T3 `annotationResult` unknown + T8 Step 1/4 |
| §5 outcome 探测（watchFile + 启动重建 + 已存在文件短路） | T2 Step 3 + 两条测试 |
| §5 `/api/history` 升序 / currentVersion / 逐文件容错（含损坏 submission） | T1 |
| §6 缺失/孤儿 result、globalComment-only 轮次 | T3 + T4 Step 2 |
| §6 完成态推断（processed-no-outcome / in-flight） | T3 `roundState` + T4 + T7 第 4 条 E2E |
| §6 consumeSubmitted(seq) 防串轮 + `seq` 守卫 | T5 Step 4 + T7 第 3 条 E2E |
| §6 **doc-changed 刷新不重锚在途批注** | T5 Step 3（staleAnchor，覆盖 raw/selection 的 startLine fallback） |
| §6 i18n（含语言切换重渲染） | T4 Step 1 + T6 Step 5 |
| §7 review log（命名含非 .md、追加、同日带时间、写失败降级、提路径） | T8 Step 2 + eval 5 |
| §9 测试计划 | T1（2 条）+ T2（2 条）+ T3（11 条）+ T6/T7（E2E 6 条） |
| §11 发布（三处 bump + CHANGELOG + tag + 重校验） | T9 |
| Non-goals（R3 快照/回滚等） | 计划不含 |

**2. Placeholder 扫描：** 无 TBD/TODO/"add error handling"；每个 code step 均给出完整可用代码。

**3. 类型/命名一致性：**
- `consumeSubmitted(seq:number)`（T5 定义，含非数字守卫）↔ T6 Step 3/4 调用；`hasSubmittedInFlight()` 一致。
- `initHistory({historyEl}) → {render(data)}`（T4）↔ T6 `hist.render(lastHistory)` 一致。
- `roundState/annotationResult/roundChangedDoc`（T3 定义并测试）↔ T4 渲染、T6 对账与横幅一致；T6 Step 2 的 import 列表包含全部三者中实际用到的 `roundState`/`roundChangedDoc`。
- `connectEvents({onDocChanged,onOutcome,onHello,onStatus})`（T6 Step 1）↔ Step 4 传参一致。
- outcome 字段 `type/seq/results[{id,status,note}]/globalComment{status,note}`：T2 测试、T3 消费、T4 渲染、T6/T7 E2E、T8 契约五处一致。
- DOM id/class：`#history`/`#history-head`/`#history-rounds`/`.history-card.status-*`/`.history-round-tag`/`.history-scope`/`.history-excerpt`——T4 的 HTML+JS+CSS 与 T7 选择器一致。
- E2E 断言文案 ↔ T4 i18n en 值：`'no changes to the document'` ⊂ `banner.roundNoChange`；`'no outcome recorded'` ⊂ `history.state.processed`。

**4. 路径核对：** E2E 一律 `e2e/review.spec.mjs`（仓库根）；单测 `skills/cc-redline/scripts/tests/*.test.mjs`；`history.test.mjs` 的 `../../assets/js/history.mjs` 与 `i18n.test.mjs` 同深度。

**5. Edit 锚点唯一性（逐条 grep 核实）：**

| 锚点 | 出现次数 | 处置 |
|---|---|---|
| `fs.renameSync(target + '.tmp', target);`（server.mjs） | 2（submit / done 逐字节相同） | T2 Step 3(b) 用两行锚点（配 `return json(res, 200, { ok: true, seq: submitSeq });`） |
| `await loadDoc();`（main.mjs） | 2 | T6 Step 5(b) 必须 `setMode('render');` 两行一起匹配 |
| `for (const a of annotations) {`（annotate.mjs） | **4**（`:403`/`:429`/`:550`/`:581`，两两缩进相同） | T5 Step 3(b2)(b4)(c)(d) 全部用两行锚点 + 标注精确缩进 |
| `let globalSubmitted = false;` | 1 | T5 Step 1 引用带行尾注释整行 |
| `return annotations`、`onDocRerendered: () => {`、`const touching = annotations.filter((a) =>`、`annotations.some(` | 各 1 | 单行安全 |

**6. 外部事实核实（勿再假设）：** `playwright.config.mjs:6` 为 `testDir: './e2e'`，E2E 在仓库根且 `skills/cc-redline/e2e` 不存在；`package.json` / `.claude-plugin/plugin.json` / `.claude-plugin/marketplace.json` 三处 `version` 均为 `0.2.0`；`CHANGELOG.md` 存在；`i18n.test.mjs:5-6` 有 `deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())` 对称断言（新增键漏一侧即红）；`app.css:17` 无通用 `[hidden]` reset。
