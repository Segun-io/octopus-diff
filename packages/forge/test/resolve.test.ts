import type { ChangeRequest, GitRemoteConfig } from '@octopus-diff/contracts';
import { describe, expect, it } from 'vitest';
import { pickChangeRequest, resolveBranchHead, resolveProjectForge } from '../src/index.js';

const none = { github: new Set<string>(), gitlab: new Set<string>() };
const ctx = (extra: Partial<Parameters<typeof resolveProjectForge>[1]> = {}) => ({
  overrides: {},
  logins: none,
  sshAliases: new Map<string, string>(),
  ...extra,
});
const remote = (name: string, url: string, ghResolved: string | null = null) => ({
  name,
  url,
  pushUrl: null,
  ghResolved,
});
const config = (
  remotes: GitRemoteConfig['remotes'],
  branches: GitRemoteConfig['branches'] = {},
  pushDefault: string | null = null,
): GitRemoteConfig => ({ remotes, branches, pushDefault });

describe('resolveProjectForge', () => {
  it('picks origin on GitHub', () => {
    expect(
      resolveProjectForge(config([remote('origin', 'git@github.com:me/app.git')]), ctx()),
    ).toEqual({
      forge: {
        kind: 'github',
        host: 'github.com',
        repository: 'me/app',
        webUrl: 'https://github.com/me/app',
        remoteName: 'origin',
        detectedBy: 'hostname',
      },
    });
  });

  it('prefers upstream for forks, and a gh-resolved mark over everything', () => {
    const fork = config([
      remote('origin', 'git@github.com:me/app.git'),
      remote('upstream', 'https://github.com/org/app.git'),
    ]);
    expect(resolveProjectForge(fork, ctx()).forge?.repository).toBe('org/app');
    const marked = config([
      remote('origin', 'git@github.com:me/app.git', 'base'),
      remote('upstream', 'https://github.com/org/app.git'),
    ]);
    expect(resolveProjectForge(marked, ctx()).forge?.repository).toBe('me/app');
    const named = config([
      remote('origin', 'git@github.com:me/app.git', 'other/app'),
      remote('upstream', 'https://github.com/org/app.git'),
    ]);
    expect(resolveProjectForge(named, ctx()).forge?.repository).toBe('other/app');
  });

  it('recognises self-hosted GitLab by CLI login and ssh aliases', () => {
    const cfg = config([remote('origin', 'git@code-host:group/sub/app.git')]);
    expect(resolveProjectForge(cfg, ctx())).toEqual({
      forge: null,
      reason: 'unsupported',
      host: 'code-host',
    });
    const resolved = resolveProjectForge(
      cfg,
      ctx({
        sshAliases: new Map([['code-host', 'git.acme.io']]),
        logins: { github: new Set(), gitlab: new Set(['git.acme.io']) },
      }),
    );
    expect(resolved.forge).toMatchObject({
      kind: 'gitlab',
      host: 'git.acme.io',
      repository: 'group/sub/app',
      detectedBy: 'cli-login',
    });
  });

  it('rejects nested paths on GitHub, honours "none", reports no remotes', () => {
    expect(
      resolveProjectForge(config([remote('origin', 'https://github.com/a/b/c')]), ctx()).forge,
    ).toBeNull();
    expect(
      resolveProjectForge(
        config([remote('origin', 'https://github.com/a/b')]),
        ctx({ overrides: { 'github.com': 'none' } }),
      ),
    ).toEqual({ forge: null, reason: 'ignored', host: 'github.com' });
    expect(resolveProjectForge(config([]), ctx())).toEqual({
      forge: null,
      reason: 'no-remote',
      host: null,
    });
  });
});

describe('resolveBranchHead', () => {
  const forge = { kind: 'github' as const, host: 'github.com' };
  it('uses the tracked branch name when pushing to the tracked remote', () => {
    const cfg = config([remote('origin', 'git@github.com:me/app.git')], {
      local: { remote: 'origin', merge: 'refs/heads/feature/remote-name', pushRemote: null },
    });
    expect(resolveBranchHead('local', cfg, forge, new Map())).toEqual({
      headBranch: 'feature/remote-name',
      pushRepository: 'me/app',
    });
  });

  it('follows pushRemote / pushDefault to a fork', () => {
    const cfg = config(
      [remote('origin', 'git@github.com:org/app.git'), remote('mine', 'git@github.com:me/app.git')],
      { feat: { remote: 'origin', merge: 'refs/heads/main', pushRemote: null } },
      'mine',
    );
    expect(resolveBranchHead('feat', cfg, forge, new Map())).toEqual({
      headBranch: 'feat',
      pushRepository: 'me/app',
    });
  });

  it('has no push repository when the push remote is elsewhere', () => {
    const cfg = config([remote('origin', 'https://gitlab.com/me/app')]);
    expect(resolveBranchHead('feat', cfg, forge, new Map()).pushRepository).toBeNull();
  });
});

describe('pickChangeRequest', () => {
  const cr = (over: Partial<ChangeRequest>): ChangeRequest => ({
    kind: 'github',
    number: 1,
    title: 't',
    url: 'https://github.com/org/app/pull/1',
    state: 'open',
    draft: false,
    author: null,
    baseBranch: 'main',
    headBranch: 'feat',
    headSha: null,
    crossRepository: false,
    headRepository: 'org/app',
    updatedAt: '2026-11-01T00:00:00.000Z',
    checks: null,
    review: null,
    conflicts: null,
    comments: null,
    ...over,
  });

  it('ignores same-named branches from other forks', () => {
    const list = [
      cr({ number: 1, crossRepository: true, headRepository: 'stranger/app' }),
      cr({ number: 2, crossRepository: true, headRepository: 'me/app', state: 'merged' }),
    ];
    expect(
      pickChangeRequest(list, { headBranch: 'feat', pushRepository: 'me/app' }, 'org/app')?.number,
    ).toBe(2);
    expect(
      pickChangeRequest(list, { headBranch: 'feat', pushRepository: null }, 'org/app'),
    ).toBeNull();
  });

  it('prefers an open request over newer merged or closed ones', () => {
    const list = [
      cr({ number: 3, state: 'closed', updatedAt: '2026-11-07T00:00:00.000Z' }),
      cr({ number: 4, state: 'open', updatedAt: '2026-11-02T00:00:00.000Z' }),
      cr({ number: 5, state: 'merged', updatedAt: '2026-11-06T00:00:00.000Z' }),
    ];
    const head = { headBranch: 'feat', pushRepository: 'org/app' };
    expect(pickChangeRequest(list, head, 'org/app')?.number).toBe(4);
    expect(
      pickChangeRequest(
        list.filter((c) => c.number !== 4),
        head,
        'org/app',
      )?.number,
    ).toBe(3);
  });
});
