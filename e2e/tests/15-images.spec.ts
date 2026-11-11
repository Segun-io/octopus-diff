import { unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findWorktree } from '@octopus-diff/fixtures';
import { expect, test } from '../support/test.js';

test('documentation PNGs render through the authenticated diff API', async ({
  manifest,
  daemon,
  app,
  page,
}) => {
  const live = findWorktree(manifest, 'live').worktree;
  const name = 'documentation-preview.png';
  const file = join(live.path, name);
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==',
    'base64',
  );
  try {
    await writeFile(file, png);
    await daemon.client.refreshWorktree(live.id);
    const { diff } = await daemon.client.getDiff(live.id, {
      scope: { kind: 'working' },
      path: name,
    });
    expect(diff.images?.after?.base64).toBe(png.toString('base64'));
    await app.open(daemon.authUrl);
    await app.selectWorktree(live.id);
    await app.setScope('working');
    await app.openFile(name);
    const image = page.getByRole('img', { name: 'After', exact: true });
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(1);
    await expect(page.getByText('No previous image')).toBeVisible();
  } finally {
    await unlink(file).catch(() => {});
  }
});
