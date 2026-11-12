/**
 * #41 through the real daemon: opening one file's diff (`GET /diff`) in a worktree the daemon keeps a
 * summary for costs one git process (a tracked file) or none (an untracked one) instead of the
 * whole-repository `status` and `diff --raw` plus the patch, and the answer is what the whole-scope
 * route gives, with the `patchHash` the file list carries (reviewed marks are keyed by it).
 * Spawns are counted by pointing git-core at a wrapper script that logs its argv.
 */
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DiffResponse } from '@octopus-diff/contracts';
import { createGitCore, foldsCase } from '@octopus-diff/git-core';
import { describe, expect, it } from 'vitest';
import { type DaemonInternals, startDaemon } from '../src/daemon.js';
import { hashId } from '../src/ids.js';
import { client, onCleanup, sleep, TEST_TOKEN, tempDir } from './helpers.js';
import { makeRealGitFixture, makeRealRepo, type RealGitFixture } from './real-git-fixture.js';

const FOLDS = await (async () => {
  const dir = await tempDir('octopus-diff-fold-');
  await mkdir(path.join(dir, '.git'));
  return foldsCase(dir);
})();

/**
 * Index of the git subcommand in a logged argv: the first word after the global options, skipping
 * `-c <key=value>` pairs and every other option (the shared rule of the other real-git tests). Never
 * the first word that merely lacks a dash or an equals sign.
 */
function subcommandAt(argv: string[]): number {
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i] as string;
    if (word === '-c' || word === '-C') i++;
    else if (!word.startsWith('-')) return i;
  }
  return argv.length;
}

async function startCounting(fx: RealGitFixture, internal: DaemonInternals = {}) {
  const log = path.join(await tempDir(), 'spawns.log');
  writeFileSync(log, '');
  const wrapper = path.join(path.dirname(log), 'git-wrapper.sh');
  writeFileSync(
    wrapper,
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\001' "$a"; done >> '${log}'\necho >> '${log}'\nexec git "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
  const incremental = internal.incremental !== false;
  const daemon = await startDaemon({
    host: '127.0.0.1',
    port: 0,
    token: TEST_TOKEN,
    stateDir: await tempDir(),
    logLevel: 'silent',
    gitCore: createGitCore({ env: fx.env, gitBinary: wrapper, incremental }),
    watch: { debounceMs: 100, enabled: true },
    internal,
  });
  onCleanup(() => daemon.close());
  const spawns = (): string[][] =>
    readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\u0001').filter(Boolean))
      .map((argv) => argv.slice(subcommandAt(argv)))
      .filter((argv) => argv[0] !== 'config');
  return { daemon, spawns };
}

async function quiet(spawns: () => unknown[], quietMs = 400): Promise<void> {
  let last = spawns().length;
  let since = Date.now();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await sleep(50);
    const now = spawns().length;
    if (now !== last) {
      last = now;
      since = Date.now();
    } else if (Date.now() - since >= quietMs) return;
  }
  throw new Error('git never went quiet');
}

async function setup() {
  const fx = await makeRealGitFixture();
  const files: Record<string, string> = { 'a.txt': 'one\ntwo\n', 'b.txt': 'b\n', 'c d.txt': 'c\n' };
  for (let i = 0; i < 40; i++) files[`f${i}.txt`] = `file ${i}\n`;
  const repo = await makeRealRepo(fx, 'repo', files);
  await appendFile(path.join(repo, 'b.txt'), 'dirty\n');
  await appendFile(path.join(repo, 'a.txt'), 'dirty too\n');
  await writeFile(path.join(repo, 'new.txt'), 'untracked\n');
  return { fx, repo, repoId: hashId(repo) };
}

/** The diff the whole-scope route gives (a git-core with no summary route). */
async function wanted(fx: RealGitFixture, repo: string, file: string) {
  const core = createGitCore({ env: fx.env, incremental: false });
  try {
    return await core.getFileDiff(
      { projectId: 'p', worktreeId: 'w', path: repo },
      { kind: 'working' },
      { path: file },
    );
  } finally {
    await core.dispose();
  }
}

const withoutReview = (response: DiffResponse) => {
  const { reviewed: _reviewed, ...diff } = response.diff;
  return diff;
};

describe('GET /diff from the summary state (#41)', () => {
  it('a tracked file costs one git process, an untracked file none; answers as the whole route', async () => {
    const s = await setup();
    const { daemon, spawns } = await startCounting(s.fx);
    const api = client(daemon);
    await api.addProject({ path: s.repo });
    await quiet(spawns);
    // The file list the UI shows first.
    const { files } = await api.listFiles(s.repoId, { scope: { kind: 'working' } });
    await quiet(spawns);

    for (const file of ['a.txt', 'b.txt', 'new.txt']) {
      const before = spawns().length;
      const response = await api.getDiff(s.repoId, { scope: { kind: 'working' }, path: file });
      const spawned = spawns().slice(before);
      if (FOLDS) expect(spawned.length, file).toBeGreaterThan(1);
      else if (file === 'new.txt') expect(spawned, file).toEqual([]);
      else {
        expect(
          spawned.map((argv) => argv[0]),
          file,
        ).toEqual(['diff']);
        expect(spawned[0]?.slice(-2), file).toEqual(['--', file]);
      }
      expect(withoutReview(response), file).toEqual(await wanted(s.fx, s.repo, file));
      // The hash the file list carries is the one the review marks are keyed by.
      expect(response.diff.patchHash, file).toBe(files.find((f) => f.path === file)?.patchHash);
    }
  });

  it('opened right after an edit, before the summary has seen it: the file as it is now', async () => {
    const s = await setup();
    const { daemon, spawns } = await startCounting(s.fx);
    const api = client(daemon);
    await api.addProject({ path: s.repo });
    await quiet(spawns);
    await api.listFiles(s.repoId, { scope: { kind: 'working' } });
    await appendFile(path.join(s.repo, 'a.txt'), 'edited a moment ago\n');
    // No wait: the watcher's debounce (100 ms) has not fired, the state is still the old one.
    const response = await api.getDiff(s.repoId, { scope: { kind: 'working' }, path: 'a.txt' });
    expect(response.diff.patch).toContain('+edited a moment ago');
    expect(withoutReview(response)).toEqual(await wanted(s.fx, s.repo, 'a.txt'));
    // Once the daemon has caught up, the list and the diff agree on the hash again.
    await quiet(spawns);
    const { files } = await api.listFiles(s.repoId, { scope: { kind: 'working' } });
    const again = await api.getDiff(s.repoId, { scope: { kind: 'working' }, path: 'a.txt' });
    expect(again.diff.patchHash).toBe(response.diff.patchHash);
    expect(again.diff.patchHash).toBe(files.find((f) => f.path === 'a.txt')?.patchHash);
  });

  it('incremental: false is the old route: status, raw diff and patch', async () => {
    const s = await setup();
    const { daemon, spawns } = await startCounting(s.fx, { incremental: false });
    const api = client(daemon);
    await api.addProject({ path: s.repo });
    await quiet(spawns);
    const before = spawns().length;
    const response = await api.getDiff(s.repoId, { scope: { kind: 'working' }, path: 'a.txt' });
    // The raw diff and the status side by side (either may start first), then the patch.
    const old = spawns().slice(before);
    // The raw lines in the message: a platform that spawns something else shows what it was.
    const lines = JSON.stringify(old);
    expect(old.map((argv) => argv[0]).sort(), lines).toEqual(['diff', 'diff', 'status']);
    expect(old[2]?.[0], lines).toBe('diff');
    expect(withoutReview(response)).toEqual(await wanted(s.fx, s.repo, 'a.txt'));
  });
});
