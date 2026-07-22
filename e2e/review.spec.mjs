// E2E for the review UI, automating the core of SKILL.md's manual acceptance
// checklist. Each test gets its own temp doc + real server (see helpers.mjs).
import { test as base, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { startReview, waitForFile, waitForExit, FIXTURE_MD } from './helpers.mjs';

const test = base.extend({
  review: async ({}, use) => {
    const r = await startReview();
    await use(r);
    r.stop();
  },
});

async function addBlockAnnotation(page, blockText, comment) {
  const block = page.locator('#content .block', { hasText: blockText }).first();
  await block.hover();
  await block.locator('.handle-block').click({ force: true });
  await expect(page.locator('#popover')).toBeVisible();
  await page.locator('#popover-text').fill(comment);
  await page.locator('#popover-save').click();
}

test.describe('rendering', () => {
  test('renders all block types; Raw/Render switch works; TOC jumps', async ({ page, review }) => {
    await page.goto(review.url);
    // default mode is Render
    await expect(page.locator('body')).toHaveAttribute('data-mode', 'render');
    await expect(page.locator('#content .block[data-type="heading"]').first()).toContainText('Alpha');
    await expect(page.locator('#content table')).toBeVisible();
    await expect(page.locator('#content input[type="checkbox"]')).toHaveCount(0); // plain list, no tasklist in fixture
    await expect(page.locator('#content pre code.language-js')).toBeVisible();
    await expect(page.locator('#content .mermaid svg')).toBeVisible({ timeout: 10_000 }); // async render
    await expect(page.locator('#content .katex').first()).toBeVisible();

    // Raw shows numbered source lines
    await page.locator('[data-mode-btn="raw"]').click();
    await expect(page.locator('body')).toHaveAttribute('data-mode', 'raw');
    await expect(page.locator('.raw-line[data-line="1"]')).toContainText('Intro line before any heading.');

    // TOC lists headings and jumping targets the block in Render mode
    await page.locator('[data-mode-btn="render"]').click();
    const toc = page.locator('#toc');
    await expect(toc).toContainText('Alpha');
    await expect(toc).toContainText('Gamma');
    await toc.getByText('Gamma').click();
    await expect(page.locator('#content .block', { hasText: 'Tail paragraph.' })).toBeInViewport();
  });

  test('a broken mermaid block does not break the rest of the page', async ({ page }) => {
    const r = await startReview({
      doc: '# T\n\nok paragraph before\n\n```mermaid\ngraph TD; A--> ;;;bad\n```\n\nok paragraph after\n',
    });
    try {
      await page.goto(r.url);
      await expect(page.locator('#content .block', { hasText: 'ok paragraph before' })).toBeVisible();
      await expect(page.locator('#content .block', { hasText: 'ok paragraph after' })).toBeVisible();
    } finally {
      r.stop();
    }
  });
});

test.describe('annotations', () => {
  test('block annotation: add → rail card, edit, delete', async ({ page, review }) => {
    await page.goto(review.url);
    await addBlockAnnotation(page, 'First paragraph with', 'tighten this');
    const card = page.locator('.rail-card');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('tighten this');
    await expect(page.locator('#btn-submit')).toHaveText('Submit (1)');

    await card.getByRole('button', { name: 'Edit' }).click({ force: true });
    await page.locator('#popover-text').fill('tighten this a lot');
    await page.locator('#popover-save').click();
    await expect(card).toContainText('tighten this a lot');

    await card.getByRole('button', { name: 'Delete' }).click({ force: true });
    await expect(page.locator('.rail-card')).toHaveCount(0);
    await expect(page.locator('#btn-submit')).toHaveText('Submit (0)');
  });

  test('raw mode: double-click a source line annotates exactly that line', async ({ page, review }) => {
    await page.goto(review.url);
    await page.locator('[data-mode-btn="raw"]').click();
    await page.locator('.raw-line[data-line="5"]').dblclick(); // "First paragraph with **bold** text and `code`."
    await expect(page.locator('#popover')).toBeVisible();
    await expect(page.locator('#popover-target')).toContainText('[line]');
    await expect(page.locator('#popover-target')).toContainText('L5-L5');
    await page.locator('#popover-text').fill('line note');
    await page.locator('#popover-save').click();
    await expect(page.locator('.rail-card')).toContainText('line note');
  });

  test('selection annotation via triple-click; highlight marks only the selection', async ({ page, review }) => {
    await page.goto(review.url);
    const para = page.locator('#content .block p', { hasText: 'First paragraph with' });
    await para.click({ clickCount: 3 }); // select the whole paragraph
    const selBtn = page.locator('#selection-btn');
    await expect(selBtn).toBeVisible();
    await selBtn.click();
    await page.locator('#popover-text').fill('selection note');
    await page.locator('#popover-save').click();
    await expect(page.locator('#content mark.ann-mark').first()).toBeVisible();
    await expect(page.locator('.rail-card')).toContainText('selection note');
  });

  test('overall comment and hide/show annotations', async ({ page, review }) => {
    await page.goto(review.url);
    await page.locator('#btn-global').click();
    await page.locator('#popover-text').fill('overall: looks good');
    await page.locator('#popover-save').click();
    await expect(page.locator('#btn-submit')).toBeEnabled();

    await addBlockAnnotation(page, 'Tail paragraph', 'note');
    await page.locator('#btn-hl-toggle').click();
    await expect(page.locator('body')).toHaveClass(/ann-hidden/);
    await expect(page.locator('#btn-hl-toggle')).toHaveText('Show annotations');
    await page.locator('#btn-hl-toggle').click();
    await expect(page.locator('body')).not.toHaveClass(/ann-hidden/);
  });
});

test.describe('submit → agent protocol', () => {
  test('submit writes submission-1.json with the byte-exact contract; cards lock', async ({ page, review }) => {
    await page.goto(review.url);
    // annotate the intro (before the first heading) to pin the DOC_START contract
    await addBlockAnnotation(page, 'Intro line before any heading.', 'clarify the intro');
    await page.locator('#btn-submit').click();

    const sub = await waitForFile(path.join(review.stateDir, 'submission-1.json'));
    expect(sub.type).toBe('submission');
    expect(sub.seq).toBe(1);
    expect(sub.annotations).toHaveLength(1);
    const a = sub.annotations[0];
    expect(a.scope).toBe('block');
    expect(a.comment).toBe('clarify the intro');
    expect(a.quotedSource).toBe('Intro line before any heading.'); // byte-exact source slice
    expect(a.sectionPath).toBe('(document start)'); // language-neutral DOC_START
    // client-only anchoring fields must be stripped
    for (const k of ['blockId', 'selBlockIds', 'selStart', 'selEnd', 'origin', 'submitted']) {
      expect(a).not.toHaveProperty(k);
    }

    // the submitted card locks in place instead of clearing
    await expect(page.locator('.rail-card.submitted')).toHaveCount(1);
    await expect(page.locator('.rail-card .rail-submitted')).toHaveText('Submitted');
    await expect(page.locator('#banner')).toBeVisible();
    await expect(page.locator('#btn-submit')).toBeDisabled();
  });

  test('an outcome + edit consumes the submitted batch, refreshes, and archives to history', async ({ page, review }) => {
    await page.goto(review.url);
    await addBlockAnnotation(page, 'Tail paragraph', 'expand this');
    await page.locator('#btn-submit').click();
    const sub = await waitForFile(path.join(review.stateDir, 'submission-1.json'));
    const annId = sub.annotations[0].id;

    // the "agent" writes the outcome atomically, then applies the edit
    const outcome = JSON.stringify({ type: 'outcome', seq: 1, results: [{ id: annId, status: 'applied', note: 'expanded' }] });
    fs.writeFileSync(path.join(review.stateDir, 'outcome-1.json.tmp'), outcome);
    fs.renameSync(path.join(review.stateDir, 'outcome-1.json.tmp'), path.join(review.stateDir, 'outcome-1.json'));
    fs.writeFileSync(review.mdPath, FIXTURE_MD.replace('Tail paragraph.', 'Tail paragraph, expanded by the agent.'));

    await expect(page.locator('#content')).toContainText('expanded by the agent', { timeout: 10_000 });
    await expect(page.locator('.rail-card')).toHaveCount(0); // active batch released
    await expect(page.locator('#history')).toBeVisible();
    await expect(page.locator('#history .history-card.status-applied')).toContainText('expand this');
    await expect(page.locator('#content .block.changed')).toHaveCount(1);
    await expect(page.locator('#content .block.changed')).toContainText('expanded by the agent');
  });

  test('End review confirms, writes done.json, and the server exits', async ({ page, review }) => {
    await page.goto(review.url);
    page.on('dialog', (d) => d.accept());
    await page.locator('#btn-done').click();
    const done = await waitForFile(path.join(review.stateDir, 'done.json'));
    expect(done.type).toBe('done');
    const code = await waitForExit(review.proc);
    expect(code).toBe(0);
  });
});

test.describe('live reload safety', () => {
  test('a file change with no pending drafts refreshes automatically', async ({ page, review }) => {
    await page.goto(review.url);
    fs.writeFileSync(review.mdPath, FIXTURE_MD.replace('Intro line', 'Rewritten intro line'));
    await expect(page.locator('#content')).toContainText('Rewritten intro line', { timeout: 10_000 });
    // the changed block is flagged in Render, and its source line in Raw
    await expect(page.locator('#content .block.changed')).toHaveCount(1);
    await page.locator('[data-mode-btn="raw"]').click();
    await expect(page.locator('.raw-line.changed')).toHaveCount(1);
    await expect(page.locator('.raw-line.changed')).toContainText('Rewritten intro line');
  });

  test('a file change with pending drafts shows a confirm banner instead of refreshing', async ({ page, review }) => {
    await page.goto(review.url);
    await addBlockAnnotation(page, 'First paragraph with', 'draft in progress');
    fs.writeFileSync(review.mdPath, FIXTURE_MD.replace('Intro line', 'Changed intro line'));
    await expect(page.locator('#banner')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#banner')).toContainText('The document changed.');
    // not auto-refreshed: old text still on screen, draft card intact
    await expect(page.locator('#content')).toContainText('Intro line before any heading.');
    await expect(page.locator('.rail-card')).toHaveCount(1);
  });
});

test.describe('i18n', () => {
  test('language switch relabels the UI at runtime and persists across reload', async ({ page, review }) => {
    await page.goto(review.url);
    await expect(page.locator('#btn-done')).toHaveText('End review'); // default EN under en-US
    await page.locator('#lang-select').selectOption('zh');
    await expect(page.locator('#btn-done')).toHaveText('结束 Review');
    await expect(page.locator('#btn-global')).toHaveText('整体意见');
    await expect(page.locator('#btn-submit')).toHaveText('提交批注 (0)');
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');

    await page.reload();
    await expect(page.locator('#btn-done')).toHaveText('结束 Review'); // remembered via localStorage
  });
});

test.describe('review history', () => {
  test('the history panel is hidden until a round settles', async ({ page, review }) => {
    await page.goto(review.url);
    await expect(page.locator('#history')).toBeHidden();
    await addBlockAnnotation(page, 'First paragraph with', 'still in flight');
    await page.locator('#btn-submit').click();
    await waitForFile(path.join(review.stateDir, 'submission-1.json'));
    await expect(page.locator('#history')).toBeHidden(); // in-flight rounds do not count
  });

  test('an all-skip round unlocks via outcome (no doc change) and shows a no-change banner', async ({ page, review }) => {
    await page.goto(review.url);
    await addBlockAnnotation(page, 'First paragraph with', 'please rephrase');
    await page.locator('#btn-submit').click();
    const sub = await waitForFile(path.join(review.stateDir, 'submission-1.json'));
    const annId = sub.annotations[0].id;

    // agent skips it: writes an outcome, does NOT touch the doc
    const outcome = JSON.stringify({ type: 'outcome', seq: 1, results: [{ id: annId, status: 'skipped', note: 'anchor ambiguous' }] });
    fs.writeFileSync(path.join(review.stateDir, 'outcome-1.json.tmp'), outcome);
    fs.renameSync(path.join(review.stateDir, 'outcome-1.json.tmp'), path.join(review.stateDir, 'outcome-1.json'));

    // unlocked without any doc-changed event
    await expect(page.locator('.rail-card')).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator('#banner')).toContainText('no changes to the document');
    await expect(page.locator('#history .history-card.status-skipped')).toContainText('please rephrase');
    await expect(page.locator('#history .history-card.status-skipped')).toContainText('anchor ambiguous');
  });

  test('multiple in-flight batches: the first outcome releases only its own seq', async ({ page, review }) => {
    await page.goto(review.url);
    await addBlockAnnotation(page, 'First paragraph with', 'note one');
    await page.locator('#btn-submit').click();
    const sub1 = await waitForFile(path.join(review.stateDir, 'submission-1.json'));
    await addBlockAnnotation(page, 'Tail paragraph', 'note two');
    await page.locator('#btn-submit').click();
    await waitForFile(path.join(review.stateDir, 'submission-2.json'));
    await expect(page.locator('.rail-card.submitted')).toHaveCount(2);

    const id1 = sub1.annotations[0].id;
    const o1 = JSON.stringify({ type: 'outcome', seq: 1, results: [{ id: id1, status: 'applied', note: 'ok' }] });
    fs.writeFileSync(path.join(review.stateDir, 'outcome-1.json.tmp'), o1);
    fs.renameSync(path.join(review.stateDir, 'outcome-1.json.tmp'), path.join(review.stateDir, 'outcome-1.json'));

    await expect(page.locator('.rail-card.submitted')).toHaveCount(1, { timeout: 10_000 });
    await expect(page.locator('#history .history-card.status-applied')).toContainText('note one');
  });

  test('a round whose doc advanced without an outcome is released and marked processed', async ({ page, review }) => {
    await page.goto(review.url);
    await addBlockAnnotation(page, 'Tail paragraph', 'old-protocol agent');
    await page.locator('#btn-submit').click();
    await waitForFile(path.join(review.stateDir, 'submission-1.json'));

    // "old" agent: edits the doc, never writes an outcome
    fs.writeFileSync(review.mdPath, FIXTURE_MD.replace('Tail paragraph.', 'Tail paragraph, edited without an outcome.'));

    await expect(page.locator('#content')).toContainText('edited without an outcome', { timeout: 10_000 });
    await expect(page.locator('.rail-card')).toHaveCount(0); // released by reconciliation, never stuck
    await expect(page.locator('#history .history-round-tag')).toContainText('no outcome recorded');
  });

  test('history survives a page reload (rebuilt from /api/history)', async ({ page, review }) => {
    await page.goto(review.url);
    await addBlockAnnotation(page, 'First paragraph with', 'keep me');
    await page.locator('#btn-submit').click();
    const sub = await waitForFile(path.join(review.stateDir, 'submission-1.json'));
    const annId = sub.annotations[0].id;
    const outcome = JSON.stringify({ type: 'outcome', seq: 1, results: [{ id: annId, status: 'applied', note: 'kept' }] });
    fs.writeFileSync(path.join(review.stateDir, 'outcome-1.json.tmp'), outcome);
    fs.renameSync(path.join(review.stateDir, 'outcome-1.json.tmp'), path.join(review.stateDir, 'outcome-1.json'));
    await expect(page.locator('#history .history-card.status-applied')).toContainText('keep me', { timeout: 10_000 });

    await page.reload();
    await expect(page.locator('#history .history-card.status-applied')).toContainText('keep me', { timeout: 10_000 });
  });
});
