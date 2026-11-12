/**
 * getFileDiff from the summary state (#41): what happens when the world moves while it reads. A
 * stand-in git binary runs hooks around the patch run (`diff -p`), so a file, the index or the
 * summary state changes at exactly the unlucky moment, and can hold that process so a call is in
 * flight while the test acts. The answer must describe the file as it is when read (equal to what
 * the whole-scope route says afterwards), a cancelled call must stop and cost nothing, and nothing
 * a failed or abandoned read did may leak into the next one.
 *
 * Skipped on a case-folding filesystem (macOS, `OCTOPUS_DIFF_TEST_FOLDS_CASE=1`): there the summary
 * route is off by design and the whole-scope route has its own tests.
 */
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  type DiffScope,
  type GitCore,
  type GitFileDiff,
  isGitCoreError,
} from '@octopus-diff/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileDiffRoutes } from '../src/diff.js';
import { createGitCore } from '../src/index.js';
import { locator } from './helpers/core.js';
import { createFixture, type Fixture, lines } from './helpers/fixture.js';
import { worktreesFoldCase } from './helpers/folds.js';

const FOLDS = await worktreesFoldCase();
const WORKING: DiffScope = { kind: 'working' };

let fx: Fixture;
let wrapper: string;
let log: string;
let hooks: string;
let holds: string;
let reference: GitCore;
const cores: GitCore[] = [];

function isolated(): Record<string, string> {
  return {
    HOME: path.join(fx.root, 'empty-home'),
    XDG_CONFIG_HOME: path.join(fx.root, 'empty-xdg'),
    GIT_ATTR_NOSYSTEM: '1',
  };
}

beforeAll(() => {
  fx = createFixture('octopus-diff-dfs-race-');
  log = path.join(fx.root, 'wrapper.log');
  hooks = path.join(fx.root, 'hooks');
  holds = path.join(fx.root, 'holds');
  fx.write(path.join(hooks, '.keep'), '');
  fx.write(path.join(holds, '.keep'), '');
  wrapper = path.join(fx.root, 'git-wrapper.sh');
  // Logs `start <pid> <sub> <dir name>`; `diff` with `-p` is the patch run (`diffp`): it waits
  // while `holds/diffp@<dir name>` exists, runs `hooks/<dir name>.before` first and
  // `hooks/<dir name>.after` once git has finished (each only once), then exits with git's status.
  writeFileSync(
    wrapper,
    [
      '#!/bin/sh',
      'sub=""; skip=0',
      'for a in "$@"; do',
      '  if [ "$skip" = 1 ]; then skip=0; continue; fi',
      '  case "$a" in -c) skip=1 ;; -*) ;; *) sub="$a"; break ;; esac',
      'done',
      '[ -n "$sub" ] || sub=version',
      'kind="$sub"',
      'for a in "$@"; do [ "$a" = "-p" ] && [ "$sub" = diff ] && kind=diffp; done',
      'dir=$(basename "$PWD")',
      `echo "start $$ $kind $dir" >> "${log}"`,
      `while [ -e "${holds}/$kind@$dir" ]; do sleep 0.01; done`,
      `if [ "$kind" = diffp ] && [ -e "${hooks}/$dir.before" ]; then sh "${hooks}/$dir.before"; rm -f "${hooks}/$dir.before"; fi`,
      'git "$@"; code=$?',
      `if [ "$kind" = diffp ] && [ -e "${hooks}/$dir.after" ]; then sh "${hooks}/$dir.after"; rm -f "${hooks}/$dir.after"; fi`,
      'exit $code',
      '',
    ].join('\n'),
  );
  chmodSync(wrapper, 0o755);
  reference = createGitCore(fx.coreOptions({ incremental: false, env: isolated() }));
});

afterAll(async () => {
  await reference.dispose();
  for (const core of cores) await core.dispose();
  fx.dispose();
});

function wrapped(): GitCore {
  const core = createGitCore(fx.coreOptions({ gitBinary: wrapper, env: isolated() }));
  cores.push(core);
  return core;
}

const started = (kind: string, dir: string): number =>
  existsSync(log)
    ? readFileSync(log, 'utf8')
        .split('\n')
        .filter((line) => line.endsWith(` ${kind} ${dir}`)).length
    : 0;

const hook = (dir: string, when: 'before' | 'after', script: string): void =>
  writeFileSync(path.join(hooks, `${dir}.${when}`), `${script}\n`);

function hold(kind: string, dir: string): () => void {
  const file = path.join(holds, `${kind}@${dir}`);
  writeFileSync(file, '');
  return () => rmSync(file, { force: true });
}

async function until(condition: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function repoWithState(
  core: GitCore,
  name: string,
): Promise<{ repo: string; wt: ReturnType<typeof locator> }> {
  const repo = fx.repo(name, { files: { 'a.txt': lines(20), 'b.txt': lines(20), 'c.txt': 'c\n' } });
  fx.write(path.join(repo, 'a.txt'), `${lines(20)}edit one\n`);
  fx.write(path.join(repo, 'b.txt'), `${lines(20)}edit b\n`);
  const wt = locator(repo);
  await core.getSummary(wt);
  return { repo, wt };
}

function routeSince(before: { summary: number; reasons: Map<string, number> }): string {
  if (fileDiffRoutes.summary !== before.summary) return 'summary';
  for (const [reason, count] of fileDiffRoutes.reasons) {
    if (count !== (before.reasons.get(reason) ?? 0)) return reason;
  }
  return 'none';
}
const mark = () => ({ summary: fileDiffRoutes.summary, reasons: new Map(fileDiffRoutes.reasons) });

describe.skipIf(FOLDS)('a file or the state moves while getFileDiff reads', () => {
  it('control: nothing moves, the summary route answers', async () => {
    const core = wrapped();
    const { wt } = await repoWithState(core, 'race-control');
    const before = mark();
    const got = await core.getFileDiff(wt, WORKING, { path: 'a.txt' });
    expect(routeSince(before)).toBe('summary');
    expect(got).toEqual(await reference.getFileDiff(wt, WORKING, { path: 'a.txt' }));
  });

  it('the file is edited after git read it: the answer is the file as it is now', async () => {
    const core = wrapped();
    const { repo, wt } = await repoWithState(core, 'race-after');
    hook('race-after', 'after', `printf 'late edit\\n' >> "${path.join(repo, 'a.txt')}"`);
    const before = mark();
    const got = await core.getFileDiff(wt, WORKING, { path: 'a.txt' });
    expect(routeSince(before)).toBe('changed-while-reading');
    expect(got.patch).toContain('+late edit');
    expect(got).toEqual(await reference.getFileDiff(wt, WORKING, { path: 'a.txt' }));
  });

  it('the file is edited just before git reads it: the signature taken first does not vouch', async () => {
    const core = wrapped();
    const { repo, wt } = await repoWithState(core, 'race-before');
    hook('race-before', 'before', `printf 'early edit\\n' >> "${path.join(repo, 'a.txt')}"`);
    const before = mark();
    const got = await core.getFileDiff(wt, WORKING, { path: 'a.txt' });
    // The checks run beside git's start: they see the edit either as a stale signature or, a
    // moment later, as a change during the read. Either way the state does not vouch for it.
    expect(['stale-signature', 'changed-while-reading']).toContain(routeSince(before));
    expect(got.patch).toContain('+early edit');
    expect(got).toEqual(await reference.getFileDiff(wt, WORKING, { path: 'a.txt' }));
  });

  it('the file is restored to HEAD while read: not changed any more, so not found, like the whole route', async () => {
    const core = wrapped();
    const { repo, wt } = await repoWithState(core, 'race-restore');
    hook('race-restore', 'after', `git -C "${repo}" checkout -q -- a.txt`);
    const before = mark();
    const got = await core
      .getFileDiff(wt, WORKING, { path: 'a.txt' })
      .catch((error: unknown) => error);
    expect(routeSince(before)).not.toBe('summary');
    // The checkout rewrote the index too: either reason says the state moved.
    const want = await reference
      .getFileDiff(wt, WORKING, { path: 'a.txt' })
      .catch((error: unknown) => error);
    expect(isGitCoreError(got, 'not_found')).toBe(true);
    expect(isGitCoreError(want, 'not_found')).toBe(true);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'the file becomes unreadable just before git reads it: the whole route meets it and fails alike',
    async () => {
      const core = wrapped();
      const { repo, wt } = await repoWithState(core, 'race-unreadable');
      hook('race-unreadable', 'before', `chmod 000 "${path.join(repo, 'a.txt')}"`);
      const before = mark();
      const failed = await core
        .getFileDiff(wt, WORKING, { path: 'a.txt' })
        .catch((error: unknown) => error);
      try {
        // git failed on the file; the whole-scope route (which also fails) was asked, no state used.
        expect(routeSince(before)).toBe('git-failed');
        const want = await reference
          .getFileDiff(wt, WORKING, { path: 'a.txt' })
          .catch((error: unknown) => error);
        expect(isGitCoreError(failed) && isGitCoreError(want) && failed.code === want.code).toBe(
          true,
        );
        // Nothing stuck: the other file is still answered from the state.
        const other = mark();
        await core.getFileDiff(wt, WORKING, { path: 'b.txt' });
        expect(routeSince(other)).toBe('summary');
      } finally {
        chmodSync(path.join(repo, 'a.txt'), 0o644);
      }
    },
  );

  it('the index changes after git read the file (a git add elsewhere): the answer is still the file as read', async () => {
    const core = wrapped();
    const { repo, wt } = await repoWithState(core, 'race-index');
    hook('race-index', 'after', `git -C "${repo}" add b.txt`);
    const got = await core.getFileDiff(wt, WORKING, { path: 'a.txt' });
    // Staging another file changes nothing about this one's patch against HEAD.
    expect(got).toEqual(await reference.getFileDiff(wt, WORKING, { path: 'a.txt' }));
    // The next call meets the moved index and reads the whole way.
    const next = mark();
    expect(await core.getFileDiff(wt, WORKING, { path: 'a.txt' })).toEqual(got);
    expect(routeSince(next)).toBe('index');
  });

  it('a summary replaces the state while the patch run is held: the read is checked against the state it started from', async () => {
    const core = wrapped();
    const { repo, wt } = await repoWithState(core, 'race-summary');
    const release = hold('diffp', 'race-summary');
    try {
      const before = mark();
      const call = core.getFileDiff(wt, WORKING, { path: 'a.txt' });
      await until(() => started('diffp', 'race-summary') === 1);
      fx.write(path.join(repo, 'a.txt'), `${lines(20)}edit one\nand two\n`);
      await core.getSummary(wt, { changedPaths: ['a.txt'] });
      release();
      const got = await call;
      // It read the new content; the state it began with does not vouch for it.
      expect(routeSince(before)).toBe('changed-while-reading');
      expect(got.patch).toContain('+and two');
      expect(got).toEqual(await reference.getFileDiff(wt, WORKING, { path: 'a.txt' }));
      // And the new state vouches for the next read.
      const again = mark();
      expect(await core.getFileDiff(wt, WORKING, { path: 'a.txt' })).toEqual(got);
      expect(routeSince(again)).toBe('summary');
    } finally {
      release();
    }
  });
});

describe.skipIf(FOLDS)('cancellation (#44)', () => {
  it('an aborted call stops, falls back to nothing, and the next call is unaffected', async () => {
    const core = wrapped();
    const { wt } = await repoWithState(core, 'race-abort');
    const release = hold('diffp', 'race-abort');
    const statusBefore = started('status', 'race-abort');
    try {
      const before = mark();
      const controller = new AbortController();
      const call = core
        .getFileDiff(
          wt,
          { kind: 'working' },
          { path: 'a.txt' },
          { signal: controller.signal, priority: 'interactive' },
        )
        .catch((error: unknown) => error);
      await until(() => started('diffp', 'race-abort') === 1);
      controller.abort();
      expect(isGitCoreError(await call, 'aborted')).toBe(true);
      // No whole-scope fallback started behind it, and no route was counted.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(started('status', 'race-abort')).toBe(statusBefore);
      expect(started('diffp', 'race-abort')).toBe(1);
      expect(routeSince(before)).toBe('none');
      release();
      const again = mark();
      const got = await core.getFileDiff(wt, WORKING, { path: 'a.txt' });
      expect(routeSince(again)).toBe('summary');
      expect(got).toEqual(await reference.getFileDiff(wt, WORKING, { path: 'a.txt' }));
    } finally {
      release();
    }
  });

  it('a call aborted before it started never reaches git', async () => {
    const core = wrapped();
    const { wt } = await repoWithState(core, 'race-aborted-first');
    const controller = new AbortController();
    controller.abort();
    const spawnedBefore = started('diffp', 'race-aborted-first');
    const result = await core
      .getFileDiff(wt, WORKING, { path: 'a.txt' }, { signal: controller.signal })
      .catch((error: unknown) => error);
    expect(isGitCoreError(result, 'aborted')).toBe(true);
    expect(started('diffp', 'race-aborted-first')).toBe(spawnedBefore);
  });
});

describe.skipIf(FOLDS)('a failed read never poisons the next one', () => {
  it('a git failure falls back to the whole route, which fails the same way; the state stays usable', async () => {
    const core = wrapped();
    const { repo, wt } = await repoWithState(core, 'race-fail');
    // A lock makes nothing fail for a read-only diff; an unreadable file does (git cannot hash it).
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    chmodSync(path.join(repo, 'a.txt'), 0o000);
    // The mode change moved the file's signature (ctime): the state does not vouch, the whole route
    // meets the unreadable file, and the call fails like the reference core's.
    const failed = await core
      .getFileDiff(wt, WORKING, { path: 'a.txt' })
      .catch((error: unknown) => error);
    const want = await reference
      .getFileDiff(wt, WORKING, { path: 'a.txt' })
      .catch((error: unknown) => error);
    expect(isGitCoreError(failed)).toBe(true);
    expect(isGitCoreError(failed) && isGitCoreError(want) && failed.code === want.code).toBe(true);
    // The other file is still answered from the state.
    const before = mark();
    const other = await core.getFileDiff(wt, WORKING, { path: 'b.txt' });
    expect(routeSince(before)).toBe('summary');
    expect(other).toEqual(await reference.getFileDiff(wt, WORKING, { path: 'b.txt' }));
    chmodSync(path.join(repo, 'a.txt'), 0o644);
    await core.getSummary(wt);
    const after = mark();
    const ok: GitFileDiff = await core.getFileDiff(wt, WORKING, { path: 'a.txt' });
    expect(routeSince(after)).toBe('summary');
    expect(ok).toEqual(await reference.getFileDiff(wt, WORKING, { path: 'a.txt' }));
  });
});
