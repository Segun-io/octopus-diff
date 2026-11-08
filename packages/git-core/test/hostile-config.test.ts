/**
 * Repository config is untrusted. A repo whose local config points core.fsmonitor, filter
 * drivers, external diff, textconv, gpg and pagers at a script must not get that script run
 * by any GitCore method. Each hostile setting is first proven effective with plain git (the
 * marker appears), then GitCore is exercised and must leave no marker.
 */
import {
  appendFileSync,
  chmodSync,
  existsSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { DiffScope, GitCore } from '@octopus-diff/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGitCore } from '../src/index.js';
import { locator } from './helpers/core.js';
import { createFixture, type Fixture } from './helpers/fixture.js';

describe('hostile repository config', () => {
  let fx: Fixture;
  let core: GitCore;
  let repo: string;
  let markers: string;

  const script = (name: string, body: string): string => {
    const file = path.join(fx.root, `${name}.sh`);
    writeFileSync(file, `#!/bin/sh\necho "$@" > "${markers}/${name}"\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
  };

  const markerNames = (): string[] => (existsSync(markers) ? readdirSync(markers).sort() : []);
  const clearMarkers = (): void => {
    for (const name of markerNames()) rmSync(path.join(markers, name));
  };

  beforeAll(() => {
    fx = createFixture();
    markers = path.join(fx.root, 'markers');
    fx.write(path.join(markers, '.keep'), '');
    rmSync(path.join(markers, '.keep'));
    repo = fx.repo('hostile', {
      files: { 'a.txt': 'one\n', 'b.txt': 'two\n', 'trusted.txt': 't\n' },
    });
    // A trusted, user-level filter driver (like git-lfs) in the global config.
    appendFileSync(
      fx.env.GIT_CONFIG_GLOBAL as string,
      `[filter "trusted"]\n\tclean = ${script('global-filter', 'cat')}\n`,
    );
    const set = (key: string, value: string): void => {
      fx.git(repo, ['config', key, value]);
    };
    set('core.fsmonitor', script('fsmonitor', 'exit 0'));
    set('filter.evil.clean', script('filter-clean', 'cat'));
    set('filter.evil.smudge', script('filter-smudge', 'cat'));
    set('filter.evil.required', 'true');
    set('filter.trusted.clean', script('local-override', 'cat'));
    set('diff.external', script('external-diff', 'exit 0'));
    set('diff.evil.command', script('diff-driver', 'exit 0'));
    set('diff.evil.textconv', script('textconv', 'cat "$1"'));
    set('core.pager', script('pager', 'cat'));
    set('pager.diff', script('pager-diff', 'cat'));
    set('pager.log', script('pager-log', 'cat'));
    set('log.showSignature', 'true');
    set('gpg.program', script('gpg', 'exit 1'));
    set('core.hooksPath', path.join(fx.root, 'hooks'));
    fx.write(
      path.join(repo, '.gitattributes'),
      '*.txt filter=evil diff=evil\ntrusted.txt filter=trusted\n',
    );
    fx.git(repo, ['add', '.gitattributes']);
    fx.git(repo, ['-c', 'core.fsmonitor=false', 'commit', '-q', '-m', 'attributes']);
    // A commit with a (fake) signature, so showSignature would invoke gpg.program.
    const raw = fx.git(repo, ['cat-file', 'commit', 'HEAD']);
    const signed = raw.replace(
      /\n\n/,
      '\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAABCAAdFiEE\n -----END PGP SIGNATURE-----\n\n',
    );
    const sha = fx
      .git(repo, ['hash-object', '-t', 'commit', '-w', '--stdin'], { input: signed })
      .trim();
    fx.git(repo, ['update-ref', 'refs/heads/main', sha]);
    // Dirty state: modified, stat-dirty (forces content re-reads through the clean filter).
    writeFileSync(path.join(repo, 'a.txt'), 'changed\n');
    const future = new Date(Date.now() + 60_000);
    utimesSync(path.join(repo, 'b.txt'), future, future);
    utimesSync(path.join(repo, 'trusted.txt'), future, future);
    writeFileSync(path.join(repo, 'new.txt'), 'new\n');
  });

  afterAll(async () => {
    await core?.dispose();
    fx.dispose();
  });

  it('the hostile settings really run programs under plain git (control)', () => {
    clearMarkers();
    fx.git(repo, ['status', '--porcelain=v2']);
    fx.git(repo, ['diff', 'HEAD']);
    fx.git(repo, ['log', '-1']);
    const found = markerNames();
    expect(found).toContain('fsmonitor');
    expect(found).toContain('filter-clean');
    // The attribute's diff driver wins over diff.external for *.txt files.
    expect(found).toContain('diff-driver');
    expect(found).toContain('gpg');
    clearMarkers();
    // Restore the stat-dirty state the plain git calls may have refreshed.
    const future = new Date(Date.now() + 90_000);
    utimesSync(path.join(repo, 'b.txt'), future, future);
    utimesSync(path.join(repo, 'trusted.txt'), future, future);
  });

  it('no GitCore method runs any of them', async () => {
    clearMarkers();
    core = createGitCore(
      fx.coreOptions({ env: { GIT_EXTERNAL_DIFF: script('env-external-diff', 'exit 0') } }),
    );
    const { project, worktrees } = await core.resolveProject(repo);
    await core.listWorktrees(project);
    await core.detectDefaultBranch(project);
    await core.scan(fx.root, { depth: 1 });
    const wt = locator(repo, project.commonDir);
    await core.getSummary(wt);
    await core.getWatchTargets(wt);
    const commits = await core.listCommits(wt);
    const scopes: DiffScope[] = [
      { kind: 'working' },
      { kind: 'staged' },
      { kind: 'unstaged' },
      { kind: 'commit', sha: commits[0]?.sha as string },
      { kind: 'commit', sha: commits[1]?.sha as string },
    ];
    let diffs = 0;
    for (const scope of scopes) {
      for (const file of await core.listChangedFiles(wt, scope)) {
        const diff = await core.getFileDiff(wt, scope, file, { ignoreWhitespace: true });
        expect(diff.patch).not.toContain('textconv');
        diffs += 1;
      }
    }
    expect(diffs).toBeGreaterThan(3);
    expect(worktrees).toHaveLength(1);
    const found = markerNames();
    // The user's own global filter driver is still honored (git-lfs keeps working) ...
    expect(found.filter((name) => name !== 'global-filter')).toEqual([]);
  });

  it('re-reads config on every operation (includes can change between calls)', async () => {
    const repo2 = fx.repo('include-later', { files: { 'x.txt': 'x\n' } });
    const include = path.join(fx.root, 'later.inc');
    writeFileSync(include, '');
    fx.git(repo2, ['config', 'include.path', include]);
    const fresh = createGitCore(fx.coreOptions());
    try {
      const wt = locator(repo2);
      writeFileSync(path.join(repo2, 'x.txt'), 'changed\n');
      await fresh.listChangedFiles(wt, { kind: 'working' });
      clearMarkers();
      writeFileSync(include, `[filter "late"]\n\tclean = ${script('late-filter', 'cat')}\n`);
      fx.write(path.join(repo2, '.gitattributes'), '* filter=late\n');
      const future = new Date(Date.now() + 60_000);
      utimesSync(path.join(repo2, 'x.txt'), future, future);
      await fresh.listChangedFiles(wt, { kind: 'working' });
      await fresh.getSummary(wt);
      expect(markerNames()).toEqual([]);
    } finally {
      await fresh.dispose();
    }
  });

  it('keeps the trusted global filter when a local config overrides it', async () => {
    clearMarkers();
    const future = new Date(Date.now() + 120_000);
    utimesSync(path.join(repo, 'trusted.txt'), future, future);
    const fresh = createGitCore(fx.coreOptions());
    try {
      await fresh.getSummary(locator(repo));
      const found = markerNames();
      expect(found).not.toContain('local-override');
      expect(found).toContain('global-filter');
    } finally {
      await fresh.dispose();
    }
  });
});
