import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gitHelperDisabledByEnv } from '@octopus-diff/git-core';
import { describe, expect, it } from 'vitest';
import { startDaemon } from '../src/daemon.js';
import { client, eventually, TEST_TOKEN, tempDir } from './helpers.js';
import { makeRealGitFixture, makeRealRepo } from './real-git-fixture.js';

/**
 * The daemon's git-core starts git through the spawn helper (#45) unless `internal.gitHelper` is
 * false, and closing the daemon stops the helper. A wrapper in front of git logs the parent of
 * every git process (one printf per spawn): a helper process, or the daemon's own process.
 */
async function run(gitHelper: boolean | undefined) {
  const fx = await makeRealGitFixture();
  const repo = await makeRealRepo(fx, 'app', { 'a.txt': 'one\n' });
  await writeFile(path.join(repo, 'a.txt'), 'one\ntwo\n');
  const log = path.join(fx.root, 'parents.log');
  const wrapper = path.join(fx.root, 'git-wrapper.sh');
  writeFileSync(
    wrapper,
    ['#!/bin/sh', `printf '%s\\n' "$PPID" >> "${log}"`, 'exec git "$@"', ''].join('\n'),
  );
  chmodSync(wrapper, 0o755);
  const daemon = await startDaemon({
    host: '127.0.0.1',
    port: 0,
    token: TEST_TOKEN,
    stateDir: await tempDir(),
    logLevel: 'silent',
    git: { env: fx.env, gitBinary: wrapper },
    projects: [repo],
    watch: { enabled: false },
    internal: { forges: false, ...(gitHelper !== undefined ? { gitHelper } : {}) },
  });
  try {
    const api = client(daemon);
    const worktreeId = await eventually(async () => {
      const [project] = (await api.listProjects()).projects;
      const wt = project?.worktrees[0];
      return wt?.summary ? wt.worktree.id : undefined;
    });
    const diff = await api.getDiff(worktreeId, { path: 'a.txt' });
    expect(JSON.stringify(diff.diff)).toContain('two');
  } finally {
    await daemon.close();
  }
  const parents = existsSync(log)
    ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(Number)
    : [];
  return { parents: [...new Set(parents)] };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('the daemon and the git spawn helper (#45)', () => {
  it.skipIf(gitHelperDisabledByEnv() || process.platform === 'win32')(
    'starts git through helper processes by default, and closing the daemon stops them',
    async () => {
      const { parents } = await run(undefined);
      expect(parents.length).toBeGreaterThan(0);
      expect(parents).not.toContain(process.pid);
      // Every helper exited with the daemon.
      for (const pid of parents) expect(alive(pid), `helper ${pid}`).toBe(false);
    },
  );

  it('internal.gitHelper: false spawns git from the daemon process', async () => {
    const { parents } = await run(false);
    expect(parents).toEqual([process.pid]);
  });
});
