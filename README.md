# CC Redline

[![CI](https://github.com/peilinok/cc-redline/actions/workflows/ci.yml/badge.svg)](https://github.com/peilinok/cc-redline/actions/workflows/ci.yml)

**English** · [中文](README.zh-CN.md)

An interactive, in-browser **Markdown review loop**, delivered as a
[Claude Code](https://claude.com/claude-code) skill. Ask the agent to review a
Markdown file and it renders the doc in your browser (Raw and Render modes); you
annotate blocks, sections, selected text, or an exact source line and submit;
the agent applies your annotations back to the file and the page live-refreshes.
Repeat until you click **End review** — no commands to run, it's all chat plus
the browser.

The UI is bilingual (English / 中文) and switchable at runtime.

![CC Redline demo — render, annotate, submit](.github/assets/demo-en.gif)

## Requirements

- Node.js ≥ 18 on your `PATH` (`node --version`).
- No `npm install` — all front-end libraries are vendored under `skills/cc-redline/assets/vendor/`.

## Install

Pick whichever fits your setup.

### Claude Code plugin (recommended)

```
/plugin marketplace add peilinok/cc-redline
/plugin install cc-redline@cc-redline
```

Or the non-interactive equivalents from your shell:

```bash
claude plugin marketplace add peilinok/cc-redline
claude plugin install cc-redline@cc-redline
```

### Any Agent Skills–compatible agent (Codex, Cursor, Windsurf, …)

cc-redline follows the [Agent Skills](https://agentskills.io) spec, so the
universal [`skills`](https://github.com/vercel-labs/skills) installer works too:

```bash
npx skills add peilinok/cc-redline
```

> Run from **inside** an agent session, the CLI installs non-interactively and
> may only write the universal `.agents/skills/` directory (which Claude Code
> doesn't read). Target Claude Code explicitly:
> `npx skills add peilinok/cc-redline -a claude-code`

### Manual (clone + symlink or copy)

```bash
git clone https://github.com/peilinok/cc-redline.git
ln -s "$PWD/cc-redline/skills/cc-redline" ~/.claude/skills/cc-redline
# …or copy instead of symlink:
# cp -r cc-redline/skills/cc-redline ~/.claude/skills/
```

**Updating** — `/plugin marketplace update cc-redline`, re-run the `npx skills`
command, or `git pull` in your clone, depending on how you installed.

## Usage

Once it's installed you don't run anything yourself — just ask the agent, in
plain language, to review a Markdown file:

> review `docs/design.md` in the browser
>
> 帮我 review 这份 spec

The skill takes it from there: it starts a local review server and opens the
rendered document in your browser. You annotate — click a block or section,
select text, or double-click an exact line in Raw mode — type a comment, and hit
**Submit**. Back in the chat the agent applies your annotations to the file; the
page live-refreshes and flash-highlights what changed. Do as many rounds as you
like, then click **End review** (or just tell the agent) to finish.

You stay in the browser and the chat the whole time — the agent runs the server
and the apply-loop for you.

## How it works

Two processes coordinate through files in `--state-dir`, so any agent/harness
can drive the loop: `server.mjs` (long-running HTTP server; renders, serves
`/api/*`, watches the file, pushes SSE refreshes) and `wait_for_review.mjs`
(a blocking one-shot the agent re-runs each round; its **exit code** reports
what happened: 0 = event, 2 = timeout, 3 = server dead). Annotations are
anchored **by text, not line numbers**: each carries a byte-exact
`quotedSource` the agent locates and edits. See
[`SKILL.md`](skills/cc-redline/SKILL.md) for the full agent-facing contract.

The agent starts and re-runs these for you. To drive the loop yourself — without
Claude Code, or just to see the mechanism — run them by hand:

```bash
# render + serve a doc (opens your browser; add --port N or --no-open to adjust)
node skills/cc-redline/scripts/server.mjs path/to/doc.md --state-dir /tmp/cc-redline-1

# block until the next submission / done event (exit code is the channel)
node skills/cc-redline/scripts/wait_for_review.mjs --state-dir /tmp/cc-redline-1 --timeout-sec 540
```

## Development

```bash
# unit tests (no install needed)
node --test skills/cc-redline/scripts/tests/*.test.mjs   # use the glob; a bare dir fails on node 22 / Windows

# browser E2E (Playwright driving your system Chrome; dev-only dependency)
npm ci
npm run test:e2e
```

No build step, no bundler, zero **runtime** dependencies — `@playwright/test`
is a devDependency used only by the E2E suite, which automates the core of the
acceptance checklist in `skills/cc-redline/SKILL.md` (including the full
submit → agent-edit → live-refresh loop).

## License

[MIT](LICENSE). Vendored front-end libraries retain their own licenses under
`skills/cc-redline/assets/vendor/licenses/`; see
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
