import path from 'node:path';
import type { GitCore } from '@octopus-diff/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGitCore, stripUrlCredentials } from '../src/index.js';
import { createFixture, type Fixture } from './helpers/fixture.js';

describe('stripUrlCredentials', () => {
  it.each([
    ['https://user:token@github.com/o/r.git', 'https://github.com/o/r.git'],
    ['https://ghp_abc123@github.com/o/r', 'https://github.com/o/r'],
    ['http://a:b@host:8080/x?y#z', 'http://host:8080/x?y#z'],
    ['git://u@host/x', 'git://host/x'],
    ['ssh://git:secret@host:22/x.git', 'ssh://git@host:22/x.git'],
    ['ssh://git@host/x.git', 'ssh://git@host/x.git'],
    ['git@github.com:o/r.git', 'git@github.com:o/r.git'],
    ['https://github.com/o/r', 'https://github.com/o/r'],
    ['/srv/git/app.git', '/srv/git/app.git'],
    ['file:///srv/git/app.git', 'file:///srv/git/app.git'],
  ])('%s', (input, expected) => {
    expect(stripUrlCredentials(input)).toBe(expected);
  });
});

describe('readRepositoryInfo', () => {
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

  async function locate(dir: string) {
    const resolved = await core.resolveProject(dir);
    return { id: resolved.project.id, commonDir: resolved.project.commonDir };
  }

  it('counts branches and tags, reads the default branch head and ahead/behind its upstream', async () => {
    // A local bare "remote" with two commits; the clone is one behind and two ahead.
    const seed = fx.repo('info-seed');
    fx.commitAll(seed, 'second');
    const bare = path.join(fx.root, 'info-remote.git');
    fx.git(fx.root, ['clone', '-q', '--bare', seed, bare]);
    const clone = path.join(fx.root, 'info-clone');
    fx.git(fx.root, ['clone', '-q', bare, clone]);
    fx.git(clone, ['reset', '-q', '--hard', 'HEAD~1']);
    fx.commitAll(clone, 'local one');
    fx.commitAll(clone, 'local two');
    fx.git(clone, ['branch', 'feat/a']);
    fx.git(clone, ['branch', 'feat/b']);
    fx.git(clone, ['tag', 'v1']);
    fx.git(clone, ['tag', '-a', '-m', 'annotated', 'v2']);
    fx.git(clone, ['remote', 'set-url', 'origin', 'https://user:s3cret@github.com/o/r.git']);
    fx.git(clone, ['remote', 'set-url', '--push', 'origin', 'https://tok@github.com/o/r.git']);

    const info = await core.readRepositoryInfo?.(await locate(clone), { defaultBranch: 'main' });
    expect(info).toBeDefined();
    if (!info) return;
    expect(info.localBranches).toBe(3);
    expect(info.tags).toBe(2);
    expect(info.defaultBranch).toMatchObject({
      name: 'main',
      upstream: 'origin/main',
      ahead: 2,
      behind: 1,
    });
    expect(info.defaultBranch?.head?.subject).toBe('local two');
    expect(info.defaultBranch?.head?.authorName).toBe('Fixture User');
    expect(info.defaultBranch?.head?.authorDate).toBe('2026-01-01T00:00:00.000Z');
    expect(info.lastActivityAt).toBe('2026-01-01T00:00:00.000Z');
    expect(info.remotes).toEqual([
      { name: 'origin', url: 'https://github.com/o/r.git', pushUrl: 'https://github.com/o/r.git' },
    ]);
    expect(JSON.stringify(info)).not.toContain('s3cret');
    expect(JSON.stringify(info)).not.toContain('tok@');
  });

  it('detects the default branch when none is given; no upstream means null ahead/behind', async () => {
    const repo = fx.repo('info-plain');
    const info = await core.readRepositoryInfo?.(await locate(repo));
    expect(info?.defaultBranch).toMatchObject({
      name: 'main',
      upstream: null,
      ahead: null,
      behind: null,
    });
    expect(info?.remotes).toEqual([]);
  });

  it('handles an unborn repository and a bare repository', async () => {
    const empty = fx.repo('info-empty', { empty: true });
    const unborn = await core.readRepositoryInfo?.(await locate(empty));
    expect(unborn).toEqual({
      defaultBranch: null,
      localBranches: 0,
      tags: 0,
      remotes: [],
      lastActivityAt: null,
    });
    const seed = fx.repo('info-bare-seed');
    const bare = path.join(fx.root, 'info-bare.git');
    fx.git(fx.root, ['clone', '-q', '--bare', seed, bare]);
    const info = await core.readRepositoryInfo?.(await locate(bare));
    expect(info?.localBranches).toBe(1);
    expect(info?.defaultBranch?.name).toBe('main');
    expect(info?.defaultBranch?.head?.subject).toBe('initial');
  });

  it('a default branch that is not a local branch resolves through the remote-tracking ref', async () => {
    const seed = fx.repo('info-remote-only-seed');
    const clone = path.join(fx.root, 'info-remote-only');
    fx.git(fx.root, ['clone', '-q', seed, clone]);
    fx.git(clone, ['checkout', '-q', '-b', 'work']);
    fx.git(clone, ['branch', '-q', '-D', 'main']);
    const info = await core.readRepositoryInfo?.(await locate(clone), {
      defaultBranch: 'origin/main',
    });
    expect(info?.defaultBranch?.name).toBe('origin/main');
    expect(info?.defaultBranch?.head?.subject).toBe('initial');
    expect(info?.defaultBranch?.ahead).toBeNull();
  });
});
