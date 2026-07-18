// Pure helpers shared by the browser app and node:test suites:
// split markdown into top-level blocks with 1-based line ranges,
// section paths, and a TOC list. `token.raw` cannot byte-match the
// source: marked strips `\r`, silently drops some top-level tokens
// (e.g. a reference-style link definition whose label duplicates an
// earlier one), and this module's own trailing-whitespace trim below
// discards spaces/`\r` that a source line actually has. Each token
// is therefore anchored by searching forward, whole source line by
// whole source line, normalizing away trailing whitespace (which
// subsumes `\r`) on both sides only for the comparison -- never for
// the returned line numbers or `sliceLines` output, which stays
// byte-exact source. Line granularity is immune to CRLF vs LF and,
// unlike a raw substring search, cannot be fooled by a match that
// occurs mid-line inside dropped content. The `at < 0` fallback
// below is a real, reachable degrade path, not "should not happen":
// it fires when no source position matches every line of a token
// (e.g. lone-`\r` classic-Mac line endings), and ranges past that
// point may then be wrong.
//
// Known, accepted residual: because the comparison normalizes trailing
// whitespace, the forward search can anchor a block to an EARLIER source
// line that is identical after trailing-whitespace normalization -- but
// only when a token marked dropped sits between them (a normal token
// advances the cursor past the decoy). In practice this needs all of:
// a duplicate reference-link definition (so marked drops it), its title
// spilling onto a continuation line, and that line matching a later block
// once trailing whitespace is ignored. Left as-is: fixing the far more
// common trailing-whitespace mis-anchor is worth this rare edge, and
// SKILL.md already tells the agent to report ambiguous anchors rather
// than guess.
import { marked } from '../vendor/marked.esm.js';

// Stable, language-neutral default written into submission JSON when content sits
// before the first heading. UI localizes it for display (i18n key 'doc.start').
export const DOC_START = '(document start)';

function normLine(s) {
  return s.replace(/\s+$/, '');
}

export function parseDocument(markdown) {
  const tokens = marked.lexer(markdown);
  const srcLines = markdown.split('\n');
  const blocks = [];
  const toc = [];
  const sectionStack = []; // [{ depth, text }]
  let cursorLine = 0; // 0-based index into srcLines of the next unconsumed source line
  let idx = 0;
  for (const token of tokens) {
    if (token.type === 'space') continue; // blank-line runs are not blocks; skip without anchoring
    const raw = token.raw ?? '';
    if (!raw) continue;
    const rawLines = raw.replace(/\s+$/, '').split('\n');
    let at = -1;
    for (let i = cursorLine; i <= srcLines.length - rawLines.length; i++) {
      let ok = true;
      for (let j = 0; j < rawLines.length; j++) {
        if (normLine(srcLines[i + j]) !== normLine(rawLines[j])) { ok = false; break; }
      }
      if (ok) { at = i; break; }
    }
    // No position matched every line (e.g. lone-`\r` classic-Mac line endings,
    // out of scope) -- degrade to the cursor rather than throw.
    if (at < 0) at = cursorLine;
    const startLine = at + 1;
    const endLine = at + rawLines.length;
    cursorLine = at + rawLines.length;
    if (token.type === 'heading') {
      while (sectionStack.length && sectionStack[sectionStack.length - 1].depth >= token.depth) {
        sectionStack.pop();
      }
      sectionStack.push({ depth: token.depth, text: token.text });
    }
    const block = {
      id: 'b' + idx++,
      type: token.type,
      depth: token.type === 'heading' ? token.depth : null,
      startLine,
      endLine,
      sectionPath: sectionStack.length ? sectionStack.map((s) => s.text).join(' > ') : DOC_START,
      token,
    };
    blocks.push(block);
    if (token.type === 'heading') {
      toc.push({ blockId: block.id, depth: token.depth, text: token.text, startLine });
    }
  }
  return { blocks, toc, links: tokens.links || {} };
}

export function sectionRange(blocks, headingBlockId) {
  const i = blocks.findIndex((b) => b.id === headingBlockId);
  if (i < 0 || blocks[i].type !== 'heading') return null;
  let endLine = blocks[blocks.length - 1].endLine;
  for (let j = i + 1; j < blocks.length; j++) {
    if (blocks[j].type === 'heading' && blocks[j].depth <= blocks[i].depth) {
      endLine = blocks[j].startLine - 1;
      break;
    }
  }
  return { startLine: blocks[i].startLine, endLine };
}

export function sliceLines(markdown, startLine, endLine) {
  return markdown.split('\n').slice(startLine - 1, endLine).join('\n');
}

// Blocks of `newBlocks` that are new or modified relative to `oldMarkdown`:
// a block is unchanged iff its token.raw still occurs in the old document,
// counted as a multiset so duplicate blocks don't mask real edits. Deletions
// have no surviving block to flag and are deliberately not reported. Used by
// the UI to highlight what the agent's edit touched after a refresh.
export function diffChangedBlocks(oldMarkdown, newBlocks) {
  // Compare trailing-whitespace-normalized raw: marked folds the blank lines
  // after a block into its raw, so the same block's raw differs depending on
  // what follows it (e.g. end-of-file vs. a newly appended neighbor).
  const key = (b) => b.token.raw.replace(/\s+$/, '');
  const oldCounts = new Map();
  for (const b of parseDocument(oldMarkdown).blocks) {
    oldCounts.set(key(b), (oldCounts.get(key(b)) || 0) + 1);
  }
  const changed = [];
  for (const b of newBlocks) {
    const left = oldCounts.get(key(b)) || 0;
    if (left > 0) oldCounts.set(key(b), left - 1);
    else changed.push(b.id);
  }
  return changed;
}
