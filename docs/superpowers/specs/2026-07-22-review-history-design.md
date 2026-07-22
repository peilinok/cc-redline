# cc-redline 评审历史闭环设计（方案 B，team review 修订版）

- 日期：2026-07-22
- 状态：设计经三视角 team review 修订，待用户最终审阅
- 范围：`skills/cc-redline/`（server / 前端 / SKILL.md / evals / 测试）
- 本期需求：R1（会话内历史 + 处理回执）、R2（评审留痕存档）。
  **R3（会话内快照 + 回滚）本期不做**，见 §10 Non-goals 与末尾"修订记录"。

## 1. 背景与问题

cc-redline 当前对已处理批注"阅后即焚"：AI 编辑落地触发 SSE 后，
`main.mjs` 调用 `consumeSubmitted()` 将整批已提交批注从内存中丢弃
（`assets/js/annotate.mjs` 722-725），用户只能看到一次短暂的 flash 高亮。
"记录丢失"分布在四层：

| 层 | 现状 |
|----|------|
| 浏览器 UI | 落地即丢弃；被 skip 的批注与被处理的批注一样静默消失，页面效果等同"全部完成" |
| 状态文件 | `submission-<seq>.json` 消费后仅改名 `.consumed`，数据完整保留于 STATE_DIR——但无读取入口，且 STATE_DIR 在会话临时目录，会话后蒸发 |
| 文档 | 只有最终态；中间版本不存在（除非用户自行逐轮 commit） |
| 会话 | agent 每轮 2-3 句 chat 总结，脱离文档、不结构化 |

论证结论（用户已确认的痛点时刻）：

- **R1 会话内闭环核对**（落地当下 + 跨轮回看）：成立，优先级最高。
  最尖锐证据：SKILL.md §3 要求锚定失败时诚实 skip，但报告只进 chat，
  浏览器侧 skip 信息完全丢失。附带修复一个**现存缺陷**：agent 将一轮批注
  全部 skip（文档无变化）时，浏览器今天会永远卡在"等待 AI"。
- **R2 评审留痕存档**（会话结束后）：成立。多天多轮 spec 评审工作流需要
  可持久、可追溯的评审记录。
- **R3 版本回看/回滚**：本期不做。与 R1/R2 零耦合，且长期版本史本就由 git
  承担；工具内快照相对 git 的唯一增量是"未提交的逐轮工作树状态"，价值窄、
  且引入了重启覆写快照、整文件回滚吞编辑等问题。留待真有回滚需求时再评估。

先例佐证：GitHub PR resolved thread、Google Docs 评论历史、Word 修订——
评审品类的成熟产品对已处理意见一律"折叠而非删除"。

## 2. 需求与验收标准

### R1 会话内历史与处理回执

- AI 编辑落地后，该批批注以只读"已处理"形态进入右栏历史区，按轮分组，
  含每条批注的处理状态（applied / skipped）与说明。
- 被 skip 的批注在 UI 中可见且标注原因。
- **解锁只由处理回执驱动**：agent 每轮（含全部 skip、含无实际改动的轮次）
  都写一份回执文件；浏览器收到回执即解锁该批次，**不依赖文档是否变化**。
  这从机制上根除"全 skip 永久等待"缺陷，且不引入任何计时猜测。
- 页面 reload 或 SSE 重连后，历史区从服务端 `/api/history` 完整恢复。

### R2 评审留痕存档

- "End review" 后，agent 生成 review log（逐轮：批注 + 处理结果 + 说明），
  追加写入文档旁的 review-log 文件（命名见 §7）；用户明确拒绝则跳过。

## 3. 总体架构与数据流

延续"两进程 + STATE_DIR 文件协议"。**不变项：wait_for_review.mjs 的消费
逻辑与退出码（0/2/3）、submission JSON 结构、`.tmp`+`rename` 原子写、零运行时
依赖、serveStatic 路径穿越防护。** 所有变更均为加法。

核心修订（来自 team review，根除竞态）：**事件模型解耦**——
`outcome` 事件负责"解锁批次 + 落历史"，`doc-changed` 事件只负责"重渲染文档
+ flash 高亮"。两者不再互相等待，因此不存在"一个事件先到就把另一个的状态
覆盖成永久等待"的竞态。

```
浏览器 ──POST /api/submit──▶ server ──submission-N.json──▶ wait 脚本(.consumed)──▶ agent
   ▲                           │                                                    │
   │◀──SSE outcome{seq} ───────│◀── outcome-N.json（agent 原子写，先于存文档）◀──────┤
   │   （解锁批次+落历史）       │                                                    │
   │◀──SSE doc-changed{version}│◀── 保存 DOC（现有路径）◀───────────────────────────┘
   │   （只重渲染+flash）        │
   └──GET /api/history（新）───┘
```

时序：agent **先原子写 `outcome-<seq>.json`，再保存文档**。因此 `outcome`
必先于 `doc-changed`（或独立到达）；无论到达顺序如何，解锁都只看 `outcome`，
`doc-changed` 只触发重渲染——顺序不影响正确性。

## 4. 状态文件与协议变更

新增 `outcome-<seq>.json`，命名与现有正则零冲突（wait 脚本只匹配
`^submission-(\d+)\.json$`；server `scanMaxSeq` 匹配
`^submission-(\d+)\.json(\.consumed)?$`）。**本版不再引入 `doc-v<N>.md`**（R3 推迟）。

### 4.1 `outcome-<seq>.json`（agent 原子写：`.tmp`+rename）

```json
{
  "type": "outcome",
  "seq": 3,
  "results": [
    { "id": "<批注 id>", "status": "applied", "note": "自由文本说明" },
    { "id": "<批注 id>", "status": "skipped", "note": "锚文本已被前一条改写，无法定位" }
  ],
  "globalComment": { "status": "applied", "note": "..." }
}
```

- `status` ∈ `applied | skipped`（语言中立英文 key，符合 i18n 不变量）。
  **取消 `partial` 第三态**：部分完成记 `applied` + 在 `note` 里说明"X 已做、
  Y 未做"，语义不丢而契约面更小。
- `note` 自由文本，UI 原样展示。
- `globalComment` 仅当该轮提交含全局评论时出现；否则省略该字段。
- **取消 `docChanged` 字段**：客户端从 `results` 推导"本轮是否改了文档"
  （任一 `applied` 或 `globalComment.status==applied` 即视为已改），无需 agent
  额外计算、也就没有"agent 把该字段算错导致卡死"的失败模式。
- **原子写**：与全局不变量"状态文件必原子"一致，杜绝半截 JSON 窗口。
- 关联键 (seq, id)。`id` 保留在提交 JSON 中（`annotate.mjs` 675-679 的解构只
  剔除 DOM 定位字段）；`id` 为整页会话内递增、reload 才重置，但因 seq 由 server
  单调发放，(seq, id) 组合始终唯一。
- **results 与 annotations 非强制双射**（agent 常只汇报改动项，见 §6 展示规则）。
- 全部 skip 也必须写回执（这是全 skip 解锁的前提）。

### 4.2 SKILL.md 联动（lockstep）

- §3 应用流程末尾新增：处理完全部批注后、**保存文档前**，用 `.tmp`+rename
  原子写 `$STATE_DIR/outcome-<seq>.json`（结构如上；全 skip 也要写）。
- §4 结束流程新增：done 后读 STATE_DIR 的 submission/outcome 文件聚合 review
  log，追加到 review-log 文件（用户拒绝则跳过；写失败则报告并跳过，见 §7/§8）。
- §2 wait 循环表格与退出码不变。
- 手动验收清单改写/新增（见 §9）。

### 4.3 evals.json 联动

- eval 2（应用提交）expectations 追加：在保存文档前**原子写**含逐条 status 的
  `outcome-<seq>.json`；仍按原则诚实 skip。
- 新增 eval：一轮批注全部锚定失败 → 期望写全 `skipped` 回执、不改文档、chat
  如实报告，不臆测修改。
- 新增 eval：用户点击 End review → 期望生成/追加 review log 并在总结中提及路径。

## 5. 服务端设计（server.mjs，零依赖）

- **outcome 探测（不新增常驻轮询）**：不引入独立 `setInterval`。server 在
  `/api/submit` 分配 `seq` 后，对已知路径 `outcome-<seq>.json` 用 `fs.watchFile`
  监听（复用文档监听同款机制）；文件出现且解析成功 → 广播 SSE
  `event: outcome`，data `{seq}` → `unwatchFile` 停止该监听。启动时对所有"尚无
  outcome 的已知 seq"（`1..submitSeq` 中缺 `outcome-<seq>.json` 的，无论其
  submission 是否已 `.consumed`）重建监听。这样避免了独立轮询循环与其"重启防
  重播"边界逻辑；漏播由下面的对账兜底。
- **对账兜底**：客户端在页面 load、以及 **SSE 每次 (重)连接（`hello` 事件）**
  时重拉 `/api/history`；`/api/history` 是唯一事实源，任何漏掉的 `outcome`
  广播都能自愈。这同时修复现存的"SSE 重连不重取数据"问题。

  > **实现变更（记录，不改原文）**：交付版本把触发列表又加了一项——`doc-changed`
  > 事件（见 §6 `onDocChanged`）也会重拉一次 `/api/history`，而不是本条最初写的
  > "仅 load + `hello`"。这一条不是与 `hello` 重复的冗余调用：`currentVersion`
  > 只有在文档真的变化时才会推进，一轮批注若被 agent 编辑却从未写 `outcome`
  > 回执，只有在文档变化之后重新拉取 `/api/history`，才能被判定为
  > `processed-no-outcome` 并释放——否则会一直停在"处理中"，永不解锁。
  > `e2e/review.spec.mjs` 里"a round whose doc advanced without an outcome is
  > released and marked processed"这条用例、以及 `SKILL.md` 手动验收清单对应的
  > 一条，都依赖这条路径；后续如果有人把它当作可以删掉的重复调用，这两处都会变红。
- **新路由 `GET /api/history`**（每次现读现聚合，不缓存；评审数据量小）：

```json
{
  "currentVersion": 4,
  "rounds": [
    { "seq": 1, "submittedAt": "...", "docVersion": 2,
      "globalComment": "…或 null",
      "annotations": [ /* 提交原文 */ ],
      "outcome": { /* outcome-1.json 内容 */ } // 或 null
    }
  ]
}
```

  - `rounds` 按 seq 升序。`outcome` 为 null 表示尚无回执文件。
  - `annotations` 为 submission 原文；一并给出该轮的 `docVersion`（提交时面向
    的文档版本）。
  - 顶层 `currentVersion` = server 当前内存中的文档版本（现有 `version`，
    已随 `watchFile` 递增）。客户端用它推断"无回执"轮次的完成态（§6）。
  - **不返回快照版本列表**（R3 推迟，且原设计里无消费者）。
  - **逐文件容错**：读取/解析任一 submission 或 outcome 失败时，按"该文件缺失"
    降级（outcome 视为 null），绝不使整个 `/api/history` 500。
- `serveStatic` 路径穿越防护不碰。

## 6. 前端设计

- **提交捕获 seq**：`/api/submit` 响应 `{ok, seq}` 现被忽略；改为记录到该批次
  每条 submitted 批注（含 global）上，作为与历史轮次、与 `consumeSubmitted(seq)`
  的关联键。
- **事件接线（解耦，核心修订）**：
  - `sse.mjs` 增加 `outcome` 事件回调，`hello`（重连）回调触发一次
    `/api/history` 重拉。
  - `onOutcome(seq)` → `consumeSubmitted(seq)`（仅移除该 seq 的 submitted 批注）
    + 重拉 `/api/history`（该轮以服务端形态进入历史区）。横幅按该轮 outcome
    推导：任一 `applied` → 短暂"本轮已处理，文档更新中…"（doc-changed 到达即
    清除）；全 `skipped` → "本轮已处理（无改动）"。**解锁只发生在这里。**
  - `onDocChanged(version)` → 保留现有"有未提交草稿则弹确认横幅、否则 refreshDoc
    + flash 高亮"逻辑，但**移除其中的 `consumeSubmitted()` 调用**（解锁改由
    outcome 驱动）。doc-changed 只重渲染，不再触碰在途/已提交批次。

    > **实现变更**：`onDocChanged` 实际还会额外调用一次 `refreshHistory()`
    > （因此可能间接释放批次），并非严格"只重渲染，不再触碰在途/已提交批次"——
    > 它仍然没有恢复直接调用 `consumeSubmitted()`，解锁依旧只经
    > `refreshHistory()` 的 `/api/history` 对账触发；但既然 doc-changed 现在会
    > 促成这次对账，它就不再是与批次完全无关的旁路了。原因与这条路径为什么必须
    > 保留，见 §5"对账兜底"的实现变更说明。
  - 因两事件不再互相等待，不存在 review 指出的"横幅永久卡死"竞态；也不再需要
    "consumeSubmitted 必须幂等"这一负担。
- **`consumeSubmitted(seq)` 语义**：由无参改为按 seq 过滤——只移除该 seq 的
  submitted 批注；`globalComment` 仅当该 seq 的 outcome 覆盖了它时才清空。修复
  多批在途时"首个 outcome 误清后续轮次 + 误清未处理轮 globalComment"的缺陷。
- **历史区**：右栏底部折叠手风琴"已处理（N 轮）"。数据源唯一：`/api/history`。
  按轮分组；最新落地轮默认展开，其余折叠。卡片只读、灰色，展示 scope 标签、
  comment、quotedSource 摘录（默认前 3 行，余下省略号）、状态徽标与回执 note。
  - **每条批注的状态展示（含缺失/孤儿 id 规则）**：
    - 有匹配 result → ✓ applied / ⊘ skipped + note。
    - 该轮有 outcome 但此批注无匹配 result（agent 只汇报了改动项）→ 中性
      "— 无单条说明"，不臆断 applied/skipped。
    - 孤儿 result（result.id 在该轮 submission 中不存在）→ 渲染时忽略（不崩），
      其 note 不展示。
    - globalComment（可能是"零批注、仅全局评论"的轮次）→ 该轮作为一张独立卡片
      展示其 status/note。
  - **轮次级完成态（reload/无回执的区分，修复 M4）**：
    - 有 outcome → 已处理，按上面逐条展示。
    - 无 outcome 且 `docVersion < currentVersion`（文档已推进过该轮）→ 视为
      "已处理·无回执记录"，徽标 `？`（兼容从不写 outcome 的旧协议 agent）。
    - 无 outcome 且 `docVersion == currentVersion` → "处理中"（真正在途或刚提交）。
- **不重新锚定**：历史卡片不在当前文档上高亮/跳转（锚文本可能已不存在）；
  无 hover 联动；ruler 不加历史刻度；N/P 导航仅活动批注。doc-changed 刷新时
  **不重锚在途的 submitted 批注**（它们即将由 outcome 移入只读历史）。
- **生命周期**：页面 load 拉一次 `/api/history` 恢复历史（含在途轮，按上面完成态
  规则显示）。这也顺带修复"刷新即丢已处理历史"。（未提交草稿仍仅存内存、reload
  丢失——属相邻问题，见 §10。）
- **i18n**：新增 en/zh 键（历史区标题、状态徽标、横幅等）；写入 submission/outcome
  的值保持语言中立。

## 7. 存档（R2）

- review log 由 agent 在 done 后生成（数据源：STATE_DIR 的 submission + outcome
  文件；变更描述来自回执 note，不做 diff）。
- **文件命名**：文档同目录，文件名 = 去掉结尾 `.md`（若有）后加 `.review-log.md`。
  例：`spec.md → spec.review-log.md`；`README → README.review-log.md`；
  `notes.txt → notes.txt.review-log.md`。含空格/中文的路径按现有约定保持引号。
- **写入**：追加式，同一文件累积多次评审，服务多天多轮工作流。每次评审一节，
  标题带**日期与时间** `## Review <YYYY-MM-DD HH:MM>`（避免同日两次评审标题撞车）。
- **失败降级**：目标目录只读/写入失败时，agent 在 chat 报告并跳过，不阻断 done
  流程。
- **不做**：跨并发评审会话的追加去重/加锁（假定同一文档同时只有一个活跃评审；
  见 §10）。

## 8. 边界与错误处理

- **全 skip / 无改动轮**：outcome 照写，`onOutcome` 立即解锁并显示"无改动"横幅；
  不依赖 doc-changed，无永久等待。
- **agent 写 outcome 后崩溃/未保存文档**：批次已由 outcome 解锁并入历史（不卡）；
  文档未变，doc-changed 不来也无妨（解锁不依赖它）。
- **回执缺失（旧协议 agent / 行为漂移）**：历史区按 §6 完成态规则显示 `？` 或
  "处理中"，不阻塞评审。
- **outcome/submission 半截或损坏**：`/api/history` 逐文件容错降级；outcome 原子写
  本身已杜绝半截窗口。
- **server 崩溃后同 STATE_DIR 重启**：`/api/history` 完全由文件重建；outcome 监听在
  启动时对"consumed 但无 outcome"的 seq 重建；漏播由 SSE 重连重拉兜底。
- **多份在途提交**：`consumeSubmitted(seq)` 按 seq 精确解锁，互不串轮；横幅文案在
  多轮在途时以聚合表述为准（如"仍有 N 轮处理中"），不由单个 outcome 独占。
- **相邻问题、本期不扩入**：reload 丢失未提交草稿批注（草稿仅存内存）。

## 9. 测试计划

- `scripts/tests/server.test.mjs` 新增：
  - 写入 `outcome-<seq>.json` → 触发一次且仅一次 `outcome` SSE 广播（复用 mtime
    re-touch 防抖模式）；`unwatchFile` 后不再重播；
  - `/api/history` 聚合正确：有/无 outcome 的轮次、`currentVersion` 字段、按 seq
    升序、globalComment-only 轮次；
  - 逐文件容错：损坏的 outcome/submission 不使 `/api/history` 500，降级为 null；
  - 重启后对"consumed 无 outcome"的 seq 重建监听并能广播。
- E2E（`e2e/*.spec.mjs`，Playwright）新增/扩展：
  - 提交 → agent 原子写回执并改文档 → 历史区出现该轮，✓/⊘ 徽标与 note 正确；
  - 全 skip 轮：仅回执、无文档变化 → 批次解锁 + "无改动"横幅；
  - 多批在途：先提交两批，第一批 outcome 到达只解锁第一批、不误清第二批；
  - reload 后历史区恢复；无回执且文档已推进的轮次显示 `？` 而非永久"处理中"。
- SKILL.md 手动验收清单联动：
  - 改写"the submitted batch clears when the AI's edit lands"为"落地后移入右栏
    『已处理』历史区并带处理状态（✓/⊘）"；
  - 新增"reload / SSE 重连后历史区恢复"；
  - 新增"全部 skip 的轮次经 outcome 事件解锁并提示无改动"；
  - 新增"多批在途按 seq 精确解锁，不串轮"。

## 10. Non-goals（本期不做）

- **R3 会话内快照 / 回滚 / 版本浏览**（整块推迟；长期版本史由 git 承担）。
- 历史批注在新文档上的重新锚定 / 高亮 / 跳转。
- 逐行 unified diff 视图、旧版本上下文模态（方案 C，后续可分期叠加）。
- 草稿批注持久化（相邻需求，另立）。
- STATE_DIR 跨会话持久化（review log 即跨会话载体）。
- review-log 跨并发评审会话的追加去重 / 文件锁。

## 11. 发布注意

- 协议三件套（SKILL.md / evals.json / 实现）同一 PR 内 lockstep 更新。
- 发布时 bump `.claude-plugin/plugin.json` 的 `version` 并打 tag（安装的插件仅在
  版本变化时更新）。
- 零运行时依赖不变量保持：无新 npm 依赖，前端无新 vendor 库。

---

## 修订记录（team review 2026-07-22）

三视角审查（架构与竞态 / 完整性与边界 / 简约性与范围）后的处置：

- **R3 推迟**（用户确认）：直接消除 BLOCKER"重启 version 归零覆写快照"、
  MAJOR"整文件回滚吞手动编辑"，并删除无消费者的 `versions[]`。
- **事件模型解耦**（解锁绑 outcome、doc-changed 只重渲染）：消除 BLOCKER
  "两个独立轮询无序导致等待横幅永久卡死"及其 no-op 编辑变体，同时去掉
  "consumeSubmitted 必须幂等"负担与独立轮询循环。
- **`consumeSubmitted(seq)` 按 seq**：修复多批在途误清后续轮次 + 误清 globalComment。
- **outcome 原子写 + `/api/history` 逐文件容错**：符合"状态文件必原子"不变量。
- **取消 `docChanged` 字段 / `partial` 状态 / 三态推导 / 五徽标**：缩小 lockstep
  契约面；完成态由 `results` 与 `docVersion vs currentVersion` 推导。
- **缺失/孤儿 result id 的展示规则**、**globalComment-only 轮次卡片**、**reload/
  无回执轮次完成态推断**、**SSE 重连重拉对账**、**review-log 命名/写失败/同日
  标题边界**：逐条补入 §6/§7/§8，并在 §9 加对应测试。
