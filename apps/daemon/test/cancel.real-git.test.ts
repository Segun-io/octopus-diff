import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { startDaemon } from '../src/daemon.js';
import { client, eventually, http, onCleanup, TEST_TOKEN, tempDir } from './helpers.js';
import { makeRealGitFixture, makeRealRepo } from './real-git-fixture.js';

/**
 * An aborted HTTP request stops its git process (#44), against real git: a wrapper in front of
 * git logs every process (`start <pid> <subcommand> <dir name>`) and holds a subcommand while
 * `holds/<sub>` exists, so the request is still running git when the client goes away.
 */
async function setup() {
  const fx = await makeRealGitFixture();
  const repo = await makeRealRepo(fx, 'app', { 'a.txt': 'one\n', 'b.txt': 'b\n' });
  await writeFile(path.join(repo, 'a.txt'), 'one\ntwo\n');
  const log = path.join(fx.root, 'git.log');
  const holds = path.join(fx.root, 'holds');
  await mkdir(holds);
  const wrapper = path.join(fx.root, 'git-wrapper.sh');
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
      `echo "start $$ $sub $(basename "$PWD")" >> "${log}"`,
      `while [ -e "${holds}/$sub" ]; do sleep 0.01; done`,
      'exec git "$@"',
      '',
    ].join('\n'),
  );
  chmodSync(wrapper, 0o755);
  const daemon = await startDaemon({
    host: '127.0.0.1',
    port: 0,
    token: TEST_TOKEN,
    stateDir: await tempDir(),
    logLevel: process.env.OCTOPUS_DIFF_TEST_LOGS ? 'debug' : 'silent',
    git: { env: fx.env, gitBinary: wrapper },
    projects: [repo],
    watch: { debounceMs: 150 },
    internal: { forges: false },
  });
  onCleanup(() => daemon.close());
  const api = client(daemon);
  const worktreeId = await eventually(async () => {
    const [project] = (await api.listProjects()).projects;
    const wt = project?.worktrees[0];
    return wt?.summary ? wt.worktree.id : undefined;
  });
  const spawned = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [, pid, sub] = line.split(' ');
            return { pid: Number(pid), sub: sub ?? '' };
          })
      : [];
  const hold = (sub: string) => {
    const file = path.join(holds, sub);
    writeFileSync(file, '');
    onCleanup(() => rmSync(file, { force: true }));
    return () => rmSync(file, { force: true });
  };
  return { daemon, worktreeId, log, spawned, hold };
}

const groupAlive = (pid: number): boolean => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function abortWhileRunning(
  ctx: Awaited<ReturnType<typeof setup>>,
  sub: string,
  pathname: string,
): Promise<void> {
  writeFileSync(ctx.log, '');
  const release = ctx.hold(sub);
  const controller = new AbortController();
  const request = http(ctx.daemon, pathname, { signal: controller.signal }).catch(
    (e: unknown) => e,
  );
  const held = await eventually(() => ctx.spawned().find((s) => s.sub === sub));
  expect(groupAlive(held.pid)).toBe(true);
  controller.abort();
  await request;
  // The daemon saw the client go away and stopped git (SIGTERM; SIGKILL after 500 ms at most).
  await eventually(() => !groupAlive(held.pid), 2_000);
  release();
  // Nothing the request started is left running, and the daemon still answers.
  await eventually(() => ctx.spawned().every((s) => !groupAlive(s.pid)), 2_000);
  const res = await http(ctx.daemon, pathname);
  expect(res.status).toBe(200);
}

describe.runIf(process.platform !== 'win32')('aborted requests stop git (#44, real git)', () => {
  it('an aborted /diff leaves no git child', async () => {
    const ctx = await setup();
    await abortWhileRunning(
      ctx,
      'diff',
      `/api/worktrees/${ctx.worktreeId}/diff?scope=working&path=a.txt`,
    );
  });

  it('an aborted /files leaves no git child', async () => {
    const ctx = await setup();
    // Since #40 the list of the summary's state comes from the summary's own status: the
    // request's git process is the (pathspec-limited) diff.
    await abortWhileRunning(ctx, 'diff', `/api/worktrees/${ctx.worktreeId}/files?scope=working`);
  });
});
