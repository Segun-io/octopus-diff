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

test('identical translucent pixels are black in difference mode', async ({
  manifest,
  daemon,
  app,
  page,
}) => {
  const live = findWorktree(manifest, 'live').worktree;
  const name = 'transparent-preview.png';
  const file = join(live.path, name);
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 12;
    canvas.height = 12;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is unavailable');
    context.fillStyle = 'rgba(255, 255, 255, 0.5)';
    context.fillRect(0, 0, 12, 12);
    return canvas.toDataURL('image/png').split(',')[1] as string;
  });
  try {
    await writeFile(file, Buffer.from(base64, 'base64'));
    await daemon.client.refreshWorktree(live.id);
    // Supply the same translucent raster on both sides to isolate browser compositing.
    await page.route('**/api/worktrees/*/diff?*', async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      if (json.diff?.path === name && json.diff.images?.after) {
        json.diff.images.before = json.diff.images.after;
      }
      await route.fulfill({ response, json });
    });
    await app.open(daemon.authUrl);
    await app.selectWorktree(live.id);
    await app.setScope('working');
    await app.openFile(name);
    await page.getByRole('combobox', { name: 'Image comparison' }).selectOption('difference');
    const after = page.getByRole('img', { name: 'After', exact: true });
    await expect.poll(() => after.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(12);
    const screenshot = await after.locator('..').locator('..').screenshot();
    const pixels = await page.evaluate(async (encoded) => {
      const image = new Image();
      image.src = `data:image/png;base64,${encoded}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas is unavailable');
      context.drawImage(image, 0, 0);
      return Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data);
    }, screenshot.toString('base64'));
    expect(pixels.length).toBe(12 * 12 * 4);
    for (let offset = 0; offset < pixels.length; offset += 4) {
      expect(pixels.slice(offset, offset + 4)).toEqual([0, 0, 0, 255]);
    }
  } finally {
    await unlink(file).catch(() => {});
  }
});

test('difference mode marks areas added by image resizing', async ({
  manifest,
  daemon,
  app,
  page,
}) => {
  const live = findWorktree(manifest, 'live').worktree;
  const name = 'resized-preview.png';
  const file = join(live.path, name);
  const [before, after] = await page.evaluate(() => {
    const png = (size: number) => {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas is unavailable');
      context.fillStyle = 'white';
      context.fillRect(0, 0, size, size);
      return canvas.toDataURL('image/png').split(',')[1] as string;
    };
    return [png(12), png(24)];
  });
  try {
    await writeFile(file, Buffer.from(after, 'base64'));
    await daemon.client.refreshWorktree(live.id);
    await page.route('**/api/worktrees/*/diff?*', async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      if (json.diff?.path === name && json.diff.images?.after) {
        json.diff.images.before = {
          ...json.diff.images.after,
          base64: before,
          byteLength: Buffer.from(before, 'base64').length,
        };
      }
      await route.fulfill({ response, json });
    });
    await app.open(daemon.authUrl);
    await app.selectWorktree(live.id);
    await app.setScope('working');
    await app.openFile(name);
    await page.getByRole('combobox', { name: 'Image comparison' }).selectOption('difference');
    const afterImage = page.getByRole('img', { name: 'After', exact: true });
    await expect
      .poll(() => afterImage.evaluate((node: HTMLImageElement) => node.naturalWidth))
      .toBe(24);
    const screenshot = await afterImage.locator('..').locator('..').screenshot();
    const pixels = await page.evaluate(async (encoded) => {
      const image = new Image();
      image.src = `data:image/png;base64,${encoded}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas is unavailable');
      context.drawImage(image, 0, 0);
      return {
        width: canvas.width,
        data: context.getImageData(0, 0, canvas.width, canvas.height).data,
      };
    }, screenshot.toString('base64'));
    const pixel = (x: number, y: number) => {
      const offset = (y * pixels.width + x) * 4;
      return [...pixels.data.slice(offset, offset + 4)];
    };
    expect(pixel(5, 5)).toEqual([0, 0, 0, 255]);
    expect(pixel(20, 20)).not.toEqual([0, 0, 0, 255]);
  } finally {
    await unlink(file).catch(() => {});
  }
});
