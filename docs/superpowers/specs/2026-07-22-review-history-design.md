# cc-redline 评审历史闭环设计（方案 B）

- 日期：2026-07-22
- 状态：设计已获用户批准，待规格审阅
- 范围：`skills/cc-redline/`（server / 前端 / SKILL.md / evals / 测试）

## 1. 背景与问题

cc-redline 当前对已处理批注采取"阅后即焚"：AI 编辑落地触发 SSE 后，
`main.mjs` 调用 `consumeSubmitted()` 将整批已提交批注从内存中丢弃
（`assets/js/annotate.mjs` 722-725），用户只能看到一次短暂的 flash 高亮。
"记录丢失"实际分布在四层：

| 层 | 现状 |
|----|------|
| 浏览器 UI | 落地即丢弃；被 skip 的批注与被处理的批注一样静默消失，页面效果等同"全部完成" |
| 状态文件 | `submission-<seq>.json` 消费后仅改名 `.consumed`，数据完整保留于 STATE_DIR——但无任何读取入口，且 STATE_DIR 在会话临时目录，会话后蒸发 |
| 文档 | 只有最终态；中间版本不存在（除非用户自行逐轮 commit） |
| 会话 | agent 每轮 2-3 句 chat 总结，脱离文档、不结构化 |

论证结论（用户已确认全部四个痛点时刻）：

- **R1 会话内闭环核对**（落地当下 + 跨轮回看）：成立，优先级最高。
  最尖锐证据：SKILL.md §3 要求锚定失败时诚实 skip，但报告只进 chat，
  浏览器侧 skip 信息完全丢失。
- **R2 评审留痕存档**（会话结束后）：成立。多天多轮 spec 评审工作流需要
  可持久、可追溯的评审记录。
- **R3 版本回看/回滚**：收窄为"会话内快照 + 聊天驱动回滚"；跨会话长期
  版本史仍由 git 承担，不在工具内重造版本控制。

先例佐证：GitHub PR resolved thread、Google Docs 评论历史、Word 修订——
评审品类的成熟产品对已处理意见一律"折叠而非删除"。

## 2. 需求与验收标准

### R1 会话内历史与处理回执

- AI 编辑落地后，该批批注以只读"已处理"形态进入右栏历史区，按轮分组，
  含每条批注的处理状态（applied / skipped / partial）与说明。
- 被 skip 的批注在 UI 中可见且标注原因。
- agent 将一轮批注全部 skip（文档无变化）时，浏览器仍能解锁该批次并
  提示"本轮已处理（无改动）"——修复现存的永久等待缺陷。
- 页面 reload 后历史区从服务端完整恢复。

### R2 评审留痕存档

- "End review" 后，agent 生成 review log（逐轮：批注 + 处理结果 + 说明），
  追加写入文档旁 `<docname>.review-log.md`（每次评审一节
  `## Review <date>`）；用户明确拒绝则跳过。

### R3 会话内快照与回滚

- server 对文档每个检测到的版本在 STATE_DIR 留快照 `doc-v<version>.md`。
- 用户在聊天中请求回滚时，agent 读对应快照整文件恢复，走正常
  保存→刷新流程。提交记录中的 `docVersion` 即"该轮批注所针对的版本"，
  回滚到"第 N 轮提交前"= 恢复 `doc-v<该轮 docVersion>.md`。

## 3. 总体架构与数据流

延续"两进程 + STATE_DIR 文件协议"。**不变项：wait_for_review.mjs 的
消费逻辑与退出码（0/2/3）、submission JSON 结构、`.tmp`+`rename` 原子写、
零运行时依赖、serveStatic 路径穿越防护。** 所有变更均为加法。

```
浏览器 ──POST /api/submit──▶ server ──submission-N.json──▶ wait 脚本(.consumed)──▶ agent
   ▲                           │                                                    │
   │◀──SSE outcome ────────────│◀── outcome-N.json（新：agent 先写回执）◀────────────┤
   │◀──SSE doc-changed ────────│◀── 保存 DOC（现有路径）◀───────────────────────────┘
   │                           │
   └──GET /api/history（新）───┘     server 每个版本写 doc-v<N>.md 快照（新）
```

时序约定：agent **先写 `outcome-<seq>.json`，再保存文档**。
`doc-changed` 到达时 `/api/history` 已含回执，UI 无竞态；全 skip 轮次
由 `outcome` SSE 事件单独解锁。

## 4. 状态文件与协议变更

新增文件命名与现有正则零冲突（wait 脚本只匹配
`^submission-(\d+)\.json$`；`scanMaxSeq` 匹配
`^submission-(\d+)\.json(\.consumed)?$`）。

### 4.1 `doc-v<version>.md`（server 写，原子）

启动时写 v1；watchFile 每次检测到内容变化，`version++` 后写对应快照。
快速连续保存可能合并为一个版本（watchFile 500ms 轮询所致），可接受。
用户手动编辑文档同样产生版本与快照。

### 4.2 `outcome-<seq>.json`（agent 写）

```json
{
  "type": "outcome",
  "seq": 3,
  "docChanged": true,
  "results": [
    { "id": "<批注 id>", "status": "applied", "note": "自由文本" },
    { "id": "<批注 id>", "status": "skipped", "note": "锚文本已被前一条改写，无法定位" }
  ],
  "globalComment": { "status": "applied", "note": "..." }
}
```

- `status` ∈ `applied | skipped | partial`（语言中立英文 key，符合 i18n
  不变量）；`partial` = comment 含多个诉求仅部分完成。`note` 自由文本，
  UI 原样展示。
- `docChanged`（必填）：本轮是否实际修改了文档。agent 是唯一确切知道
  这一点的一方；UI 据此决定是等待 doc-changed 刷新，还是立即提示
  "本轮无改动"——不做任何计时猜测。
- `globalComment` 仅当该轮提交含全局评论时出现；否则省略该字段。
- 关联键为 (seq, id)。`id` 已确认保留在提交 JSON 中
  （`annotate.mjs` 675-679 的解构只剔除 DOM 定位字段）；id 仅在单轮内
  唯一，跨轮重复无害。
- 全部 skip 也必须写回执。agent 侧尽量单次写入；server 读取容忍
  半截 JSON（见 §5）。

### 4.3 SKILL.md 联动（lockstep）

- §3 应用流程末尾新增：处理完全部批注后、保存文档前，写
  `$STATE_DIR/outcome-<seq>.json`（结构如上；全 skip 也要写）。
- §4 结束流程新增：done 后读 STATE_DIR 的 submission/outcome 文件聚合
  review log，追加到 `<docname>.review-log.md`（用户拒绝则跳过）；
  说明快照文件与聊天回滚能力。
- §2 wait 循环表格与退出码不变。
- 手动验收清单改写/新增（见 §9）。

### 4.4 evals.json 联动

- eval 2（应用提交）expectations 追加：在保存文档前写出含逐条
  status 的 `outcome-<seq>.json`；仍按原则诚实 skip。
- 新增 eval：一轮批注全部锚定失败 → 期望写全 skipped 回执、不改文档、
  chat 如实报告，不臆测修改。
- 新增 eval：用户点击 End review → 期望生成/追加 review log 并在
  总结中提及路径。

## 5. 服务端设计（server.mjs，零依赖）

- 快照：初始化后写 `doc-v1.md`；watchFile 回调中 `version++` 后原子写
  `doc-v<version>.md`。
- 回执探测：500ms `setInterval`（`unref()`；`server close` 时清除）
  readdir STATE_DIR，发现未播报的 `outcome-*.json` → JSON.parse
  （失败视为写入中，下一 tick 重试，与 watchFile 容错同款）→ 广播
  SSE `event: outcome`，data `{seq}`。复用 STATE_DIR 重启时，把已存在
  的回执 seq 预置为"已播报"，避免重播风暴。
- 新路由 `GET /api/history`（每次现读现聚合，不缓存）：

```json
{
  "rounds": [
    { "seq": 1, "state": "pending|consumed|resolved",
      "submittedAt": "...", "docVersion": 2,
      "globalComment": "...", "annotations": [ ... ],
      "outcome": { ... } }
  ],
  "versions": [1, 2, 3]
}
```

  - `state` 推导：`submission-N.json` 存在 → pending；`.consumed` 存在
    且无回执 → consumed；回执存在 → resolved。孤儿回执（无对应
    submission）忽略。`rounds` 按 seq 升序。
  - `annotations` 为提交原文；`outcome` 为 null 或回执对象。
  - `versions` 为现存快照版本号列表（供 UI 为轮次标注对应文档版本
    及调试用）。

## 6. 前端设计

- **提交捕获 seq**：`/api/submit` 响应 `{ok, seq}` 现被忽略；改为记录到
  该批次每条批注（含 global）作为轮次关联键。
- **历史区**：右栏底部折叠手风琴"已处理（N 轮）"。数据源唯一：
  `/api/history`（客户端不搬运本地对象）。按轮分组；最新落地轮默认
  展开，其余折叠。卡片只读、灰色：scope 标签、comment、quotedSource
  摘录（默认前 3 行，余下省略号）、状态徽标 ✓ applied / ⊘ skipped / ◐ partial /
  ？（consumed 无回执，兼容旧协议 agent）/ ⏳（pending），及回执 note。
- **不重新锚定**：历史卡片不在当前文档上高亮/跳转（锚文本可能已不
  存在）；无 hover 联动；ruler 不加历史刻度；N/P 导航仅活动批注。
- **生命周期**：`consumeSubmitted()` 仍从活动区移除该批次，随后重拉
  history 使其以服务端形态出现在历史区。页面 load 时拉取一次
  `/api/history` 恢复历史（含 pending/consumed 轮次，显示为处理中）。
- **事件接线**：`sse.mjs` 增加 `outcome` 事件回调；`main.mjs`：
  `onOutcome` → `consumeSubmitted()` + 重拉历史；随后按回执的
  `docChanged` 分支——true 则保持等待横幅直至 doc-changed 落地刷新，
  false 则立即横幅"本轮已处理（无改动）"；`onDocChanged` → 现有流程 +
  重拉历史。两事件先后到达时 `consumeSubmitted` 幂等。
- **i18n**：新增 en/zh 键（历史区标题、状态徽标、横幅等）；写入
  submission/outcome 的值保持语言中立。

## 7. 存档与回滚

- review log 由 agent 在 done 后生成（数据源：STATE_DIR 的
  submission + outcome 文件；变更描述来自回执 note，不做快照 diff）。
  追加式写入文档同目录的 `<去掉 .md 扩展的文件名>.review-log.md`
  （如 `spec.md` → `spec.review-log.md`），同一文件累积多次评审，
  服务多天多轮工作流。
- 回滚仅聊天驱动；不做 UI 回滚按钮（不绕过"agent 应用修改"的核心
  模型，也不与 git 职责重叠）。

## 8. 边界与错误处理

- 回执缺失（agent 行为漂移 / 旧 SKILL.md agent）：历史区显示"？"，
  doc-changed 照常解锁批次——优雅降级，不阻塞评审。
- 回执半截 JSON：server 容错并于下一 tick 重试。
- server 崩溃后以同一 STATE_DIR 重启：/api/history 完全由文件重建
  （架构本身的文件事实源特性），队列与历史存活。
- 快照磁盘占用：会话临时目录内 MB 级；v1 不做清理与上限。
- 明确的相邻问题、不扩入本期：reload 丢失未提交草稿批注（草稿仅存
  内存）。如需解决另立需求。

## 9. 测试计划

- `scripts/tests/server.test.mjs` 新增：
  - 文档变化产生对应 `doc-v<N>.md`（复用 mtime re-touch 防抖模式）；
  - `/api/history` 三态（pending/consumed/resolved）聚合正确；
  - 新回执触发一次且仅一次 `outcome` SSE 广播；重启预置不重播；
  - 半截回执 JSON 不崩溃、补全后正常播报。
- E2E（`e2e/*.spec.mjs`，Playwright）新增/扩展：
  - 提交→agent 写回执并改文档→历史区出现该轮，徽标与 note 正确；
  - 全 skip 轮：仅回执、无文档变化 → 批次解锁 + 提示横幅；
  - reload 后历史区恢复。
- SKILL.md 手动验收清单联动：
  - 改写"the submitted batch clears when the AI's edit lands"为
    "落地后移入右栏『已处理』历史区并带处理状态"；
  - 新增"reload 后历史区恢复"；
  - 新增"全部 skip 的轮次经 outcome 事件解锁并提示"。

## 10. Non-goals（本期不做）

- 历史批注在新文档上的重新锚定 / 高亮 / 跳转。
- UI 一键回滚、版本浏览器。
- 逐行 unified diff 视图、旧版本上下文模态（方案 C，后续可分期叠加）。
- 草稿批注持久化（相邻需求，另立）。
- STATE_DIR 跨会话持久化（review log 即跨会话载体）。

## 11. 发布注意

- 协议三件套（SKILL.md / evals.json / 实现）同一 PR 内 lockstep 更新。
- 发布时 bump `.claude-plugin/plugin.json` 的 `version` 并打 tag
  （安装的插件仅在版本变化时更新）。
- 零运行时依赖不变量保持：无新 npm 依赖，前端无新 vendor 库。
