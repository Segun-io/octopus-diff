/**
 * URL state (roadmap #50, DECISIONS #459): the selected worktree, file and scope are in the
 * address bar as query parameters. A reload restores them, Back / Forward move between
 * selections, a copied URL opens the same file, a stale one falls back to the landing flow, and
 * the daemon token (in the fragment) never ends up in a path or query.
 */
import { TEST_IDS } from '@octopus-diff/contracts';
import { dirtyCheckouts, expect, test } from '../support/test.js';

/** A fresh page on `/?<query>` with the token fragment of `authUrl`. */
function deepLink(authUrl: string, query: string): string {
  const url = new URL(authUrl);
  return `${url.origin}/?${query}${url.hash}`;
}

test.describe('URL state (#50)', () => {
  test('a reload restores the worktree, file and scope', async ({
    manifest,
    daemon,
    app,
    page,
  }) => {
    // Two dirty worktrees; the second one is not the landing one.
    const [first, second] = dirtyCheckouts(manifest)
      .filter(({ worktree }) => (worktree.scopes.working ?? []).length >= 1)
      .map(({ worktree }) => worktree);
    expect(first && second, 'two dirty worktrees in the fixtures').toBeTruthy();
    await app.open(daemon.authUrl);
    await app.expectLanded();
    // Pick a worktree that is not the landing one, with a file.
    const target = (await app.currentWorktreeId()) === second?.id ? first : second;
    if (!target) throw new Error('no target worktree');
    await app.selectWorktree(target.id);
    const path = (target.scopes.working ?? [])[0]?.path ?? '';
    await app.openFile(path, target.id);
    await app.setScope('working');
    await expect.poll(() => new URL(page.url()).searchParams.get('worktree')).toBe(target.id);
    const params = new URL(page.url()).searchParams;
    expect(params.get('file')).toBe(path);
    expect(params.get('scope')).toBe('working');
    // The token fragment was stripped and is nowhere in the address.
    expect(page.url()).not.toContain('token');

    await page.reload();
    await app.waitReady();
    expect(await app.currentWorktreeId()).toBe(target.id);
    await expect(app.diffViewer).toHaveAttribute('data-path', path);
    await expect(app.byTestId(TEST_IDS.scopeSelect)).toHaveAttribute('data-scope', /^working/);
    expect(new URL(page.url()).searchParams.get('worktree')).toBe(target.id);
  });

  test('Back and Forward move between selections', async ({ manifest, daemon, app, page }) => {
    const [a, b] = dirtyCheckouts(manifest).map(({ worktree }) => worktree);
    if (!a || !b) throw new Error('two dirty worktrees expected');
    await app.open(daemon.authUrl);
    await app.expectLanded();
    await app.selectWorktree(a.id);
    await expect.poll(() => new URL(page.url()).searchParams.get('worktree')).toBe(a.id);
    await app.selectWorktree(b.id);
    await expect.poll(() => new URL(page.url()).searchParams.get('worktree')).toBe(b.id);
    await page.goBack();
    await expect.poll(() => app.currentWorktreeId()).toBe(a.id);
    expect(new URL(page.url()).searchParams.get('worktree')).toBe(a.id);
    await page.goForward();
    await expect.poll(() => app.currentWorktreeId()).toBe(b.id);
    expect(new URL(page.url()).searchParams.get('worktree')).toBe(b.id);
  });

  test('a copied URL opens the same worktree and file; the token stays out of requests and the address', async ({
    manifest,
    daemon,
    app,
    page,
  }) => {
    const target = dirtyCheckouts(manifest)
      .map(({ worktree }) => worktree)
      .find((w) => (w.scopes.working ?? []).length >= 2);
    if (!target) throw new Error('a dirty worktree with two files expected');
    const file = (target.scopes.working ?? [])[1]?.path ?? '';
    const token = new URL(daemon.authUrl).hash.replace('#token=', '');
    expect(token.length).toBeGreaterThan(10);
    const requested: string[] = [];
    page.on('request', (r) => requested.push(r.url()));
    await page.addInitScript(() => {
      localStorage.setItem(
        'octopus-diff:prefs',
        JSON.stringify({ version: 2, settledOpen: true, defaultScope: 'working' }),
      );
    });
    await page.goto(
      deepLink(
        daemon.authUrl,
        `worktree=${target.id}&file=${encodeURIComponent(file)}&scope=working`,
      ),
    );
    await app.waitReady();
    expect(await app.currentWorktreeId()).toBe(target.id);
    await expect(app.diffViewer).toHaveAttribute('data-path', file);
    await expect(app.fileItem(file, target.id)).toHaveAttribute('aria-selected', 'true');
    // The token is in no URL the page requested or shows, and not in history.
    expect(page.url()).not.toContain(token);
    expect(requested.filter((u) => u.includes(token))).toEqual([]);
    expect(await page.evaluate(() => window.location.hash)).toBe('');
    expect(await page.evaluate((t) => JSON.stringify(history.state ?? {}).includes(t), token)).toBe(
      false,
    );
  });

  test('a stale or invalid URL falls back to the landing flow', async ({ daemon, app, page }) => {
    await page.goto(deepLink(daemon.authUrl, 'worktree=0000000000000000&file=nope.ts&scope=bogus'));
    await app.waitReady();
    const landed = await app.expectLanded();
    await expect(app.byTestId(TEST_IDS.errorBanner)).toHaveCount(0);
    await expect.poll(() => new URL(page.url()).searchParams.get('worktree')).toBe(landed);
    // The stale entry was replaced, not kept: only the blank page and this one are in history.
    expect(await page.evaluate(() => history.length)).toBeLessThanOrEqual(2);
    expect(new URL(page.url()).searchParams.get('file')).not.toBe('nope.ts');
  });
});
