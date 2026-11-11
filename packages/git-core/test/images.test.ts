import { unlinkSync } from 'node:fs';
import path from 'node:path';
import type { GitCore, WorktreeLocator } from '@octopus-diff/contracts';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGitCore } from '../src/index.js';
import { locator } from './helpers/core.js';
import { createFixture, type Fixture } from './helpers/fixture.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==',
  'base64',
);
const updated = Buffer.concat([png, Buffer.from('updated')]);
let fx: Fixture;
let core: GitCore;
let repo: string;
let wt: WorktreeLocator;
beforeEach(async () => {
  fx = createFixture();
  repo = fx.repo('images');
  fx.write(path.join(repo, 'screen.png'), png);
  fx.commitAll(repo, 'image');
  core = createGitCore(fx.coreOptions());
  wt = locator(repo);
});
afterEach(async () => {
  await core.dispose();
  fx.dispose();
});

it('compares HEAD, index and working content according to scope', async () => {
  fx.write(path.join(repo, 'screen.png'), updated);
  fx.git(repo, ['add', 'screen.png']);
  const working = Buffer.concat([updated, Buffer.from('working')]);
  fx.write(path.join(repo, 'screen.png'), working);
  for (const [kind, before, after] of [
    ['working', png, working],
    ['staged', png, updated],
    ['unstaged', updated, working],
  ] as const) {
    const diff = await core.getFileDiff(wt, { kind }, { path: 'screen.png' });
    expect(diff.images?.before?.base64).toBe(before.toString('base64'));
    expect(diff.images?.after?.base64).toBe(after.toString('base64'));
  }
});

it('shows added and deleted images without inventing the missing side', async () => {
  fx.write(path.join(repo, 'new.png'), updated);
  const added = await core.getFileDiff(wt, { kind: 'working' }, { path: 'new.png' });
  expect(added.images?.before).toBeNull();
  expect(added.images?.after?.base64).toBe(updated.toString('base64'));
  unlinkSync(path.join(repo, 'screen.png'));
  const removed = await core.getFileDiff(wt, { kind: 'working' }, { path: 'screen.png' });
  expect(removed.images?.after).toBeNull();
  expect(removed.images?.before?.base64).toBe(png.toString('base64'));
});

it('uses committed blobs for branch and commit scopes, including renames', async () => {
  fx.git(repo, ['checkout', '-b', 'docs']);
  fx.git(repo, ['mv', 'screen.png', 'renamed.png']);
  const sha = fx.commitAll(repo, 'rename');
  fx.write(path.join(repo, 'renamed.png'), updated);
  for (const scope of [
    { kind: 'branch', base: 'main' },
    { kind: 'commit', sha },
  ] as const) {
    const diff = await core.getFileDiff(wt, scope, { path: 'renamed.png' });
    expect(diff.images?.before?.base64).toBe(png.toString('base64'));
    expect(diff.images?.after?.base64).toBe(png.toString('base64'));
  }
});

it('does not embed disguised HTML or symlinks', async () => {
  fx.write(path.join(repo, 'fake.png'), Buffer.from('<html>\0</html>'));
  const fake = await core.getFileDiff(wt, { kind: 'working' }, { path: 'fake.png' });
  expect(fake.images).toBeUndefined();
  fx.symlink(path.join(repo, 'screen.png'), path.join(repo, 'link.png'));
  const link = await core.getFileDiff(wt, { kind: 'working' }, { path: 'link.png' });
  expect(link.images).toBeUndefined();
});

it('bounds image reads and keeps a useful message for oversized files', async () => {
  fx.write(path.join(repo, 'huge.png'), Buffer.concat([png, Buffer.alloc(10 * 1024 * 1024)]));
  const diff = await core.getFileDiff(wt, { kind: 'working' }, { path: 'huge.png' });
  expect(diff.images?.after).toBeNull();
  expect(diff.images?.warning).toContain('10 MiB');
});

it('previews untracked images even when attributes force a textual diff', async () => {
  fx.write(path.join(repo, '.gitattributes'), '*.png diff\n');
  fx.write(path.join(repo, 'new.png'), png);
  const diff = await core.getFileDiff(wt, { kind: 'working' }, { path: 'new.png' });
  expect(diff.binary).toBe(false);
  expect(diff.images?.after?.base64).toBe(png.toString('base64'));
});

it('previews selected images when untracked content inspection exceeds its cap', async () => {
  await core.dispose();
  core = createGitCore(fx.coreOptions({ maxUntrackedFiles: 1 }));
  fx.write(path.join(repo, 'new.png'), png);
  fx.write(path.join(repo, 'another.txt'), 'more files than the inspection budget');
  const diff = await core.getFileDiff(wt, { kind: 'working' }, { path: 'new.png' });
  expect(diff.images?.after?.base64).toBe(png.toString('base64'));
});
