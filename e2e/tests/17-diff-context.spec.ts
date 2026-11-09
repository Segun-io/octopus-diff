/**
 * Diff context controls (More context, Expand all / Collapse, whitespace) under rapid, repeated
 * clicks. Regression for two user reports:
 *
 * 1. "deletionLine and additionLine are null, something is wrong": while a new context loaded,
 *    the previous patch was rendered under the new view's highlight cache key, so the real patch
 *    then picked up highlighted lines of the shorter one.
 * 2. "Could not load this diff … expected number to be <= 1000000": Expand all set the context to
 *    the API maximum and More context kept adding to it.
 *
 * Diff responses for a non-default view are delayed so the placeholder (previous patch) is on
 * screen long enough for the highlighter to cache it, which made the first bug deterministic.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findWorktree } from '@octopus-diff/fixtures';
import type { Page } from '@playwright/test';
import { expect, sleep, test } from '../support/test.js';

const FILE = 'src/stable.ts';

/** Edits three spaced lines, so the default 3-line context shows several collapsed regions. */
function edited(original: string): string {
  const lines = original.split('\n');
  for (const index of [0, 9, Math.max(0, lines.length - 2)]) {
    lines[index] = `${lines[index]} // octopus-context-edit-${index}`;
  }
  return lines.join('\n');
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

async function delayViewChanges(page: Page): Promise<string[]> {
  const contexts: string[] = [];
  await page.route('**/api/worktrees/*/diff?*', async (route) => {
    const url = new URL(route.request().url());
    const context = url.searchParams.get('context');
    if (context !== null) contexts.push(context);
    if (context !== null || url.searchParams.get('ignoreWhitespace') === 'true') await sleep(250);
    await route.continue();
  });
  return contexts;
}

test.describe('diff context controls', () => {
  test('rapid More context and Expand all clicks never break the diff', async ({
    manifest,
    daemon,
    app,
    page,
    edits,
  }) => {
    const live = findWorktree(manifest, 'live').worktree;
    const path = join(live.path, FILE);
    await edits.write(path, edited(await readFile(path, 'utf8')));
    const errors = watchErrors(page);
    const contexts = await delayViewChanges(page);

    await app.open(daemon.authUrl);
    await app.selectWorktree(live.id);
    await app.openFile(FILE);
    await expect(app.diffViewer).toHaveAttribute('data-state', 'ready');

    const more = app.byTestId('diff-more-context');
    const expand = app.byTestId('diff-expand-all');
    for (let i = 0; i < 12; i++) await more.click({ force: true, noWaitAfter: true });
    for (let i = 0; i < 12; i++) await expand.click({ force: true, noWaitAfter: true });
    for (let i = 0; i < 6; i++) {
      await more.click({ force: true, noWaitAfter: true });
      await expand.click({ force: true, noWaitAfter: true });
      // Whitespace changes the patch too and goes through the same placeholder path.
      await app.press('w');
    }
    await app.waitDiffSettled();
    await sleep(800);

    await expect(app.diffViewer).toHaveAttribute('data-state', 'ready');
    await expect(app.placeholder('error')).toHaveCount(0);
    expect(errors.filter((e) => /something is wrong|context|invalid/i.test(e))).toEqual([]);
    // The context never goes past the API's maximum (1,000,000).
    for (const value of contexts) expect(Number(value)).toBeLessThanOrEqual(1_000_000);
    await app.expectDiffText('octopus-context-edit-9');
  });

  test('More context stops once the whole file is shown; Collapse goes back', async ({
    manifest,
    daemon,
    app,
    page,
    edits,
  }) => {
    const live = findWorktree(manifest, 'live').worktree;
    const path = join(live.path, FILE);
    await edits.write(path, edited(await readFile(path, 'utf8')));
    const errors = watchErrors(page);
    await delayViewChanges(page);

    await app.open(daemon.authUrl);
    await app.selectWorktree(live.id);
    await app.openFile(FILE);
    const more = app.byTestId('diff-more-context');
    const expand = app.byTestId('diff-expand-all');
    await expect(more).toBeEnabled();
    await expect(expand).toHaveText('Expand all');

    // The file has about 20 lines: one step of 20 shows all of it.
    await more.click();
    await expect(more).toBeDisabled();
    await expect(more).toHaveAttribute('title', /whole file/i);
    await expect(expand).toHaveText('Collapse');
    await expect(expand).toHaveAttribute('aria-pressed', 'true');

    // The keyboard shortcut does not grow the context either.
    const requests: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/diff?')) requests.push(r.url());
    });
    await app.press('e');
    await expect(app.byTestId('notice')).toContainText(/whole file/i);
    expect(requests).toEqual([]);

    await expand.click();
    await expect(expand).toHaveText('Expand all');
    await expect(more).toBeEnabled();
    await expect(app.diffViewer).toHaveAttribute('data-state', 'ready');

    // Whitespace toggled back and forth while the diff reloads.
    for (let i = 0; i < 6; i++) await app.press('w');
    await app.waitDiffSettled();
    await expect(app.diffViewer).toHaveAttribute('data-state', 'ready');
    expect(errors.filter((e) => /something is wrong/i.test(e))).toEqual([]);
  });
});
