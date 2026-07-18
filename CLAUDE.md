# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

**cc-redline** is a **Claude Code skill**, not a standalone app. The product is a
"browser-based interactive Markdown review loop": a local, zero-dependency web
service renders a Markdown file (spec / design doc / PRD / README / any `.md`);
the user annotates blocks, sections, selected text, or exact source lines and
submits; the driving **review agent** applies the annotations back to the file;
the page auto-refreshes via a file watcher. Repeat until the user clicks
"End review".

The repo doubles as a **Claude Code plugin + marketplace** (`.claude-plugin/`
holds `plugin.json` and `marketplace.json`; install via
`/plugin marketplace add peilinok/cc-redline`). The skill body lives under
`skills/cc-redline/` — **paths in the architecture notes below are relative to
that directory**; commands shown are runnable from the repo root.

`SKILL.md` is the **agent-facing contract** (trigger conditions; start / wait /
apply / end flow; annotation field semantics). It is not ordinary docs — when you
change the submission protocol or annotation structure you MUST update it in
lockstep, or the driving agent's behavior drifts from the implementation.
`evals/evals.json` holds the behavioral assertions for that contract.

## Common commands

No build, no bundler, no lint config: plain Node ESM + vendored static assets,
requires `node >= 18`.

    # run all tests — use the glob; a bare dir MODULE_NOT_FOUNDs on node 22 / Windows
    node --test skills/cc-redline/scripts/tests/*.test.mjs
    # a single file
    node --test skills/cc-redline/scripts/tests/blocks.test.mjs
    # filter by name
    node --test --test-name-pattern="sectionRange" skills/cc-redline/scripts/tests/*.test.mjs
    # run the server by hand (normally the agent starts it as a background task)
    node skills/cc-redline/scripts/server.mjs <file.md> --state-dir /tmp/cc-redline-1   # --no-open, --port N
    # one blocking wait round (exit code is the channel)
    node skills/cc-redline/scripts/wait_for_review.mjs --state-dir /tmp/cc-redline-1 --timeout-sec 540
    # lint the plugin/marketplace manifests
    claude plugin validate . --strict

    # browser E2E (repo root; needs `npm ci` once + a system Chrome, dev-only)
    npm run test:e2e

After changing the UI (`assets/`), run the browser E2E suite (`e2e/*.spec.mjs`,
Playwright driving system Chrome) — it automates the core of `SKILL.md`'s
**Manual acceptance checklist**, including the full submit → agent-edit → SSE
refresh loop and the submission-JSON contract. The checklist itself remains the
authority for the few visual items E2E doesn't cover (ruler ticks, card
alignment); walk it for UI changes touching those. `@playwright/test` is a
**devDependency only** — the zero-runtime-deps invariant is about the shipped
skill, which still needs no `npm install`.

## Architecture

### Two processes + a file-based state protocol (core, harness-agnostic)

The server and the agent **never talk directly**; they coordinate through files in
`STATE_DIR`, so any agent/harness can drive the same loop:

- `server.mjs`: long-running background process, survives across turns.
- `wait_for_review.mjs`: a foreground **blocking** script, re-run each round, that
  reports what happened through its **exit code**.
- `STATE_DIR` files: `server-info.json` (written as soon as the server listens,
  `{url,port,pid,...}`), `submission-<seq>.json` (a browser submission), `done.json`.

One round: browser POST → server atomically writes `submission-N.json` → the wait
script finds it, **renames it to `.consumed`**, prints it, `exit 0` → the agent
applies the annotations and saves → `fs.watchFile` detects the change and pushes an
SSE refresh → the agent runs the wait script again. Exit codes: `0` = event,
`2` = timeout (re-run silently), `3` = server dead (`process.kill(pid,0)` probe).

All state files use **write-`.tmp`-then-`rename`** atomic writes so the wait script
never reads half a JSON. Preserve this invariant.

### Server `scripts/server.mjs`

Zero-dependency `http` server, binds `127.0.0.1`, default port `0` (ephemeral).
`createApp()` is split from the CLI entry (`isMain`) so tests call `createApp`
directly. Routes: `GET /` → app.html; `/assets/*`; `/doc-assets/*` → files relative
to the **reviewed doc's dir** (images); `/api/doc`; `/api/events` (SSE);
`POST /api/submit`, `POST /api/done`. `serveStatic` has **path-traversal guards**
(`\0` block + `normalize` prefix check) covered by `server.test.mjs` — don't weaken
them. Uses `fs.watchFile` (stat polling, 500ms), **not** `fs.watch`: editors/agents
save via temp-file + rename, which `fs.watch` misreports on Windows.

### Anchoring contract `assets/js/blocks.mjs` (read the header comment first)

The agent applies annotations **by text, never by line number**: `quotedSource` is a
byte-exact source slice. `blocks.mjs` splits Markdown into top-level blocks (1-based
closed line ranges + `sectionPath` + TOC) and anchors each token by searching forward
**whole source line by whole source line** (because `token.raw` can't byte-match the
source: marked strips `\r`, silently drops some top-level tokens). Comparison
normalizes only trailing whitespace (subsuming `\r`); returned line numbers and
`sliceLines` output stay byte-exact source. The `sliceLines` fidelity (incl. CRLF) is
guarded by `blocks.test.mjs` round-trip tests. `DOC_START` is the language-neutral
default `sectionPath` for content before the first heading.

### Front-end `assets/js/` (ESM modules, no framework)

- `main.mjs`: orchestration + i18n init + language-switch re-render + SSE wiring.
- `render.mjs`: **per-block** `marked.parser`; a single block's failure shows an
  inline error instead of breaking the page; mermaid / KaTeX / highlight.js
  post-processing; relative image `src` rewritten to `/doc-assets/`.
- `annotate.mjs` (largest, interaction core): annotation store + interactions +
  inline highlights + right-rail cards + submit/done. Defines the annotation object
  and submit payload. Four `scope`s: `block` / `section` / `selection` / `line`.
  Cross-mode selection matching via `stripInline` + `locate`. **Strips client-only
  DOM-offset fields on submit** (the agent anchors by `quotedSource`/`selectedText`).
- `blocks.mjs`: pure, **shared by the browser and `node:test`** — no DOM/browser APIs.
- `i18n.mjs`: bilingual (en/zh) display-layer strings, runtime switch.
- `toc.mjs` / `ruler.mjs` / `sse.mjs`: TOC + scroll-spy, overview ruler, EventSource.

### Submit JSON (browser → agent data contract)

`submission-<seq>.json`: `{ type, seq, file, docVersion, submittedAt, globalComment,
annotations[] }`. Key per-annotation fields: `scope`, `quotedSource` (byte-exact
source, primary anchor), `comment` (free-text intent), `sectionPath`/`startLine`/
`endLine` (**verification hints only** — earlier edits may have shifted lines);
`selection` also has `selectedText`/`selectedOccurrence` (rendered-text hints).
`annotations` order is **user creation order**, not document order. **Changing this
structure requires updating `SKILL.md` (§3) and `evals/evals.json` in lockstep.**

## Invariants to preserve when editing

- **Zero runtime deps**: front-end libs all vendored under `assets/vendor/` (versions
  in `VERSIONS.md`) for fully-offline use; server uses only `node:` builtins.
- `quotedSource` byte-exact, `sliceLines` source-faithful (keep internal `\r` under
  CRLF) — guarded by `blocks.test.mjs` round-trip.
- State files always atomic (`.tmp` + `rename`).
- Don't weaken `serveStatic`'s path-traversal guards.
- Submission protocol / exit codes / annotation fields: keep `SKILL.md`,
  `evals/evals.json`, and the implementation in lockstep.
- Front-end changes: run the `SKILL.md` Manual acceptance checklist.
- **i18n**: UI/runtime strings go through `i18n.mjs` `t()`; values written into the
  submission JSON stay language-neutral (`DOC_START`, English `scope` keys).
- **Releases**: bump `version` in `.claude-plugin/plugin.json` (and tag) — installed
  plugins only update when that version changes.
