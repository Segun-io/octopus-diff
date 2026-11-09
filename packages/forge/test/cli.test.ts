import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertAllowedForgeArgs,
  buildGithubQuery,
  buildGitlabQuery,
  ForgeCli,
  ForgeCliError,
  ForgeClient,
  forgeEnv,
} from '../src/index.js';

const gh = (q = buildGithubQuery(1)) => [
  'api',
  'graphql',
  '--hostname',
  'github.com',
  '--raw-field',
  `query=${q}`,
  '--raw-field',
  'owner=o',
  '--raw-field',
  'name=r',
  '--raw-field',
  'b0=feat/x',
];

describe('assertAllowedForgeArgs', () => {
  it('allows the built-in read-only invocations', () => {
    expect(() => assertAllowedForgeArgs('github', ['--version'])).not.toThrow();
    expect(() => assertAllowedForgeArgs('github', ['auth', 'status'])).not.toThrow();
    expect(() => assertAllowedForgeArgs('gitlab', ['auth', 'status', '--all'])).not.toThrow();
    expect(() =>
      assertAllowedForgeArgs('gitlab', ['auth', 'status', '--hostname', 'git.acme.io']),
    ).not.toThrow();
    expect(() => assertAllowedForgeArgs('github', gh())).not.toThrow();
    const gl = [
      'api',
      'graphql',
      '--hostname',
      'gitlab.com',
      '--raw-field',
      `query=${buildGitlabQuery(2, 'basic')}`,
      '--raw-field',
      'fullPath=g/s/p',
      '--raw-field',
      'b0=a',
      '--raw-field',
      'b1=b',
    ];
    expect(() => assertAllowedForgeArgs('gitlab', gl)).not.toThrow();
  });

  it.each([
    [['pr', 'merge', '1']],
    [['auth', 'token']],
    [['auth', 'status', '--show-token']],
    [['auth', 'status', '--all']],
    [['api', 'repos/o/r/pulls']],
    [['api', 'graphql', '--hostname', 'github.com', '--raw-field', 'query=mutation { x }']],
    [['api', 'graphql', '--hostname', 'evil.com/x', '--raw-field', `query=${buildGithubQuery(1)}`]],
    [gh(buildGithubQuery(2))],
    [[...gh(), '--method', 'POST']],
    [[...gh(), '-F', 'x=@/etc/passwd']],
    [[...gh().slice(0, 10), '--raw-field', 'name=r']],
    [[...gh().slice(0, 12), '--raw-field', 'b0=dup']],
    [[...gh().slice(0, 11), 'b0=line\nbreak']],
    [['--version', '--help']],
  ])('denies %j', (args) => {
    expect(() => assertAllowedForgeArgs('github', args)).toThrow(ForgeCliError);
  });
});

describe('forgeEnv', () => {
  const base = {
    PATH: '/usr/bin',
    HOME: '/home/u',
    GH_TOKEN: 'dotcom',
    GH_ENTERPRISE_TOKEN: 'ent',
    GH_HOST: 'ghe.acme.io',
    GH_REPO: 'x/y',
    GH_DEBUG: 'api',
    GITLAB_TOKEN: 'gl',
  };

  it('keeps GH_TOKEN for github.com only and GH_ENTERPRISE_TOKEN for GH_HOST only', () => {
    const dotcom = forgeEnv('github', 'github.com', base);
    expect(dotcom.GH_TOKEN).toBe('dotcom');
    expect(dotcom.GH_ENTERPRISE_TOKEN).toBeUndefined();
    expect(dotcom.GH_REPO).toBeUndefined();
    expect(dotcom.GH_DEBUG).toBeUndefined();
    expect(dotcom.GH_HOST).toBeUndefined();
    expect(dotcom.GH_PROMPT_DISABLED).toBe('1');
    const ent = forgeEnv('github', 'ghe.acme.io', base);
    expect(ent.GH_ENTERPRISE_TOKEN).toBe('ent');
    expect(ent.GH_TOKEN).toBeUndefined();
    const evil = forgeEnv('github', 'github.evil.io', base);
    expect(evil.GH_ENTERPRISE_TOKEN).toBeUndefined();
    expect(evil.GH_TOKEN).toBeUndefined();
  });

  it('keeps GITLAB_TOKEN only for its own host (gitlab.com unless GITLAB_HOST says otherwise)', () => {
    expect(forgeEnv('gitlab', 'gitlab.com', base).GITLAB_TOKEN).toBe('gl');
    const other = forgeEnv('gitlab', 'gitlab.evil.io', base);
    expect(other.GITLAB_TOKEN).toBeUndefined();
    expect(other.GITLAB_HOST).toBe('gitlab.evil.io');
    expect(other.GLAB_NO_PROMPT).toBe('1');
    const corp = forgeEnv('gitlab', 'git.acme.io', { ...base, GITLAB_HOST: 'https://git.acme.io' });
    expect(corp.GITLAB_TOKEN).toBe('gl');
  });
});

describe('ForgeCli and ForgeClient with a fake CLI', () => {
  let dir: string;
  let log: string;
  let fakeGh: string;
  let fakeGlab: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'octopus-diff-'));
    log = path.join(dir, 'calls.jsonl');
    const script = (name: string) => {
      const file = path.join(dir, name);
      writeFileSync(
        file,
        `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ name: ${JSON.stringify(name)}, args, cwd: process.cwd(), env: { GH_TOKEN: process.env.GH_TOKEN ?? null, GITLAB_HOST: process.env.GITLAB_HOST ?? null, NO_COLOR: process.env.NO_COLOR ?? null } }) + '\\n');
const mode = process.env.FAKE_MODE ?? 'ok';
if (args[0] === '--version') { console.log(${JSON.stringify(name)} + ' version 9.9.9'); process.exit(0); }
if (args[0] === 'auth') {
  if (${JSON.stringify(name)} === 'glab' && args.includes('--all') && mode === 'old-glab') { console.error('unknown flag: --all'); process.exit(1); }
  if (mode === 'signed-out') { console.error('You are not logged into any GitHub hosts. To log in, run: gh auth login'); process.exit(1); }
  console.error('github.com\\n  ✓ Logged in to github.com account octo (keyring)\\n  - Token: gho_****');
  process.exit(0);
}
if (args[0] === 'api') {
  const query = args[args.indexOf('--raw-field') + 1].slice(6);
  if (mode === 'unknown-field' && query.includes('detailedMergeStatus')) {
    console.log(JSON.stringify({ errors: [{ message: "Field 'detailedMergeStatus' doesn't exist on type 'MergeRequest'" }] }));
    process.exit(1);
  }
  if (mode === 'slow') { setTimeout(() => {}, 10000); return; }
  if (mode === 'error') { console.error('gh: HTTP 502: Bad Gateway'); process.exit(1); }
  const key = ${JSON.stringify(name)} === 'gh' ? 'repository' : 'project';
  const node = ${JSON.stringify(name)} === 'gh'
    ? { number: 7, title: 'T', url: 'https://github.com/o/r/pull/7', state: 'OPEN', isDraft: true, updatedAt: '2026-11-08T10:00:00Z', baseRefName: 'main', headRefName: 'feat/x', headRefOid: 'a'.repeat(40), isCrossRepository: false, author: { login: 'octo' }, headRepository: { nameWithOwner: 'o/r' }, reviewDecision: 'APPROVED', mergeable: 'UNKNOWN', totalCommentsCount: 1, commits: { nodes: [] } }
    : { iid: '9', title: 'M', webUrl: 'https://gitlab.com/g/p/-/merge_requests/9', state: 'merged', draft: false, updatedAt: '2026-11-08T10:00:00Z', targetBranch: 'main', sourceBranch: 'feat/x', diffHeadSha: 'b'.repeat(40), author: { username: 'octo' }, sourceProject: { fullPath: 'g/p' }, targetProject: { fullPath: 'g/p' }, userNotesCount: 0, headPipeline: null };
  console.log(JSON.stringify({ data: { [key]: { b0: { nodes: [node] } } } }));
  process.exit(0);
}
process.exit(2);
`,
      );
      chmodSync(file, 0o755);
      return file;
    };
    fakeGh = script('gh');
    fakeGlab = script('glab');
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const calls = () =>
    readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map(
        (l) =>
          JSON.parse(l) as {
            name: string;
            args: string[];
            cwd: string;
            env: Record<string, string | null>;
          },
      );

  const client = (mode: string, timeoutMs = 5_000) =>
    new ForgeClient(
      new ForgeCli({
        binaries: { github: fakeGh, gitlab: fakeGlab },
        cwd: dir,
        env: { ...process.env, FAKE_MODE: mode, GH_TOKEN: 'secret' },
        timeoutMs,
      }),
    );

  it('probes version and auth', async () => {
    const status = await client('ok').probe('github');
    expect(status).toMatchObject({
      available: true,
      version: 'gh version 9.9.9',
      auth: 'authenticated',
      accounts: [{ host: 'github.com', account: 'octo' }],
    });
    const signedOut = await client('signed-out').probe('github');
    expect(signedOut).toMatchObject({ auth: 'unauthenticated', accounts: [] });
    expect(signedOut.detail).toContain('not logged into any GitHub hosts');
  });

  it('retries glab auth status without --all on old glab', async () => {
    const status = await client('old-glab').probe('gitlab');
    expect(status.auth).toBe('authenticated');
    const authCalls = calls().filter((c) => c.name === 'glab' && c.args[0] === 'auth');
    expect(authCalls.slice(-2).map((c) => c.args)).toEqual([
      ['auth', 'status', '--all'],
      ['auth', 'status'],
    ]);
  });

  it('reports a missing CLI', async () => {
    const missing = new ForgeClient(
      new ForgeCli({ binaries: { github: path.join(dir, 'nope') }, cwd: dir }),
    );
    expect(await missing.probe('github')).toMatchObject({ available: false, auth: 'unknown' });
  });

  it('fetches pull requests in the neutral cwd with a hardened env', async () => {
    const result = await client('ok').fetchChangeRequests(
      { kind: 'github', host: 'github.com', repository: 'o/r' },
      ['feat/x'],
    );
    expect(result.get('feat/x')?.[0]).toMatchObject({
      number: 7,
      draft: true,
      review: 'approved',
      conflicts: null,
    });
    const call = calls().at(-1);
    expect(call?.cwd).toBe(dir);
    expect(call?.env).toEqual({ GH_TOKEN: 'secret', GITLAB_HOST: null, NO_COLOR: '1' });
    expect(call?.args.slice(0, 4)).toEqual(['api', 'graphql', '--hostname', 'github.com']);
  });

  it('falls back to the basic GitLab query on unknown fields', async () => {
    const result = await client('unknown-field').fetchChangeRequests(
      { kind: 'gitlab', host: 'gitlab.com', repository: 'g/p' },
      ['feat/x'],
    );
    expect(result.get('feat/x')?.[0]).toMatchObject({ kind: 'gitlab', number: 9, state: 'merged' });
    const queries = calls()
      .filter((c) => c.name === 'glab' && c.args[0] === 'api')
      .slice(-2)
      .map((c) => c.args[5]?.includes('detailedMergeStatus'));
    expect(queries).toEqual([true, false]);
    expect(calls().at(-1)?.env.GITLAB_HOST).toBe('gitlab.com');
  });

  it('surfaces errors and timeouts as ForgeFetchError', async () => {
    await expect(
      client('error').fetchChangeRequests(
        { kind: 'github', host: 'github.com', repository: 'o/r' },
        ['feat/x'],
      ),
    ).rejects.toThrow('HTTP 502: Bad Gateway');
    await expect(
      client('slow', 300).fetchChangeRequests(
        { kind: 'github', host: 'github.com', repository: 'o/r' },
        ['feat/x'],
      ),
    ).rejects.toThrow(/timed out/);
  });
});
