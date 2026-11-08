import { appendFileSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { GitCore } from '@octopus-diff/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGitCore } from '../src/index.js';
import { expectSummary, listFiles, locator } from './helpers/core.js';
import { createFixture, type Fixture, lines } from './helpers/fixture.js';

let fx: Fixture;
let core: GitCore;

beforeAll(() => {
  fx = createFixture();
  core = createGitCore(fx.coreOptions());
});

afterAll(async () => {
  await core.dispose();
  fx.dispose();
});

describe('getSummary', () => {
  it('summarizes a clean worktree', async () => {
    const repo = fx.repo('clean');
    const summary = await core.getSummary(locator(repo));
    expectSummary(summary);
    expect(summary).toMatchObject({
      branch: 'main',
      detached: false,
      upstream: null,
      aheadBehindRef: null,
      ahead: null,
      behind: null,
      counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
      changedFiles: 0,
      additions: 0,
      deletions: 0,
      inProgress: null,
    });
    expect(summary.headSha).toBe(fx.git(repo, ['rev-parse', 'HEAD']).trim());
    const again = await core.getSummary(locator(repo));
    expect(again.stateHash).toBe(summary.stateHash);
  });

  it('counts changes consistently with the working scope', async () => {
    const repo = fx.repo('dirty', {
      files: { 'a.txt': lines(10), 'b.txt': lines(4), 'c.txt': 'c\n' },
    });
    fx.write(
      path.join(repo, 'a.txt'),
      lines(10).replace('line 2', 'two').replace('line 3', 'three'),
    );
    fx.write(path.join(repo, 'b.txt'), lines(4).replace('line 1', 'one'));
    fx.git(repo, ['add', 'b.txt']);
    fx.write(path.join(repo, 'b.txt'), lines(4).replace('line 1', 'one').replace('line 4', 'four'));
    fx.git(repo, ['mv', 'c.txt', 'd.txt']);
    fx.write(path.join(repo, 'new.txt'), lines(3));
    fx.write(path.join(repo, 'new.bin'), Buffer.from([0, 1, 0]));
    const summary = await core.getSummary(locator(repo));
    expectSummary(summary);
    expect(summary.counts).toEqual({ staged: 2, unstaged: 2, untracked: 2, conflicted: 0 });
    const files = await listFiles(core, locator(repo), { kind: 'working' });
    expect(summary.changedFiles).toBe(files.length);
    const additions = files.reduce((sum, f) => sum + (f.additions ?? 0), 0);
    const deletions = files.reduce((sum, f) => sum + (f.deletions ?? 0), 0);
    expect(summary.additions).toBe(additions);
    expect(summary.deletions).toBe(deletions);
    expect(summary.additions).toBe(2 + 2 + 3);
  });

  it('changes stateHash when an already-modified or untracked file changes again', async () => {
    const repo = fx.repo('rehash', { files: { 'a.txt': 'one\n' } });
    const wt = locator(repo);
    const file = path.join(repo, 'a.txt');
    writeFileSync(file, 'two\n');
    const first = await core.getSummary(wt);
    // Same size, same line counts: git status output does not change.
    writeFileSync(file, 'six\n');
    utimesSync(file, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
    const second = await core.getSummary(wt);
    expect(second.counts).toEqual(first.counts);
    expect(second.additions).toBe(first.additions);
    expect(second.stateHash).not.toBe(first.stateHash);

    const untracked = path.join(repo, 'u.txt');
    writeFileSync(untracked, 'x\n');
    const third = await core.getSummary(wt);
    expect(third.stateHash).not.toBe(second.stateHash);
    appendFileSync(untracked, 'y\n');
    const fourth = await core.getSummary(wt);
    expect(fourth.stateHash).not.toBe(third.stateHash);
    expect(fourth.additions).toBe(third.additions + 1);
    const fifth = await core.getSummary(wt);
    expect(fifth.stateHash).toBe(fourth.stateHash);

    fx.git(repo, ['add', 'a.txt']);
    const staged = await core.getSummary(wt);
    expect(staged.stateHash).not.toBe(fifth.stateHash);
    fx.commitAll(repo, 'commit');
    const committed = await core.getSummary(wt);
    expect(committed.stateHash).not.toBe(staged.stateHash);
    expect(committed.changedFiles).toBe(0);
  });

  it('measures ahead/behind against the upstream, else the default branch', async () => {
    const origin = fx.repo('ab-origin');
    const clone = path.join(fx.root, 'ab-clone');
    fx.git(fx.root, ['clone', '-q', origin, clone]);
    fx.write(path.join(clone, 'local.txt'), 'l\n');
    fx.commitAll(clone, 'local 1');
    fx.write(path.join(clone, 'local2.txt'), 'l\n');
    fx.commitAll(clone, 'local 2');
    fx.write(path.join(origin, 'remote.txt'), 'r\n');
    fx.commitAll(origin, 'remote');
    fx.git(clone, ['fetch', '-q']);
    const tracking = await core.getSummary(locator(clone));
    expect(tracking).toMatchObject({
      branch: 'main',
      upstream: 'origin/main',
      aheadBehindRef: 'origin/main',
      ahead: 2,
      behind: 1,
    });

    // An agent-style worktree branch without upstream: measured against the default branch.
    const agent = path.join(fx.root, 'ab-agent');
    fx.git(clone, ['worktree', 'add', '-q', '-b', 'agent/task', agent]);
    fx.write(path.join(agent, 'agent.txt'), 'a\n');
    fx.commitAll(agent, 'agent');
    fx.write(path.join(clone, 'main-more.txt'), 'm\n');
    fx.commitAll(clone, 'main more');
    const agentSummary = await core.getSummary(locator(agent, path.join(clone, '.git')));
    expectSummary(agentSummary);
    expect(agentSummary).toMatchObject({
      branch: 'agent/task',
      upstream: null,
      aheadBehindRef: 'main',
      ahead: 1,
      behind: 1,
    });
    const explicit = await core.getSummary(locator(agent), { defaultBranch: 'origin/main' });
    expect(explicit).toMatchObject({ aheadBehindRef: 'origin/main', ahead: 3, behind: 1 });
    const missing = await core.getSummary(locator(agent), { defaultBranch: 'nope' });
    expect(missing).toMatchObject({ aheadBehindRef: null, ahead: null, behind: null });

    // On the default branch itself without upstream: nothing to compare against.
    const solo = fx.repo('ab-solo');
    expect(await core.getSummary(locator(solo))).toMatchObject({
      aheadBehindRef: null,
      ahead: null,
    });

    // Detached HEAD is compared with the default branch.
    fx.git(solo, ['switch', '-q', '--detach', 'HEAD']);
    fx.write(path.join(solo, 'x.txt'), 'x\n');
    fx.commitAll(solo, 'detached work');
    expect(await core.getSummary(locator(solo))).toMatchObject({
      branch: null,
      detached: true,
      aheadBehindRef: 'main',
      ahead: 1,
      behind: 0,
    });
  });

  it('detects operations in progress', async () => {
    const repo = fx.repo('progress', { files: { 'a.txt': 'a\n' } });
    fx.git(repo, ['switch', '-q', '-c', 'side']);
    fx.write(path.join(repo, 'a.txt'), 'side\n');
    fx.commitAll(repo, 'side');
    fx.git(repo, ['switch', '-q', 'main']);
    fx.write(path.join(repo, 'a.txt'), 'main\n');
    fx.commitAll(repo, 'main');
    fx.git(repo, ['cherry-pick', 'side'], { allowFail: true });
    expect((await core.getSummary(locator(repo))).inProgress).toBe('cherry-pick');
    fx.git(repo, ['cherry-pick', '--abort']);
    fx.git(repo, ['switch', '-q', 'side']);
    fx.git(repo, ['rebase', 'main'], { allowFail: true });
    expect((await core.getSummary(locator(repo))).inProgress).toBe('rebase');
    fx.git(repo, ['rebase', '--abort']);
    const gitDir = path.join(repo, '.git');
    mkdirSync(path.join(gitDir, 'rebase-apply'));
    writeFileSync(path.join(gitDir, 'rebase-apply', 'applying'), '');
    expect((await core.getSummary(locator(repo))).inProgress).toBe('am');
  });
});
