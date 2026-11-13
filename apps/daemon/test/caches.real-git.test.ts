import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import type { GitCore } from '@octopus-diff/contracts';
import { createGitCore, GIT_CORE_IMPLEMENTED } from '@octopus-diff/git-core';
import { describe, expect, it } from 'vitest';
import { startDaemon } from '../src/daemon.js';
import { hashId } from '../src/ids.js';
import { client, eventually, onCleanup, sleep, TEST_TOKEN, tempDir } from './helpers.js';
import { makeRealGitFixture, makeRealRepo } from './real-git-fixture.js';

/**
 * The review range cache (#49): `readReviewRange` is asked once per (worktree, HEAD, bookmark)
 * while the bookmark is reachable, however often the worktree's files change, with a real git-core.
 */
describe.skipIf(!GIT_CORE_IMPLEMENTED)('review range cache (#49)', () => {
  async function setup() {
    const fx = await makeRealGitFixture();
    const repo = await makeRealRepo(fx, 'app', { 'a.txt': 'one\n' });
    const real = createGitCore({ env: fx.env });
    onCleanup(() => real.dispose());
    let ranges = 0;
    const git = new Proxy(real, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== 'readReviewRange' || typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          ranges += 1;
          return value.apply(target, args);
        };
      },
    }) as GitCore;
    const daemon = await startDaemon({
      host: '127.0.0.1',
      port: 0,
      token: TEST_TOKEN,
      stateDir: await tempDir(),
      logLevel: 'silent',
      gitCore: git,
      projects: [repo],
      watch: { debounceMs: 150 },
      internal: { forges: false },
    });
    onCleanup(() => daemon.close());
    const api = client(daemon);
    const worktreeId = hashId(repo);
    await api.listProjects();
    await appendFile(path.join(repo, 'a.txt'), 'edit 0\n');
    await api.setFocus({ worktreeId });
    const row = async () =>
      (await api.listProjects()).projects.flatMap((p) => p.worktrees)[0]?.summary;
    // The first review state, then the second one (the first sight moved the bookmark).
    await eventually(async () => (await row())?.review !== undefined, 8000);
    const settle = async () => {
      let last = -1;
      while (last !== ranges) {
        last = ranges;
        await sleep(400);
      }
    };
    await settle();
    return { fx, repo, daemon, api, worktreeId, row, settle, ranges: () => ranges };
  }

  it('is asked once for the same HEAD and bookmark however many edits', async () => {
    const s = await setup();
    await s.settle();
    const base = s.ranges();
    for (let i = 1; i <= 3; i++) {
      const before = (await s.row())?.stateHash;
      await appendFile(path.join(s.repo, 'a.txt'), `edit ${i}\n`);
      await eventually(async () => (await s.row())?.stateHash !== before, 8000);
      await s.settle();
    }
    expect(s.ranges()).toBe(base);
    expect(s.daemon.core.cacheStats().ranges.hits).toBeGreaterThan(0);
  });

  it('is asked again when HEAD moves, and when the bookmark moves', async () => {
    const s = await setup();
    const base = s.ranges();
    s.fx.git(s.repo, 'add', '-A');
    s.fx.git(s.repo, 'commit', '-q', '-m', 'second');
    await eventually(() => s.ranges() > base, 8000);
    await s.settle();
    const afterCommit = s.ranges();
    expect(afterCommit).toBeGreaterThan(base);
    // Move the bookmark (first sight put it on the first commit) to HEAD: same HEAD, new bookmark.
    const head = s.fx.git(s.repo, 'rev-parse', 'HEAD').trim();
    await s.daemon.core.moveBookmark(s.worktreeId, head);
    await s.api.listProjects();
    await s.settle();
    // `moveBookmark` reads one range itself; the review state it triggers reads another.
    expect(s.ranges() - afterCommit).toBeGreaterThanOrEqual(2);
  });
});
