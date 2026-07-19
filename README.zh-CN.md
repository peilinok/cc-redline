# CC Redline

[![CI](https://github.com/peilinok/cc-redline/actions/workflows/ci.yml/badge.svg)](https://github.com/peilinok/cc-redline/actions/workflows/ci.yml)

[English](README.md) · **中文**

一个交互式、在浏览器内进行的 **Markdown 评审循环**，以 [Claude Code](https://claude.com/claude-code) skill 的形式提供。你只需让 agent 评审某个 Markdown 文件，它就会在浏览器里渲染文档（Raw 与 Render 两种模式）；你对块、章节、选中文本或精确源码行做批注并提交；agent 把批注应用回文件，页面实时刷新。如此往复，直到你点击 **结束 Review** —— 无需敲任何命令，全程只在聊天和浏览器里进行。

界面支持中英双语，可在运行时切换。

![CC Redline 演示 —— 渲染、批注、提交](.github/assets/demo-zh.gif)

## 环境要求

- `PATH` 中有 Node.js ≥ 18（`node --version`）。
- 无需 `npm install` —— 所有前端库都已 vendored 在 `skills/cc-redline/assets/vendor/`。

## 安装

作为 Claude Code plugin 安装（推荐）：

```
/plugin marketplace add peilinok/cc-redline
/plugin install cc-redline@cc-redline
```

或手动安装：把 `skills/cc-redline` 目录复制或软链接到你的 Claude Code skills
目录（例如 `~/.claude/skills/cc-redline`）。

## 使用

装好之后，你不用自己跑任何东西 —— 只要用大白话让 agent 评审某个 Markdown 文件：

> 在浏览器里 review `docs/design.md`
>
> 帮我 review 这份 spec

接下来交给 skill：它会启动一个本地评审服务，并在浏览器里打开渲染好的文档。你来
批注 —— 点击块或章节、选中文本、或在 Raw 模式下双击某一行 —— 写下意见，点 **提交
批注**。回到聊天里，agent 会把你的批注应用到文件；页面实时刷新，并把改动过的地方
闪光高亮。想改几轮就改几轮，然后点 **结束 Review**（或直接告诉 agent）即可收尾。

全程你只待在浏览器和聊天里 —— 服务和「应用批注」这套循环都由 agent 替你驱动。

## 工作原理

两个进程通过 `--state-dir` 里的文件协调，因此任何 agent/harness 都能驱动这个
循环：`server.mjs`（长时运行的 HTTP 服务；渲染、提供 `/api/*`、监听文件、经
SSE 推送刷新）与 `wait_for_review.mjs`（agent 每轮重跑一次的阻塞式一次性脚本；
用**退出码**汇报发生了什么：0 = 有事件，2 = 超时，3 = 服务已死）。批注**按文
本锚定、而非行号**：每条都带一段逐字节精确的 `quotedSource`，agent 据此定位并
编辑。完整的 agent 契约见 [`SKILL.md`](skills/cc-redline/SKILL.md)。

这两个脚本由 agent 替你启动和重跑。如果你想自己驱动这套循环 —— 脱离 Claude Code，
或只是想看看底层机制 —— 也可以手动运行：

```bash
# 渲染并托管一个文档（会打开浏览器；可加 --port N 或 --no-open 调整）
node skills/cc-redline/scripts/server.mjs path/to/doc.md --state-dir /tmp/cc-redline-1

# 阻塞直到下一个 submission / done 事件（退出码即通信通道）
node skills/cc-redline/scripts/wait_for_review.mjs --state-dir /tmp/cc-redline-1 --timeout-sec 540
```

## 开发

```bash
# 单元测试（无需安装依赖）
node --test skills/cc-redline/scripts/tests/*.test.mjs   # 用 glob；传目录在 node 22 / Windows 上会失败

# 浏览器 E2E（Playwright 驱动系统 Chrome；仅开发依赖）
npm ci
npm run test:e2e
```

无 build、无 bundler、零**运行时**依赖——`@playwright/test` 仅为 E2E 使用的
开发依赖。E2E 自动化了 `skills/cc-redline/SKILL.md` 验收清单的核心项（含完整的
提交 → agent 修改 → 自动刷新循环）。

## 许可证

[MIT](LICENSE)。vendored 前端库保留各自的许可证于 `skills/cc-redline/assets/vendor/licenses/`；
另见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)。
