# CC Redline

[![CI](https://github.com/peilinok/cc-redline/actions/workflows/ci.yml/badge.svg)](https://github.com/peilinok/cc-redline/actions/workflows/ci.yml)

**English** · [中文](README.zh-CN.md)

An interactive, in-browser **Markdown review loop** packaged as a
[Claude Code](https://claude.com/claude-code) skill. Start a local,
zero-dependency web server that renders a Markdown file with Raw and Render
modes; annotate blocks, sections, selected text, or an exact source line;
submit — and the driving agent applies your annotations back to the file and
the page auto-refreshes. Repeat until you click **End review**.

The UI is bilingual (English / 中文) and switchable at runtime.

![CC Redline demo — render, annotate, submit](.github/assets/demo-en.gif)

## Requirements

- Node.js ≥ 18 on your `PATH` (`node --version`).
- No `npm install` — all front-end libraries are vendored under `skills/cc-redline/assets/vendor/`.

## Install

As a Claude Code plugin (recommended):

```
/plugin marketplace add peilinok/cc-redline
/plugin install cc-redline@cc-redline
```

Or manually: copy or symlink the `skills/cc-redline` directory into your Claude
Code skills directory (e.g. `~/.claude/skills/cc-redline`).

Then ask the agent to review a Markdown file, for example: "review this spec in
the browser".

## Use it directly

```bash
# start the review server (opens your browser automatically)
node skills/cc-redline/scripts/server.mjs path/to/doc.md --state-dir /tmp/cc-redline-1

# in the driving agent's loop, block until the next submission/done event:
node skills/cc-redline/scripts/wait_for_review.mjs --state-dir /tmp/cc-redline-1 --timeout-sec 540
```

`server.mjs` flags: `--port N` (default: an ephemeral free port on 127.0.0.1),
`--no-open` (don't auto-open the browser).

## How it works

Two processes coordinate through files in `--state-dir`, so any agent/harness
can drive the loop: `server.mjs` (long-running HTTP server; renders, serves
`/api/*`, watches the file, pushes SSE refreshes) and `wait_for_review.mjs`
(a blocking one-shot the agent re-runs each round; its **exit code** reports
what happened: 0 = event, 2 = timeout, 3 = server dead). Annotations are
anchored **by text, not line numbers**: each carries a byte-exact
`quotedSource` the agent locates and edits. See
[`SKILL.md`](skills/cc-redline/SKILL.md) for the full agent-facing contract.

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
