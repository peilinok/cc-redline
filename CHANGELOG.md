# Changelog

All notable changes are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## [0.3.0] — 2026-07-22

### Added
- **Review history panel**: a read-only history of applied batches grouped by
  round, each annotation showing its scope, quoted excerpt, outcome badge
  (`applied` / `skipped`), and the agent's reasoning note.
- **Processing receipt protocol** (`outcome-<seq>.json`): after applying a
  submitted batch, the agent writes an atomic outcome file recording per
  annotation whether it was `applied` or `skipped` and why. Guarantees a receipt
  even when all annotations are skipped.
- New `GET /api/history` endpoint aggregating submissions and outcomes,
  seq-sorted, with the document's current version for reconciliation.
- New SSE `outcome` event: broadcasts when an outcome file is written,
  unblocking the history panel and enabling live-refresh of per-batch results
  without waiting on document changes.
- Batches now released **per `seq`**: on load, page initialization, and SSE
  events (`hello`, `outcome`, `doc-changed`), the history reconciles against
  `/api/history` as the source of truth, eliminating the case where an all-skip
  round would leave the page waiting forever.
- **Review log** (optional, end-of-review): the agent now offers to append a
  review log (`.txt` file, named with date and timestamp) next to the reviewed
  document.

## [0.2.0] — 2026-07-18

### Added
- Browser E2E suite (Playwright driving system Chrome) automating the core of
  the manual acceptance checklist — including the full submit → agent-edit →
  live-refresh loop and the submission-JSON contract — wired into CI. (#1)
- Flash-highlight of the blocks an agent edit changed after a refresh: a gold
  fade on the block in Render mode and on its source lines in Raw, so edits are
  easy to spot instead of hunting for them. (#2)

### Fixed
- Root-caused and fixed the flaky `fs.watchFile` server tests (libuv's
  baseline-stat timing) via mtime re-touch, ending the intermittent CI reds. (#3)

### Changed
- `setLang` now guards `window.dispatchEvent` for non-browser safety.
- CI upgraded to `actions/checkout@v5` / `actions/setup-node@v5` (clears the
  Node 20 deprecation warnings).

## [0.1.0] — 2026-07-18

- First public release: an interactive in-browser Markdown review loop packaged
  as a Claude Code plugin. Annotate blocks / sections / selections / exact
  source lines; the driving agent applies edits in a loop; byte-exact text
  anchoring; bilingual (English / 中文) UI; zero runtime dependencies (marked /
  mermaid / KaTeX / highlight.js vendored). Unit tests green on Linux / macOS /
  Windows × Node 18 / 22 / 24. MIT licensed.
