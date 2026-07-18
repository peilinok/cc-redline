import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument, sectionRange, sliceLines, DOC_START } from '../../assets/js/blocks.mjs';

test('paragraphs and headings get 1-based closed line ranges', () => {
  const md = '# 标题一\n\n第一段。\n\n第二段第一行\n第二段第二行\n';
  const { blocks } = parseDocument(md);
  assert.equal(blocks.length, 3);
  assert.deepEqual([blocks[0].startLine, blocks[0].endLine], [1, 1]);
  assert.deepEqual([blocks[1].startLine, blocks[1].endLine], [3, 3]);
  assert.deepEqual([blocks[2].startLine, blocks[2].endLine], [5, 6]);
  assert.equal(blocks[0].type, 'heading');
  assert.equal(blocks[0].depth, 1);
});

test('fenced code block with inner blank lines stays one block', () => {
  const md = '## 代码\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n';
  const { blocks } = parseDocument(md);
  const code = blocks.find((b) => b.type === 'code');
  assert.deepEqual([code.startLine, code.endLine], [3, 7]);
});

test('list and table are single blocks; setext heading works', () => {
  const md = '- a\n- b\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n标题\n===\n';
  const { blocks } = parseDocument(md);
  assert.deepEqual([blocks[0].type, blocks[0].startLine, blocks[0].endLine], ['list', 1, 2]);
  assert.deepEqual([blocks[1].type, blocks[1].startLine, blocks[1].endLine], ['table', 4, 6]);
  assert.deepEqual([blocks[2].type, blocks[2].depth, blocks[2].startLine, blocks[2].endLine], ['heading', 1, 8, 9]);
});

test('no trailing newline is handled', () => {
  const { blocks } = parseDocument('只有一行');
  assert.deepEqual([blocks[0].startLine, blocks[0].endLine], [1, 1]);
});

test('section paths nest and pop; content before first heading is (文档开头)', () => {
  const md = '开头段。\n\n# 一\n\n## 一点一\n\n正文A\n\n## 一点二\n\n# 二\n\n正文B\n';
  const { blocks } = parseDocument(md);
  assert.equal(blocks[0].sectionPath, DOC_START);
  const a = blocks.find((b) => b.token.raw.includes('正文A'));
  assert.equal(a.sectionPath, '一 > 一点一');
  const b = blocks.find((b) => b.token.raw.includes('正文B'));
  assert.equal(b.sectionPath, '二');
});

test('toc lists headings with depth and blockId', () => {
  const md = '# 一\n\n## 一点一\n\n# 二\n';
  const { blocks, toc } = parseDocument(md);
  assert.deepEqual(toc.map((t) => [t.depth, t.text]), [[1, '一'], [2, '一点一'], [1, '二']]);
  assert.equal(toc[0].blockId, blocks[0].id);
});

test('sectionRange spans until next same-or-higher heading, else EOF', () => {
  const md = '# 一\n\n## 一点一\n\n内容1\n\n## 一点二\n\n内容2\n\n# 二\n\n内容3\n';
  const { blocks } = parseDocument(md);
  const h11 = blocks.find((b) => b.type === 'heading' && b.token.text === '一点一');
  assert.deepEqual(sectionRange(blocks, h11.id), { startLine: 3, endLine: 6 });
  const h1 = blocks.find((b) => b.type === 'heading' && b.token.text === '一');
  assert.deepEqual(sectionRange(blocks, h1.id), { startLine: 1, endLine: 10 });
  const h2 = blocks.find((b) => b.type === 'heading' && b.token.text === '二');
  assert.deepEqual(sectionRange(blocks, h2.id), { startLine: 11, endLine: 13 });
  assert.equal(sectionRange(blocks, 'nope'), null);
});

test('sliceLines is a 1-based closed-interval slice', () => {
  assert.equal(sliceLines('l1\nl2\nl3', 2, 3), 'l2\nl3');
  assert.equal(sliceLines('l1\nl2\nl3', 1, 1), 'l1');
});

test('duplicate reference-link definition does not corrupt later line numbers (regression)', () => {
  // marked.lexer silently drops a `def` token whose label duplicates an earlier
  // one, so the dropped lines (5-6 below) must not desync every block after them.
  const md = '# Title\n\n[foo]: https://example.com/a "A"\n\n[foo]: https://example.com/b\n"B"\n\n## Next Section\n\nBody text here.\n';
  const { blocks } = parseDocument(md);
  const nextSection = blocks.find((b) => b.type === 'heading' && b.token.text === 'Next Section');
  const body = blocks.find((b) => b.type === 'paragraph');
  assert.deepEqual([nextSection.startLine, nextSection.endLine], [8, 8]);
  assert.deepEqual([body.startLine, body.endLine], [10, 10]);
  assert.equal(sliceLines(md, nextSection.startLine, nextSection.endLine), '## Next Section');
  assert.equal(sliceLines(md, body.startLine, body.endLine), 'Body text here.');
});

const MIXED_FIXTURE_LF = '# Title\n\nIntro paragraph text.  \n\n[foo]: https://example.com/a "A"\n\n[foo]: https://example.com/b\n"B"\n\n## Lists and Quotes\n\n- item a\n- item b  \n\n> quoted line one\n> quoted line two  \n\n## Code and Table\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |  \n\nFinal paragraph after everything.  \n';

function assertRoundTrip(md, crlf) {
  const { blocks } = parseDocument(md);
  // sanity: the fixture actually exercises the dropped-token scenario (only the
  // first [foo] def survives) plus a realistic mix of block types.
  assert.equal(blocks.filter((b) => b.type === 'def').length, 1);
  assert.ok(blocks.some((b) => b.type === 'list'));
  assert.ok(blocks.some((b) => b.type === 'blockquote'));
  assert.ok(blocks.some((b) => b.type === 'code'));
  assert.ok(blocks.some((b) => b.type === 'table'));
  const normLine = (s) => s.replace(/\s+$/, '');
  for (const b of blocks) {
    const slice = sliceLines(md, b.startLine, b.endLine);
    if (crlf && b.endLine > b.startLine) {
      // quotedSource must byte-match the real file, so a multi-line slice of a
      // CRLF source has to keep its internal \r, not just its \n. This half of
      // the invariant is byte-exact and must stay that way -- not normalized.
      assert.ok(slice.includes('\r\n'), `block ${b.id} (${b.type}) lost \\r between its lines`);
    }
    // sliceLines is source-faithful, so on a CRLF fixture every line of the
    // slice (including its last, which has no following \n to pair with) ends
    // in \r; marked's raw never contains \r. Strip \r per-line (not just
    // internal \r\n pairs) before comparing the two.
    const sliceNoCR = slice.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l)).join('\n');
    // A block's last source line can carry trailing whitespace that never
    // survives into `raw` (marked strips it for some token types, e.g. list
    // items; this module's own trim strips it from the rest), while
    // `sliceLines` always returns the real, untrimmed source line. So this
    // content check normalizes trailing whitespace per line on both sides --
    // deliberately weaker than the byte-exact CRLF check above.
    assert.equal(
      sliceNoCR.split('\n').map(normLine).join('\n'),
      b.token.raw.replace(/\s+$/, '').split('\n').map(normLine).join('\n'),
      `block ${b.id} (${b.type}) at lines ${b.startLine}-${b.endLine}`
    );
  }
}

test('round-trip: sliceLines reproduces the raw text of every block across a mixed fixture (LF)', () => {
  assertRoundTrip(MIXED_FIXTURE_LF, false);
});

test('round-trip: sliceLines reproduces the raw text of every block across a mixed fixture (CRLF)', () => {
  assertRoundTrip(MIXED_FIXTURE_LF.replace(/\n/g, '\r\n'), true);
});

test('CRLF regression: heading, multi-line paragraph, and trailing content anchor correctly on \\r\\n source', () => {
  // marked strips \r from token.raw, so an anchoring scheme that searches for
  // raw as a literal substring of the (CRLF) source can never find a multi-line
  // token. Line-based matching (with \r normalized only for comparison) must
  // still land on the right lines and sliceLines must still return the source
  // with \r intact.
  const md = '# H\r\n\r\npara line one\r\npara line two\r\n\r\n## Sec\r\n\r\ntail\r\n';
  const { blocks } = parseDocument(md);
  assert.equal(blocks.length, 4);
  const [h1, para, h2, tail] = blocks;
  assert.deepEqual([h1.type, h1.startLine, h1.endLine], ['heading', 1, 1]);
  assert.deepEqual([para.type, para.startLine, para.endLine], ['paragraph', 3, 4]);
  assert.deepEqual([h2.type, h2.startLine, h2.endLine], ['heading', 6, 6]);
  assert.deepEqual([tail.type, tail.startLine, tail.endLine], ['paragraph', 8, 8]);
  // sliceLines only splits on \n (by design, unchanged), so the slice's last
  // line keeps its own trailing \r -- still a byte-exact contiguous substring
  // of the source, just including that line's CR terminator.
  assert.equal(sliceLines(md, para.startLine, para.endLine), 'para line one\r\npara line two\r');
});

test('CRLF fenced code block with \\r\\n line endings stays one block; content after it anchors past it', () => {
  const md = '# H\r\n\r\n```js\r\nx\r\n```\r\n\r\ntail\r\n';
  const { blocks } = parseDocument(md);
  const code = blocks.find((b) => b.type === 'code');
  assert.deepEqual([code.startLine, code.endLine], [3, 5]);
  const tail = blocks.find((b) => b.type === 'paragraph');
  assert.deepEqual([tail.startLine, tail.endLine], [7, 7]);
});

test('adversarial: a dropped definition whose title contains the next heading text does not steal its anchor', () => {
  // The second `[foo]:` def duplicates the label of the first, so marked drops it
  // from the token stream -- but its title text "## Hello" is still sitting in the
  // source, two lines above the real "## Hello" heading. A substring/indexOf search
  // matches the bait inside that dropped line; whole-line matching must not.
  const md = '# T\n\n[foo]: /a "x"\n\n[foo]: /b "## Hello"\n\n## Hello\n\nBody.\n';
  const { blocks } = parseDocument(md);
  const heading = blocks.find((b) => b.type === 'heading' && b.token.text === 'Hello');
  assert.deepEqual([heading.startLine, heading.endLine], [7, 7]);
  assert.equal(sliceLines(md, heading.startLine, heading.endLine), '## Hello');
});

test('trailing whitespace: heading line is anchored to itself, not the following blank line (regression)', () => {
  // C1: this module's own `.replace(/\s+$/, '')` trim strips the raw's trailing
  // space, but the old per-line comparison normalized only `\r`, not trailing
  // spaces -- so source "## H " never matched trimmed raw "## H", the forward
  // search exhausted every candidate, and the block fell into the `at < 0`
  // fallback, reporting the blank line before it with an empty slice.
  const md = '# First\n\n## H \n\npara\n';
  const { blocks } = parseDocument(md);
  const heading = blocks[1];
  assert.equal(heading.type, 'heading');
  assert.deepEqual([heading.startLine, heading.endLine], [3, 3]);
  assert.equal(sliceLines(md, heading.startLine, heading.endLine), '## H ');
});

test('trailing whitespace: paragraph line is anchored to itself, not the following blank line (regression)', () => {
  const md = '# H\n\npara \n\n## Next\n';
  const { blocks } = parseDocument(md);
  const para = blocks[1];
  assert.equal(para.type, 'paragraph');
  assert.deepEqual([para.startLine, para.endLine], [3, 3]);
  assert.equal(sliceLines(md, para.startLine, para.endLine), 'para ');
});

test('trailing whitespace: list keeps its last item, not truncated to just the first (regression)', () => {
  // marked itself already strips the trailing spaces from a list item's raw
  // (source "- item b  " -> raw "- item b"), so even deleting this module's
  // own trim would not close the gap -- the per-line comparison itself must
  // tolerate the difference.
  const md = '# First\n\n- item a\n- item b  \n\n## Next\n';
  const { blocks } = parseDocument(md);
  const list = blocks[1];
  assert.equal(list.type, 'list');
  assert.deepEqual([list.startLine, list.endLine], [3, 4]);
  assert.equal(sliceLines(md, list.startLine, list.endLine), '- item a\n- item b  ');
});

test('trailing whitespace: blockquote line is anchored to itself, not the following blank line (regression)', () => {
  const md = '# First\n\n> quoted line  \n\n## Next\n';
  const { blocks } = parseDocument(md);
  const bq = blocks[1];
  assert.equal(bq.type, 'blockquote');
  assert.deepEqual([bq.startLine, bq.endLine], [3, 3]);
  assert.equal(sliceLines(md, bq.startLine, bq.endLine), '> quoted line  ');
});

test('trailing whitespace: table keeps its last row, not truncated (regression)', () => {
  const md = '# First\n\n| A | B |\n|---|---|\n| 1 | 2 |  \n\n## Next\n';
  const { blocks } = parseDocument(md);
  const table = blocks[1];
  assert.equal(table.type, 'table');
  assert.deepEqual([table.startLine, table.endLine], [3, 5]);
  assert.equal(sliceLines(md, table.startLine, table.endLine), '| A | B |\n|---|---|\n| 1 | 2 |  ');
});

test('trailing whitespace + CRLF: paragraph anchors correctly on \\r\\n source (regression)', () => {
  const md = '# H\r\n\r\npara \r\n\r\n## Next\r\n';
  const { blocks } = parseDocument(md);
  const para = blocks[1];
  assert.equal(para.type, 'paragraph');
  assert.deepEqual([para.startLine, para.endLine], [3, 3]);
  assert.equal(sliceLines(md, para.startLine, para.endLine), 'para \r');
});

test('hard line break: two trailing spaces mid-paragraph are preserved byte-exactly, not mistaken for anchor-breaking trailing whitespace', () => {
  const md = 'line one  \nline two';
  const { blocks } = parseDocument(md);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'paragraph');
  assert.deepEqual([blocks[0].startLine, blocks[0].endLine], [1, 2]);
  assert.equal(sliceLines(md, blocks[0].startLine, blocks[0].endLine), 'line one  \nline two');
});
