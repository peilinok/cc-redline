---
name: cc-redline
description: |
  Browser-based interactive markdown review. Start a local zero-dependency web
  service that renders a markdown file (spec / design doc / PRD / README / any
  .md) with Raw and Render modes and a section TOC; the user annotates blocks,
  sections, selected text, or an exact source line and submits; the agent applies
  the annotations to the file and loops until the user clicks "End review" on the
  page. Trigger when the user asks to review / annotate / proofread a markdown
  file interactively, e.g. "review this md in the browser", "帮我 review 这份
  markdown", "在浏览器里批注这份文档", "开始文档 review", or mentions cc-redline.
  Do NOT trigger for plain read / summarize / translate requests.
---

# CC Redline

Interactive review loop for one markdown file: a local web service renders the doc,
the user annotates in the browser, submissions come back as structured JSON, the agent
edits the file, and the browser auto-refreshes. Repeat until the user ends the review
from the page.

## Requirements

- Node.js >= 18 on PATH (`node --version`).
- No npm install; all front-end libraries are vendored under `assets/vendor/`.

## Workflow

Let `SKILL_DIR` be this skill's directory and `DOC` the markdown file to review.

### 1. Start

1. Resolve `DOC` to an absolute path and verify it exists; if not, report and stop.
2. Create a fresh state dir `STATE_DIR` in the session temp/scratchpad area
   (e.g. `<scratchpad>/cc-redline-1`). Never reuse another review's dir.
3. Start the server as a background task (it must keep running across turns):

       node "$SKILL_DIR/scripts/server.mjs" "$DOC" --state-dir "$STATE_DIR"

4. Read `$STATE_DIR/server-info.json` — it is written as soon as the server starts
   listening (normally near-instant; poll briefly, up to a couple seconds, before
   treating its absence as a startup failure). It contains
   `{url, port, pid, file, startedAt}`. Tell the user: the URL (the browser opens
   automatically; if it didn't, open the URL manually), the two modes (Raw / Render,
   default Render — both let you annotate; Raw double-click marks one exact line,
   Render marks blocks / sections / selected text), and that submissions reach you
   automatically.

### 2. Wait loop

Run in the foreground (blocking):

       node "$SKILL_DIR/scripts/wait_for_review.mjs" --state-dir "$STATE_DIR" --timeout-sec 540

Interpret strictly by exit code:

| exit | stdout | action |
|------|--------|--------|
| 0 | `{"type":"submission",...}` | Apply the annotations (section 3), report briefly, then run the wait command again immediately |
| 0 | `{"type":"done",...}` | Review finished: summarize rounds / annotations / main changes. The server exits by itself |
| 2 | (empty) | Timeout. Re-run silently. After 3 consecutive timeouts (~27 min idle), ask the user whether to end; if yes, kill the background server task |
| 3 | `{"type":"server-dead","pid":<n>}` | Server died unexpectedly. Tell the user; offer to restart it with the same `STATE_DIR` (queued state survives) |

### 3. Apply a submission

A submission's `annotations` array is in the order the user created each annotation in
the browser — it is **not** guaranteed sorted by document position. Process it in that
array order; for each annotation:

1. **Anchor by text, not by line numbers.** Each annotation has a `scope` of `block`,
   `section`, `selection`, or `line`; `quotedSource` is the verbatim source it points
   at (for `line`, a single exact source line — the most surgical anchor). Locate
   `quotedSource` verbatim in the current file and edit within that text. For
   `scope: "selection"`, `selectedText`
   and `selectedOccurrence` are *rendered-text* hints for where inside `quotedSource`
   the user pointed — they may not substring-match the source exactly (inline markup
   like `**bold**` or `[text](url)` renders differently than its source), so treat them
   as a locator hint and fall back to `quotedSource` plus the `comment` intent if they
   don't match. `startLine` / `endLine` / `sectionPath` are verification hints only —
   earlier edits in the same round may have shifted lines. `sectionPath` is a heading
   path, or the literal `(document start)` (`DOC_START`) when the content sits before
   the first heading — a locating hint only.
2. Interpret `comment` as free-text intent (it may embed replacement text like
   "change to: xxx").
3. If `quotedSource` no longer matches (an earlier annotation may have rewritten it),
   retry with a distinctive fragment; if still ambiguous (matches nowhere, or matches
   more than once) or the intent is unclear, **do not guess** — skip it and report that
   honestly. This also covers a known, rare edge case: the tool's own block anchoring
   can occasionally attach `quotedSource` to a near-duplicate span elsewhere in the doc
   (documented in `blocks.mjs`) — if the located text doesn't plausibly match
   `sectionPath`/the surrounding context, treat it as a mismatch rather than force it.
4. `globalComment`, when present, applies to the whole document; use judgment.

After applying: save the file (the browser refreshes itself via the file watcher — do
not try to notify it), reply with a 2-3 sentence summary of what changed and anything
skipped, then loop back to the wait command.

### 4. Ending

- Page button "End review" → the wait script returns `done`; the server exits itself.
- The user may also end from chat at any time: kill the background server task, then
  summarize the whole review.

## Troubleshooting

- `server-info.json` never appears / server exits immediately: wrong or unreadable
  `DOC` path — re-check it.
- Browser didn't open: give the user the `url` from `server-info.json`.
- Port conflicts: none expected (the server picks a free port on 127.0.0.1).
- Paths with spaces must stay quoted as shown.

## Manual acceptance checklist

Walk through after any change to this skill, using a fixture doc that contains
headings, a table, a task list, a fenced code block, a mermaid block, `$...$` and
`$$...$$` math, a relative `![](pic.svg)` image, and Chinese text:

- [ ] Render is the default; Raw shows numbered source; switching Raw/Render works
- [ ] TOC shows in both Raw and Render; click jumps (to the block in Render, to
      the source line in Raw); the active section highlights as you scroll either mode
- [ ] Block / section / selection / line / global annotations can be added, edited,
      deleted, in both modes, and stay in sync when switching modes
- [ ] Double-click a source line in Raw adds a `line` annotation for exactly that line
- [ ] Text can be selected for annotation in BOTH modes; the highlight covers only the
      selected characters — not the whole block or the whole raw line — and a card's
      comment/excerpt is never clipped (the card grows / the excerpt scrolls)
- [ ] Each annotation is a card in the right rail, vertically aligned to its anchor and
      non-overlapping; hover a card highlights its anchor and vice versa; clicking a card
      scrolls to and flashes the anchor
- [ ] The far-right overview ruler shows gray heading ticks and colored annotation ticks
      (gold block/section, red selection, blue line) plus a viewport box; click/drag jumps;
      it stays populated in both modes and Hide annotations drops the annotation ticks
- [ ] Prev/next navigation: the topbar ↑/↓ buttons and the N / P keys jump between
      annotations in document order (counter shows position / total, current one is marked);
      the keys don't fire while a comment popover is open
- [ ] Overall opens the global-comment popover; Hide annotations/Show annotations
      hides/shows all highlights and the rail
- [ ] Submit writes `submission-<seq>.json`; submitted annotations lock in place as
      "Submitted" (edit/delete hidden) instead of clearing, new draft annotations can still be
      added, the waiting banner shows, and the submitted batch clears when the AI's edit lands
- [ ] Saving the file refreshes the browser; with pending annotations a confirm
      banner appears instead of auto-refresh
- [ ] Multiple submissions queue and are consumed in seq order
- [ ] mermaid / KaTeX / highlighted code / local SVG render; a broken mermaid block
      shows an inline error without breaking the page
- [ ] "End review" writes `done.json` and the server exits ~2s later
- [ ] `node --test scripts/tests/*.test.mjs` passes
      (use the glob form; `node --test <dir>/` fails with MODULE_NOT_FOUND on node 22 / Windows)
