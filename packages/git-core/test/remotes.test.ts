import type { GitCore } from '@octopus-diff/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGitCore, parseRemoteConfig, rewriteUrl } from '../src/index.js';
import { createFixture, type Fixture } from './helpers/fixture.js';

describe('parseRemoteConfig', () => {
  it('reads remotes, branch tracking, pushDefault and applies insteadOf rewrites', () => {
    const output = [
      'remote.origin.url\ngh:me/app',
      'remote.origin.url\nhttps://mirror.example/app.git',
      'remote.Upstream.url\ngit@github.com:org/app.git',
      'remote.Upstream.gh-resolved\nbase',
      'remote.fork.url\nhttps://github.com/me/app.git',
      'remote.fork.pushurl\nwork:me/app.git',
      'remote.pushdefault\nfork',
      'branch.feature/x.y.remote\norigin',
      'branch.feature/x.y.merge\nrefs/heads/feature/x.y',
      'branch.feature/x.y.pushremote\nfork',
      'url.git@github.com:.insteadof\ngh:',
      'url.git@github.com:.insteadof\ng:',
      'url.git@github-work:.insteadof\nwork:',
      'url.ssh://git@github.com/.pushinsteadof\nhttps://github.com/',
      'remote.bare\n',
      '',
    ].join('\u0000');
    const config = parseRemoteConfig(output);
    expect(config.pushDefault).toBe('fork');
    expect(config.remotes).toEqual([
      { name: 'origin', url: 'git@github.com:me/app', pushUrl: null, ghResolved: null },
      { name: 'Upstream', url: 'git@github.com:org/app.git', pushUrl: null, ghResolved: 'base' },
      {
        name: 'fork',
        url: 'https://github.com/me/app.git',
        pushUrl: 'git@github-work:me/app.git',
        ghResolved: null,
      },
    ]);
    expect(config.branches['feature/x.y']).toEqual({
      remote: 'origin',
      merge: 'refs/heads/feature/x.y',
      pushRemote: 'fork',
    });
  });

  it('uses the longest matching insteadOf prefix', () => {
    const rules = [
      { base: 'A/', prefix: 'x' },
      { base: 'B/', prefix: 'xy' },
    ];
    expect(rewriteUrl('xyz', rules)).toBe('B/z');
    expect(rewriteUrl('qq', rules)).toBeNull();
  });

  it('returns empty config for empty output', () => {
    expect(parseRemoteConfig('')).toEqual({ remotes: [], branches: {}, pushDefault: null });
  });
});

describe('readRemoteConfig', () => {
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

  it('reads a real repository without contacting any remote', async () => {
    const main = fx.repo('remotes-app');
    const resolved = await core.resolveProject(main);
    const locator = { id: resolved.project.id, commonDir: resolved.project.commonDir };
    expect(await core.readRemoteConfig?.(locator)).toEqual({
      remotes: [],
      branches: {},
      pushDefault: null,
    });
    fx.git(main, ['remote', 'add', 'origin', 'git@gitlab.example.com:group/sub/app.git']);
    fx.git(main, ['config', 'branch.main.remote', 'origin']);
    fx.git(main, ['config', 'branch.main.merge', 'refs/heads/main']);
    const config = await core.readRemoteConfig?.(locator);
    expect(config?.remotes).toEqual([
      {
        name: 'origin',
        url: 'git@gitlab.example.com:group/sub/app.git',
        pushUrl: null,
        ghResolved: null,
      },
    ]);
    expect(config?.branches.main).toEqual({
      remote: 'origin',
      merge: 'refs/heads/main',
      pushRemote: null,
    });
  });
});
