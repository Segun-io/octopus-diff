import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ChangeRequestSchema } from '@octopus-diff/contracts';
import { describe, expect, it } from 'vitest';
import {
  classifyHost,
  firstSafeLine,
  forgeFromHostname,
  isUnknownFieldError,
  parseAuthStatus,
  parseGithubResponse,
  parseGitlabResponse,
  parseRemoteUrl,
  parseSshConfigAliases,
} from '../src/index.js';

const fixture = (name: string) =>
  readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8');

describe('parseRemoteUrl', () => {
  it.each([
    ['git@github.com:pingdotgg/t3code.git', 'github.com', 'pingdotgg/t3code', true],
    ['github.com:me/app', 'github.com', 'me/app', true],
    ['https://github.com/me/app', 'github.com', 'me/app', false],
    ['https://user@github.com/me/app.git/', 'github.com', 'me/app', false],
    [
      'ssh://git@gitlab.example.com:2222/group/sub/app.git',
      'gitlab.example.com',
      'group/sub/app',
      true,
    ],
    [
      'https://gitlab.example.com:8443/group/app.git',
      'gitlab.example.com:8443',
      'group/app',
      false,
    ],
    ['git@GitHub-Work:Me/App.git', 'github-work', 'Me/App', true],
  ])('%s', (url, host, repo, ssh) => {
    expect(parseRemoteUrl(url)).toMatchObject({ host, path: repo, ssh });
  });

  it.each([
    '/srv/git/app.git',
    './app',
    'C:\\repos\\app',
    'C:/repos/app',
    'file:///srv/git/app.git',
    'https://github.com/app',
    'https://github.com/a/../b',
    '-oProxyCommand=evil:me/app',
    'https://evil.example/a/b?x=1#y',
    'ext::sh -c touch% /tmp/pwned',
    '',
  ])('rejects %s', (url) => {
    const parsed = parseRemoteUrl(url);
    if (url.startsWith('https://evil.example')) {
      // Query and fragment are not part of the path.
      expect(parsed?.path).toBe('a/b');
      return;
    }
    expect(parsed).toBeNull();
  });
});

describe('host classification', () => {
  it('recognises forges from the hostname', () => {
    expect(forgeFromHostname('github.com')).toBe('github');
    expect(forgeFromHostname('acme.ghe.com')).toBe('github');
    expect(forgeFromHostname('github.acme.internal')).toBe('github');
    expect(forgeFromHostname('gitlab.com')).toBe('gitlab');
    expect(forgeFromHostname('gitlab.acme.io:8443')).toBe('gitlab');
    expect(forgeFromHostname('git.acme.io')).toBeNull();
    expect(forgeFromHostname('notgithub.com')).toBeNull();
  });

  it('uses settings first, then the hostname, then CLI logins', () => {
    const logins = { github: new Set(['code.acme.io']), gitlab: new Set(['git.acme.io']) };
    expect(classifyHost({ host: 'git.acme.io', overrides: {}, logins })).toEqual({
      kind: 'gitlab',
      detectedBy: 'cli-login',
    });
    expect(classifyHost({ host: 'code.acme.io', overrides: {}, logins })).toEqual({
      kind: 'github',
      detectedBy: 'cli-login',
    });
    expect(classifyHost({ host: 'other.io', overrides: {}, logins })).toEqual({
      kind: null,
      ignored: false,
    });
    expect(
      classifyHost({ host: 'github.com', overrides: { 'github.com': 'none' }, logins }),
    ).toEqual({ kind: null, ignored: true });
    expect(
      classifyHost({ host: 'src.acme.io', overrides: { 'src.acme.io': 'gitlab' }, logins }),
    ).toEqual({ kind: 'gitlab', detectedBy: 'setting' });
  });
});

describe('ssh config aliases', () => {
  it('maps literal Host aliases to HostName', () => {
    const aliases = parseSshConfigAliases(`
# work account
Host github-work gh-work
  HostName github.com
  IdentityFile ~/.ssh/work
Host *.internal
  HostName jump.internal
Host corp-gitlab
  HostName=GitLab.Corp.Example
Match host foo
  HostName bar
Host proxied
  HostName %h.example
`);
    expect(Object.fromEntries(aliases)).toEqual({
      'github-work': 'github.com',
      'gh-work': 'github.com',
      'corp-gitlab': 'gitlab.corp.example',
    });
  });
});

describe('auth status', () => {
  it('parses gh 2.46 output', () => {
    expect(parseAuthStatus(fixture('gh-auth-status-2.46.txt'))).toEqual([
      { host: 'github.com', account: 'octo' },
    ]);
  });

  it('parses older gh output and skips failed hosts', () => {
    expect(parseAuthStatus(fixture('gh-auth-status-old.txt'))).toEqual([
      { host: 'github.com', account: 'octo' },
    ]);
  });

  it('parses glab output with several hosts', () => {
    expect(parseAuthStatus(fixture('glab-auth-status.txt'))).toEqual([
      { host: 'gitlab.com', account: 'octo' },
      { host: 'git.corp.example', account: 'jdoe' },
    ]);
  });

  it('never surfaces a token line', () => {
    expect(firstSafeLine('  ✓ Token: gho_abc\n  x not logged in')).toBe('not logged in');
    expect(parseAuthStatus('You are not logged into any GitHub hosts.')).toEqual([]);
  });
});

describe('GitHub normalisation (real response)', () => {
  const json = JSON.parse(fixture('github-batch.json')) as Record<string, unknown>;
  const result = parseGithubResponse(json, ['fix/pr-watch-merge-wake', 'main']);

  it('maps a fork pull request with failing checks', () => {
    const [pr] = result.byBranch.get('fix/pr-watch-merge-wake') ?? [];
    expect(pr).toBeDefined();
    expect(ChangeRequestSchema.parse(pr)).toEqual(pr);
    expect(pr).toMatchObject({
      kind: 'github',
      number: 33201,
      state: 'open',
      draft: false,
      baseBranch: 'main',
      headBranch: 'fix/pr-watch-merge-wake',
      crossRepository: true,
      headRepository: 'soorria/t3code',
      conflicts: false,
      checks: { state: 'failure', passed: 30, failed: 1, pending: 0, total: 31 },
    });
    expect(result.errors).toEqual([]);
    expect(result.notFound).toBe(false);
  });

  it('keeps every request named like the branch (matching filters them later)', () => {
    expect(result.byBranch.get('main')?.length).toBe(2);
  });

  it('reports a missing repository', () => {
    const missing = parseGithubResponse(
      {
        data: { repository: null },
        errors: [
          { type: 'NOT_FOUND', message: "Could not resolve to a Repository with the name 'a/b'." },
        ],
      },
      ['x'],
    );
    expect(missing.notFound).toBe(true);
    expect(missing.byBranch.get('x')).toEqual([]);
  });
});

describe('GitLab normalisation (real response)', () => {
  const json = JSON.parse(fixture('gitlab-batch.json')) as Record<string, unknown>;
  const result = parseGitlabResponse(json, ['theoretick/oauth-forget-dead-refresh-token', 'main']);

  it('maps an open merge request with requested changes and a failed pipeline', () => {
    const [mr] = result.byBranch.get('theoretick/oauth-forget-dead-refresh-token') ?? [];
    expect(mr).toBeDefined();
    expect(ChangeRequestSchema.parse(mr)).toEqual(mr);
    expect(mr).toMatchObject({
      kind: 'gitlab',
      number: 4242,
      state: 'open',
      crossRepository: false,
      headRepository: 'gitlab-org/cli',
      review: 'changes_requested',
      conflicts: false,
      checks: { state: 'failure', passed: null, total: null },
      comments: 29,
    });
  });

  it('treats a deleted source project as another repository', () => {
    const [deleted, fork] = result.byBranch.get('main') ?? [];
    expect(deleted).toMatchObject({ state: 'closed', headRepository: null, crossRepository: true });
    expect(fork).toMatchObject({ headRepository: 'physics-enthusiast/cli', crossRepository: true });
  });

  it('reports a missing project and unknown-field errors', () => {
    expect(parseGitlabResponse({ data: { project: null } }, ['x']).notFound).toBe(true);
    expect(
      isUnknownFieldError(["Field 'detailedMergeStatus' doesn't exist on type 'MergeRequest'"]),
    ).toBe(true);
  });
});
