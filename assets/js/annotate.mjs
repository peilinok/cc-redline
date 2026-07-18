// Review annotation store, interactions, inline highlights, comment rail, submit/done.
import { sectionRange, sliceLines, DOC_START } from './blocks.mjs';
import { t, applyStaticI18n } from './i18n.mjs';

// Cross-mode selection matching: text selected in one view (rendered vs source)
// must be located in the other, where inline markdown (**bold**, `code`, [x](y))
// makes the two strings differ. stripInline turns a string plain; locate finds a
// plain needle inside a possibly-marked-up haystack, skipping delimiters + link URLs.
function stripInline(s) {
  return String(s)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // [text](url) / ![alt](url) → text
    .replace(/[*_`~]/g, '');
}
function locate(haystack, needle) {
  if (!needle) return null;
  const DELIM = '*_`~[]!';
  for (let start = 0; start < haystack.length; start++) {
    let h = start, ni = 0, first = -1, last = -1;
    while (ni < needle.length && h < haystack.length) {
      const hc = haystack[h];
      if (hc === ']' && haystack[h + 1] === '(') { // skip a link/image URL: ](...)
        h += 2; let depth = 1;
        while (h < haystack.length && depth > 0) { const c = haystack[h++]; if (c === '(') depth++; else if (c === ')') depth--; }
        continue;
      }
      if (DELIM.includes(hc)) { h++; continue; }
      if (hc === needle[ni]) { if (first < 0) first = h; last = h; h++; ni++; continue; }
      break;
    }
    if (ni === needle.length) return [first, last + 1];
  }
  return null;
}

export function initAnnotations({
  contentEl, rawViewEl, docPane, rail, globalBtn, submitBtn, doneBtn, selectionBtn, popover,
  getDoc, getParsed, onSubmitted, onDone, onReflow, onNav,
}) {
  let annotations = [];
  let nextId = 1;
  let globalComment = '';
  let globalSubmitted = false; // globalComment sent and awaiting the AI's edit
  let pending = null; // { target, existing } | { global: true } while the popover is open
  let currentRange = null;
  let currentRangeMode = null; // 'render' | 'raw' — which view the pending selection came from
  let focusMap = new Map(); // annId -> { card, anchor }
  let navCurrentId = null; // annotation the prev/next navigation last landed on

  const scopeLabel = (scope) => ({ block: t('scope.block'), section: t('scope.section'), selection: t('scope.selection'), line: t('scope.line') }[scope] || scope);

  function excerpt(ann) {
    const one = (ann.selectedText || ann.quotedSource || '').replace(/\s+/g, ' ').trim();
    return one.length > 240 ? one.slice(0, 240) + '…' : one;
  }

  // ----- target builders -----
  function buildTarget(scope, blockEl) {
    const parsed = getParsed();
    const doc = getDoc();
    const block = parsed.blocks.find((b) => b.id === blockEl.id);
    if (!block) return null;
    if (scope === 'section') {
      const range = sectionRange(parsed.blocks, block.id);
      if (!range) return null;
      return {
        scope, sectionPath: block.sectionPath, blockId: block.id,
        startLine: range.startLine, endLine: range.endLine,
        quotedSource: sliceLines(doc.content, range.startLine, range.endLine),
      };
    }
    return {
      scope: 'block', sectionPath: block.sectionPath, blockId: block.id,
      startLine: block.startLine, endLine: block.endLine,
      quotedSource: sliceLines(doc.content, block.startLine, block.endLine),
    };
  }

  // Raw view: one exact source line. quotedSource is that line verbatim.
  function buildLineTarget(line) {
    const doc = getDoc();
    const lines = doc.content.split('\n');
    if (!Number.isInteger(line) || line < 1 || line > lines.length) return null;
    const block = getParsed().blocks.find((b) => b.startLine <= line && b.endLine >= line);
    return {
      scope: 'line',
      sectionPath: block ? block.sectionPath : DOC_START,
      blockId: block ? block.id : null,
      startLine: line, endLine: line,
      quotedSource: sliceLines(doc.content, line, line),
    };
  }

  // Text of a range with annotation handles stripped. Offsets are measured in
  // this handle-stripped space; applyHighlights walks the same skipped set.
  function rangeText(range) {
    const frag = range.cloneContents();
    frag.querySelectorAll('.handles').forEach((h) => h.remove());
    return frag.textContent;
  }

  function buildSelectionTarget(range) {
    const blocks = [...contentEl.querySelectorAll('.block')].filter((el) => range.intersectsNode(el));
    const selectedText = rangeText(range);
    if (!blocks.length || !selectedText.trim()) return null;
    const first = blocks[0];
    const last = blocks[blocks.length - 1];
    const startLine = Number(first.dataset.startLine);
    const endLine = Number(last.dataset.endLine);
    const pre = document.createRange();
    pre.setStart(first, 0);
    pre.setEnd(range.startContainer, range.startOffset);
    const before = rangeText(pre);
    const selStart = before.length;
    const selEnd = selStart + selectedText.length;
    let occurrence = 1;
    let i = before.indexOf(selectedText);
    while (i !== -1) { occurrence++; i = before.indexOf(selectedText, i + 1); }
    const firstBlock = getParsed().blocks.find((b) => b.id === first.id);
    return {
      scope: 'selection', origin: 'render',
      sectionPath: firstBlock ? firstBlock.sectionPath : DOC_START,
      startLine, endLine,
      quotedSource: sliceLines(getDoc().content, startLine, endLine),
      selectedText, selectedOccurrence: occurrence,
      selBlockIds: blocks.map((b) => b.id), selStart, selEnd,
    };
  }

  // Raw view: a character span selected across one or more source lines. Offsets
  // are true source columns, so highlighting is exact and the agent can anchor by
  // quotedSource / selectedText just like a render selection.
  function rawLineOf(node) {
    const el = node.nodeType === 3 ? node.parentElement : node;
    return el ? el.closest('.raw-line') : null;
  }
  function rawColAt(row, container, offset) {
    const tx = row.querySelector('.raw-tx');
    if (!tx) return 0;
    const r = document.createRange();
    r.selectNodeContents(tx);
    try { r.setEnd(container, offset); } catch { return 0; }
    return r.toString().length;
  }
  function buildRawSelectionTarget(range) {
    const startRow = rawLineOf(range.startContainer);
    const endRow = rawLineOf(range.endContainer);
    if (!startRow || !endRow) return null;
    let sLine = Number(startRow.dataset.line);
    let eLine = Number(endRow.dataset.line);
    let sCol = rawColAt(startRow, range.startContainer, range.startOffset);
    let eCol = rawColAt(endRow, range.endContainer, range.endOffset);
    if (sLine > eLine || (sLine === eLine && sCol > eCol)) { [sLine, eLine] = [eLine, sLine]; [sCol, eCol] = [eCol, sCol]; }
    const doc = getDoc();
    const srcLines = doc.content.split('\n');
    let selectedText;
    if (sLine === eLine) {
      selectedText = (srcLines[sLine - 1] || '').slice(sCol, eCol);
    } else {
      const parts = [(srcLines[sLine - 1] || '').slice(sCol)];
      for (let L = sLine + 1; L < eLine; L++) parts.push(srcLines[L - 1] || '');
      parts.push((srcLines[eLine - 1] || '').slice(0, eCol));
      selectedText = parts.join('\n');
    }
    if (!selectedText.trim()) return null;
    const block = getParsed().blocks.find((b) => b.startLine <= sLine && b.endLine >= sLine);
    return {
      scope: 'selection', origin: 'raw',
      sectionPath: block ? block.sectionPath : DOC_START,
      startLine: sLine, endLine: eLine,
      quotedSource: sliceLines(doc.content, sLine, eLine),
      selectedText, selectedOccurrence: 1,
      selStartLine: sLine, selStartCol: sCol, selEndLine: eLine, selEndCol: eCol,
    };
  }

  // ----- popover -----
  function openPopover(target, at, existing = null) {
    pending = { target, existing };
    const path = target.sectionPath === DOC_START ? t('doc.start') : target.sectionPath;
    popover.target.textContent =
      t('popover.target', { scope: scopeLabel(target.scope), path, start: target.startLine, end: target.endLine }) +
      (target.selectedText ? t('popover.targetSel', { sel: target.selectedText.slice(0, 40) }) : '');
    popover.text.value = existing ? existing.comment : '';
    showPopover(at);
  }
  function editGlobal() {
    pending = { global: true };
    popover.target.textContent = t('global.target');
    popover.text.value = globalComment;
    showPopover({ x: window.innerWidth - 24, y: 56 });
  }
  function showPopover(at) {
    popover.root.hidden = false;
    popover.root.style.left = Math.max(8, Math.min(at.x, window.innerWidth - 336)) + 'px';
    popover.root.style.top = Math.max(8, Math.min(at.y + 8, window.innerHeight - 190)) + 'px';
    popover.text.focus();
  }
  function closePopover() {
    popover.root.hidden = true;
    pending = null;
  }
  popover.save.addEventListener('click', () => {
    if (!pending) return;
    const comment = popover.text.value.trim();
    if (pending.global) {
      globalComment = comment;
      globalSubmitted = false; // edited → a fresh draft again
      updateGlobalBtn();
    } else if (comment) {
      if (pending.existing) pending.existing.comment = comment;
      else annotations.push({ id: 'a' + nextId++, ...pending.target, comment });
    }
    closePopover();
    refreshUi();
  });
  popover.cancel.addEventListener('click', closePopover);
  // Enter saves; Shift+Enter is a newline; Esc cancels. Ignore keys that only drive
  // an IME composition (isComposing / keyCode 229), so Chinese input isn't cut short.
  popover.text.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      popover.save.click();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closePopover();
    }
  });

  // ----- block / section handles (delegated, render mode) -----
  contentEl.addEventListener('click', (e) => {
    const handle = e.target.closest('.handle-block, .handle-section');
    if (!handle) return;
    const blockEl = handle.closest('.block');
    if (!blockEl) return;
    const scope = handle.classList.contains('handle-section') ? 'section' : 'block';
    const target = buildTarget(scope, blockEl);
    if (target) openPopover(target, { x: e.clientX, y: e.clientY });
  });

  // ----- text selection (both modes) -----
  document.addEventListener('mouseup', (e) => {
    const mode = document.body.dataset.mode;
    if (e.target instanceof Element && e.target.closest('#popover, #selection-btn, #rail, #topbar, #ruler')) return;
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) { selectionBtn.hidden = true; return; }
      const range = sel.getRangeAt(0);
      const root = mode === 'raw' ? rawViewEl : contentEl;
      if (!root || !root.contains(range.commonAncestorContainer)) { selectionBtn.hidden = true; return; }
      currentRange = range.cloneRange();
      currentRangeMode = mode;
      selectionBtn.hidden = false;
      selectionBtn.style.left = Math.min(e.clientX, window.innerWidth - 140) + 'px';
      selectionBtn.style.top = (e.clientY + 10) + 'px';
    }, 0);
  });
  selectionBtn.addEventListener('click', (e) => {
    selectionBtn.hidden = true;
    if (!currentRange) return;
    const target = currentRangeMode === 'raw' ? buildRawSelectionTarget(currentRange) : buildSelectionTarget(currentRange);
    currentRange = null;
    if (target) openPopover(target, { x: e.clientX, y: e.clientY });
  });

  // ----- inline highlights -----
  function textNodesUnder(el) {
    const out = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement && n.parentElement.closest('.handles')) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    let n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }

  function wrapRange(nodes, start, end, ann, out) {
    let pos = 0;
    for (const node of nodes) {
      const len = node.data.length;
      const nodeStart = pos;
      pos += len;
      if (pos <= start) continue;
      if (nodeStart >= end) break;
      const from = Math.max(0, start - nodeStart);
      const to = Math.min(len, end - nodeStart);
      if (to <= from) continue;
      const r = document.createRange();
      r.setStart(node, from);
      r.setEnd(node, to);
      const mark = document.createElement('mark');
      mark.className = 'ann-mark';
      mark.dataset.annId = ann.id;
      r.surroundContents(mark);
      out.push(mark);
    }
  }

  // Best-effort: wrap the `occurrence`-th match of `needle` across `nodes`.
  // Used to show a raw-origin selection in the render view (source text ≈ rendered).
  function wrapByText(nodes, needle, ann) {
    const clean = stripInline((needle || '').trim());
    if (!clean) return;
    const full = nodes.map((n) => n.data).join('');
    const span = locate(full, clean);
    if (!span) return;
    try { wrapRange(nodes, span[0], span[1], ann, []); } catch { /* skip */ }
  }

  // Raw view: wrap chars [from,to) of one source line's text in a mark.
  function wrapRawSpan(row, from, to, ann) {
    const tx = row.querySelector('.raw-tx');
    const textNode = tx && tx.firstChild;
    if (!textNode || textNode.nodeType !== 3) return;
    const len = textNode.data.length;
    const f = Math.max(0, Math.min(from, len));
    const t = Math.max(f, Math.min(to, len));
    if (t <= f) return;
    const r = document.createRange();
    r.setStart(textNode, f);
    r.setEnd(textNode, t);
    const mark = document.createElement('mark');
    mark.className = 'ann-mark';
    mark.dataset.annId = ann.id;
    try { r.surroundContents(mark); } catch { /* overlaps an existing mark; skip */ }
  }

  // The per-line [from,to) column segments a selection covers in the raw view.
  function rawSelectionSegments(a, srcLines) {
    const segs = [];
    if (a.origin === 'raw' && a.selStartLine) {
      for (let L = a.selStartLine; L <= a.selEndLine; L++) {
        const lineLen = (srcLines[L - 1] || '').length;
        const from = L === a.selStartLine ? a.selStartCol : 0;
        const to = L === a.selEndLine ? a.selEndCol : lineLen;
        if (to > from) segs.push({ ln: L, from, to });
      }
    } else {
      const needle = stripInline((a.selectedText || '').split('\n')[0].trim());
      if (needle) {
        for (let L = a.startLine; L <= a.endLine; L++) {
          const span = locate(srcLines[L - 1] || '', needle);
          if (span) { segs.push({ ln: L, from: span[0], to: span[1] }); break; }
        }
      }
    }
    return segs;
  }

  // Source line a Raw annotation anchors to: a raw selection's own start line, a
  // render selection's line that contains the selected text, otherwise its first line.
  function rawAnchorLine(a, srcLines) {
    if (a.scope === 'selection') {
      if (a.origin === 'raw' && a.selStartLine) return a.selStartLine;
      const needle = stripInline((a.selectedText || '').split('\n')[0].trim());
      if (needle) {
        for (let L = a.startLine; L <= a.endLine; L++) {
          if (locate(srcLines[L - 1] || '', needle)) return L;
        }
      }
    }
    return a.startLine;
  }

  function unwrapMarks(root) {
    for (const mark of root.querySelectorAll('.ann-mark')) {
      const parent = mark.parentNode;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parent.normalize();
    }
  }

  function clearHighlights() {
    unwrapMarks(contentEl);
    for (const el of contentEl.querySelectorAll('.block')) {
      el.classList.remove('annotated', 'has-ann', 'ann-focus');
      delete el.dataset.count;
    }
    if (rawViewEl) {
      unwrapMarks(rawViewEl);
      for (const row of rawViewEl.querySelectorAll('.raw-line')) row.classList.remove('annotated', 'ann-focus');
    }
  }

  function applyHighlights() {
    clearHighlights();
    const srcLines = getDoc().content.split('\n');
    // Render view: block/section paint the whole block; any touch adds the count
    // badge; selections paint only their own text (below).
    for (const el of contentEl.querySelectorAll('.block')) {
      const bs = Number(el.dataset.startLine);
      const be = Number(el.dataset.endLine);
      const touching = annotations.filter((a) =>
        a.scope === 'selection'
          ? (a.selBlockIds ? a.selBlockIds.includes(el.id) : (a.startLine <= be && a.endLine >= bs))
          : (a.startLine <= be && a.endLine >= bs));
      if (!touching.length) continue;
      el.classList.add('has-ann');
      el.classList.toggle('annotated', touching.some((a) => a.scope === 'block' || a.scope === 'section'));
      el.dataset.count = String(touching.length);
    }
    for (const a of annotations) {
      if (a.scope !== 'selection') continue;
      if (a.origin !== 'raw' && a.selBlockIds) {
        // render selection: exact offset-based wrap
        const blocks = a.selBlockIds.map((id) => document.getElementById(id)).filter(Boolean);
        if (!blocks.length) continue;
        const nodes = [];
        for (const b of blocks) nodes.push(...textNodesUnder(b));
        try { wrapRange(nodes, a.selStart, a.selEnd, a, []); } catch { /* offsets stale after an edit; skip */ }
      } else {
        // raw selection shown in render: locate the selected text within its block
        const block = getParsed().blocks.find((b) => b.startLine <= a.startLine && b.endLine >= a.startLine);
        const el = block && document.getElementById(block.id);
        if (el) wrapByText(textNodesUnder(el), (a.selectedText || '').split('\n')[0], a);
      }
    }
    // Raw view: block/line/section paint whole covered lines; a selection paints
    // only the exact characters it spans.
    if (rawViewEl) {
      for (const row of rawViewEl.querySelectorAll('.raw-line')) {
        const ln = Number(row.dataset.line);
        if (annotations.some((a) => a.scope !== 'selection' && a.startLine <= ln && a.endLine >= ln)) {
          row.classList.add('annotated');
        }
      }
      const segsByLine = new Map();
      for (const a of annotations) {
        if (a.scope !== 'selection') continue;
        for (const seg of rawSelectionSegments(a, srcLines)) {
          if (!segsByLine.has(seg.ln)) segsByLine.set(seg.ln, []);
          segsByLine.get(seg.ln).push({ ...seg, ann: a });
        }
      }
      for (const [ln, segs] of segsByLine) {
        const row = rawViewEl.querySelector(`.raw-line[data-line="${ln}"]`);
        if (!row) continue;
        segs.sort((x, y) => y.from - x.from); // right-to-left so earlier offsets stay valid
        for (const seg of segs) wrapRawSpan(row, seg.from, seg.to, seg.ann);
      }
    }
    // Tag submitted annotations' inline marks so they read as locked / in-flight.
    const submittedIds = new Set(annotations.filter((a) => a.submitted).map((a) => a.id));
    if (submittedIds.size) {
      for (const root of [contentEl, rawViewEl]) {
        if (!root) continue;
        for (const m of root.querySelectorAll('.ann-mark')) {
          if (submittedIds.has(m.dataset.annId)) m.classList.add('submitted');
        }
      }
    }
  }

  // ----- comment rail -----
  function anchorEl(a) {
    if (document.body.dataset.mode === 'raw') {
      if (!rawViewEl) return null;
      if (a.scope === 'selection') {
        const m = rawViewEl.querySelector(`.ann-mark[data-ann-id="${a.id}"]`);
        if (m) return m;
      }
      const ln = rawAnchorLine(a, getDoc().content.split('\n'));
      return rawViewEl.querySelector(`.raw-line[data-line="${ln}"]`);
    }
    if (a.scope === 'selection') {
      const m = contentEl.querySelector(`.ann-mark[data-ann-id="${a.id}"]`);
      if (m) return m;
      const block = getParsed().blocks.find((b) => b.startLine <= a.startLine && b.endLine >= a.startLine);
      const bid = a.blockId || (a.selBlockIds && a.selBlockIds[0]) || (block && block.id);
      return bid ? document.getElementById(bid) : null;
    }
    return a.blockId ? document.getElementById(a.blockId) : null;
  }

  function focusAnn(id) {
    const f = focusMap.get(id);
    if (!f) return;
    f.card.classList.add('focused');
    if (f.anchor) f.anchor.classList.add('ann-focus');
  }
  function unfocusAnn(id) {
    const f = focusMap.get(id);
    if (!f) return;
    f.card.classList.remove('focused');
    if (f.anchor) f.anchor.classList.remove('ann-focus');
  }
  function flash(el) {
    el.classList.remove('ann-flash');
    void el.offsetWidth; // restart the animation
    el.classList.add('ann-flash');
    setTimeout(() => el.classList.remove('ann-flash'), 700);
  }

  function makeCard(a, anchor) {
    const card = document.createElement('div');
    card.className = 'rail-card' + (a.submitted ? ' submitted' : '');
    card.dataset.annId = a.id;
    const head = document.createElement('div');
    head.className = 'rail-head';
    const scope = document.createElement('span');
    scope.className = 'ann-scope';
    scope.textContent = scopeLabel(a.scope);
    const loc = document.createElement('span');
    loc.className = 'rail-loc';
    const locPath = a.sectionPath === DOC_START ? t('doc.start') : a.sectionPath;
    loc.textContent = `${locPath} · L${a.startLine}-${a.endLine}`;
    head.append(scope, loc);
    if (a.submitted) {
      const tag = document.createElement('span');
      tag.className = 'rail-submitted';
      tag.textContent = t('rail.submitted');
      head.append(tag);
    }
    const ex = document.createElement('div');
    ex.className = 'rail-excerpt';
    ex.textContent = excerpt(a);
    const cm = document.createElement('div');
    cm.className = 'rail-comment';
    cm.textContent = a.comment;
    card.append(head, ex, cm);
    // submitted annotations are locked (in flight); no edit/delete until the AI replies
    if (!a.submitted) {
      const actions = document.createElement('div');
      actions.className = 'rail-actions';
      const edit = document.createElement('button');
      edit.textContent = t('rail.edit');
      edit.addEventListener('click', (e) => { e.stopPropagation(); openPopover(a, { x: e.clientX, y: e.clientY }, a); });
      const del = document.createElement('button');
      del.textContent = t('rail.delete');
      del.addEventListener('click', (e) => { e.stopPropagation(); annotations = annotations.filter((x) => x !== a); refreshUi(); });
      actions.append(edit, del);
      card.append(actions);
    }
    card.addEventListener('mouseenter', () => focusAnn(a.id));
    card.addEventListener('mouseleave', () => unfocusAnn(a.id));
    card.addEventListener('click', () => {
      if (anchor) { anchor.scrollIntoView({ block: 'center', behavior: 'smooth' }); flash(anchor); }
    });
    return card;
  }

  function renderRail() {
    rail.textContent = '';
    focusMap = new Map();
    if (annotations.length) {
      const paneRect = docPane.getBoundingClientRect();
      const scrollTop = docPane.scrollTop;
      const items = [];
      for (const a of annotations) {
        const anchor = anchorEl(a);
        if (!anchor) continue;
        const top = anchor.getBoundingClientRect().top - paneRect.top + scrollTop;
        items.push({ a, anchor, top });
      }
      items.sort((x, y) => x.top - y.top);
      for (const it of items) {
        it.card = makeCard(it.a, it.anchor);
        it.card.style.top = it.top + 'px';
        rail.appendChild(it.card);
        focusMap.set(it.a.id, { card: it.card, anchor: it.anchor });
      }
      // de-collide: never let a card overlap the previous one
      let prevBottom = -Infinity;
      for (const it of items) {
        const top = Math.max(it.top, prevBottom + 8);
        it.card.style.top = top + 'px';
        prevBottom = top + it.card.offsetHeight;
      }
    }
    if (navCurrentId) setNavCurrent(navCurrentId); // rail/marks were rebuilt
    onReflow?.(); // keep the overview ruler in sync with every annotation change
    onNav?.(navState()); // refresh the prev/next navigation counter
  }

  // Annotation positions in #doc-pane content coordinates, for the overview ruler.
  function getMarkers() {
    const paneRect = docPane.getBoundingClientRect();
    const scrollTop = docPane.scrollTop;
    const out = [];
    for (const a of annotations) {
      const anchor = anchorEl(a);
      if (!anchor) continue;
      const rect = anchor.getBoundingClientRect();
      if (!rect.height && !rect.top) continue; // hidden in the other mode
      out.push({ y: rect.top - paneRect.top + scrollTop, scope: a.scope, id: a.id, comment: a.comment });
    }
    return out;
  }

  // ----- prev/next annotation navigation (like a code-review tool) -----
  function orderedAnns() {
    const paneRect = docPane.getBoundingClientRect();
    const scrollTop = docPane.scrollTop;
    return annotations
      .map((a) => { const el = anchorEl(a); return el ? { a, y: el.getBoundingClientRect().top - paneRect.top + scrollTop } : null; })
      .filter(Boolean)
      .sort((x, y) => x.y - y.y)
      .map((it) => it.a);
  }
  function navState() {
    const ordered = orderedAnns();
    const pos = navCurrentId ? ordered.findIndex((a) => a.id === navCurrentId) : -1;
    return { index: pos >= 0 ? pos + 1 : 0, total: ordered.length };
  }
  // Persistent "current" marker on the navigated-to annotation (card + anchor).
  function setNavCurrent(id) {
    for (const root of [contentEl, rawViewEl, rail]) {
      if (root) for (const c of root.querySelectorAll('.nav-current')) c.classList.remove('nav-current');
    }
    const f = focusMap.get(id);
    if (f) { f.card.classList.add('nav-current'); if (f.anchor) f.anchor.classList.add('nav-current'); }
  }
  // dir: +1 next, -1 previous; wraps around. Scrolls to, flashes, marks as current.
  function navigate(dir) {
    const ordered = orderedAnns();
    const total = ordered.length;
    if (!total) { navCurrentId = null; onNav?.({ index: 0, total: 0 }); return; }
    let idx = navCurrentId ? ordered.findIndex((a) => a.id === navCurrentId) : -1;
    idx = idx === -1 ? (dir >= 0 ? 0 : total - 1) : (idx + dir + total) % total;
    const target = ordered[idx];
    navCurrentId = target.id;
    setNavCurrent(target.id);
    const el = anchorEl(target);
    if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); flash(el); }
    onNav?.({ index: idx + 1, total });
  }

  // Hovering a highlight in the document focuses its rail card, and vice versa.
  function wireHoverLinks() {
    const forEachAnnOn = (target, fn) => {
      if (!(target instanceof Element)) return;
      const mark = target.closest('.ann-mark');
      if (mark && mark.dataset.annId) return fn(mark.dataset.annId);
      const block = target.closest('.block.has-ann');
      if (block) { for (const a of annotations) if (a.blockId === block.id) fn(a.id); return; }
      const row = target.closest('.raw-line.annotated');
      if (row) {
        const src = getDoc().content.split('\n');
        const ln = Number(row.dataset.line);
        for (const a of annotations) if (rawAnchorLine(a, src) === ln) fn(a.id);
      }
    };
    for (const el of [contentEl, rawViewEl]) {
      if (!el) continue;
      el.addEventListener('mouseover', (e) => forEachAnnOn(e.target, focusAnn));
      el.addEventListener('mouseout', (e) => forEachAnnOn(e.target, unfocusAnn));
    }
  }
  wireHoverLinks();

  // ----- submit / done -----
  function updateGlobalBtn() {
    globalBtn.classList.toggle('active', !!globalComment);
  }
  const draftCount = () => annotations.filter((a) => !a.submitted).length;
  function updateSubmitBtn() {
    const n = draftCount();
    submitBtn.textContent = t('btn.submit', { n });
    submitBtn.disabled = n === 0 && !(globalComment && !globalSubmitted);
  }
  function refreshUi() {
    applyHighlights();
    renderRail();
    updateSubmitBtn();
  }

  submitBtn.addEventListener('click', async () => {
    const drafts = annotations.filter((a) => !a.submitted);
    const sendGlobal = !!globalComment && !globalSubmitted;
    if (!drafts.length && !sendGlobal) return;
    submitBtn.disabled = true;
    // The DOM/offset fields are client-only anchoring hints; the agent anchors by
    // quotedSource / selectedText, so drop them (and the client-only `submitted`).
    const clean = drafts.map(({
      selBlockIds, selStart, selEnd, blockId,
      selStartLine, selStartCol, selEndLine, selEndCol, origin, submitted,
      ...rest
    }) => rest);
    const payload = {
      docVersion: getDoc().version,
      globalComment: sendGlobal ? globalComment : null,
      annotations: clean,
    };
    try {
      const res = await fetch('/api/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      // Lock what we sent instead of clearing it — stays visible, awaiting the AI.
      drafts.forEach((a) => { a.submitted = true; });
      if (sendGlobal) globalSubmitted = true;
      refreshUi();
      onSubmitted();
    } catch (err) {
      alert(t('alert.submitFailed', { err }));
      updateSubmitBtn();
    }
  });
  doneBtn.addEventListener('click', async () => {
    if (!confirm(t('confirm.done'))) return;
    try {
      await fetch('/api/done', { method: 'POST' });
    } catch { /* server may exit before the response lands */ }
    submitBtn.disabled = true;
    doneBtn.disabled = true;
    onDone();
  });

  // ----- public api -----
  return {
    hasPending: () => draftCount() > 0 || (!!globalComment && !globalSubmitted),
    discardPending: () => {
      annotations = [];
      globalComment = '';
      globalSubmitted = false;
      updateGlobalBtn();
      refreshUi();
    },
    // The AI's edit landed: drop the submitted batch it consumed, keep any new drafts.
    consumeSubmitted: () => {
      annotations = annotations.filter((a) => !a.submitted);
      if (globalSubmitted) { globalComment = ''; globalSubmitted = false; updateGlobalBtn(); }
      refreshUi();
    },
    annotateLine: (line, at) => {
      const target = buildLineTarget(line);
      if (target) openPopover(target, at);
    },
    editGlobal,
    reflow: () => { renderRail(); updateSubmitBtn(); },
    getMarkers,
    navigate,
    onDocRerendered: () => {
      for (const el of contentEl.querySelectorAll('.block')) {
        const handles = document.createElement('div');
        handles.className = 'handles';
        const hb = document.createElement('button');
        hb.className = 'handle-block';
        hb.dataset.i18nTitle = 'handle.block';
        hb.dataset.i18nLabel = 'handle.block';
        hb.textContent = '+';
        handles.appendChild(hb);
        if (el.dataset.type === 'heading') {
          const hs = document.createElement('button');
          hs.className = 'handle-section';
          hs.dataset.i18nTitle = 'handle.section';
          hs.dataset.i18nLabel = 'handle.section';
          hs.textContent = '§';
          handles.appendChild(hs);
        }
        el.prepend(handles);
      }
      applyStaticI18n(contentEl); // fill handles' title/label for the current language
      refreshUi();
    },
  };
}
