import {
  type GitBranchInfo,
  type GitRepositoryInfo,
  MAX_LISTED_BRANCHES,
  type ProjectLocator,
  RefNameSchema,
} from '@octopus-diff/contracts';
import { bstrFromBuffer, bstrToUtf8 } from './bstr.js';
import type { GitContext } from './context.js';
import { detectDefaultBranchRef, projectRepoFor } from './discovery.js';
import { forEachRefFormat, parseForEachRef } from './parse/refs.js';
import { readRemoteConfig } from './remotes.js';

/**
 * Local facts for the Overview (docs/FORGES.md "Repository information"). Read-only and cheap:
 * one `for-each-ref` over branches and tags (which also lists the branches with their upstream
 * tracking), one `for-each-ref --merged` for the branches merged into the default branch, one
 * `log -1` for the default branch's head, one `rev-list --left-right --count` against its
 * upstream (local refs only: as of the last fetch), and the remote config read the forge
 * integration already does. Nothing is fetched.
 */

const SCP_LIKE = /^[^/@:]+@[^/:]+:/;

/**
 * Removes credentials from a remote URL. For http(s), ftp(s) and git URLs the whole userinfo is
 * dropped (a token is often passed as the user name: `https://<token>@github.com/...`); for ssh
 * URLs only a password is dropped (`ssh://git@host` keeps its login). scp-like `git@host:path`
 * has no password slot and is returned unchanged.
 */
export function stripUrlCredentials(url: string): string {
  if (SCP_LIKE.test(url)) return url;
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)(.*)$/s.exec(url);
  if (!match) return url;
  const [, scheme = '', authority = '', rest = ''] = match;
  const at = authority.lastIndexOf('@');
  if (at === -1) return url;
  const userinfo = authority.slice(0, at);
  const host = authority.slice(at + 1);
  const lower = scheme.toLowerCase();
  if (lower === 'ssh' || lower === 'git+ssh' || lower === 'ssh+git') {
    const colon = userinfo.indexOf(':');
    const user = colon === -1 ? userinfo : userinfo.slice(0, colon);
    return `${scheme}://${user ? `${user}@` : ''}${host}${rest}`;
  }
  return `${scheme}://${host}${rest}`;
}

function isoOrNull(value: string | undefined): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

const HEAD_FORMAT = '%H%x00%s%x00%an%x00%aI';

/**
 * Parses `%(upstream:track,nobracket)`: `ahead 2, behind 1`, `ahead 2`, `behind 1`, `gone`, or
 * empty when in sync (or without an upstream).
 */
export function parseUpstreamTrack(track: string): {
  gone: boolean;
  ahead: number;
  behind: number;
} {
  if (track.trim() === 'gone') return { gone: true, ahead: 0, behind: 0 };
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  return { gone: false, ahead: Number(ahead?.[1] ?? 0), behind: Number(behind?.[1] ?? 0) };
}

function shortUpstream(ref: string): string {
  return ref.replace(/^refs\/remotes\//, '').replace(/^refs\/heads\//, '');
}

export async function readRepositoryInfo(
  ctx: GitContext,
  project: ProjectLocator,
  options: { defaultBranch?: string | null } = {},
): Promise<GitRepositoryInfo> {
  const repo = await projectRepoFor(ctx, project);
  const refs = await ctx.git(repo, [
    'for-each-ref',
    `--format=${forEachRefFormat([
      'refname',
      'objectname',
      'committerdate:iso-strict',
      'upstream',
      'upstream:track,nobracket',
      'contents:subject',
    ])}`,
    'refs/heads/',
    'refs/tags/',
  ]);
  const rows = parseForEachRef(bstrToUtf8(bstrFromBuffer(refs.stdout)), 6);
  const heads = new Map<string, { oid: string; upstream: string | null }>();
  const branches: Array<GitBranchInfo & { time: number }> = [];
  let tags = 0;
  let last: number | null = null;
  for (const [refname = '', oid = '', date = '', upstream = '', track = '', subject = ''] of rows) {
    if (refname.startsWith('refs/tags/')) {
      tags += 1;
      continue;
    }
    if (!refname.startsWith('refs/heads/')) continue;
    const branch = refname.slice('refs/heads/'.length);
    heads.set(branch, { oid, upstream: upstream || null });
    const time = Date.parse(date);
    if (!Number.isNaN(time) && (last === null || time > last)) last = time;
    if (!/^[0-9a-f]{40,64}$/.test(oid)) continue;
    const tracking = parseUpstreamTrack(track);
    const known = upstream !== '' && !tracking.gone;
    branches.push({
      name: branch,
      sha: oid,
      subject,
      committerDate: Number.isNaN(time) ? null : new Date(time).toISOString(),
      upstream: upstream ? shortUpstream(upstream) : null,
      upstreamGone: upstream !== '' && tracking.gone,
      ahead: known ? tracking.ahead : null,
      behind: known ? tracking.behind : null,
      merged: null,
      time: Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time,
    });
  }

  // The effective default branch: the project's (override or detected), else detect now.
  let name = options.defaultBranch ?? null;
  let oid: string | null = null;
  if (name === null) {
    const detected = await detectDefaultBranchRef(ctx, repo);
    if (detected) {
      name = detected.name;
      oid = detected.oid;
    }
  }
  let defaultBranch: GitRepositoryInfo['defaultBranch'] = null;
  if (name !== null && RefNameSchema.safeParse(name).success) {
    const local = heads.get(name);
    oid ??= local?.oid ?? null;
    if (oid === null) {
      const resolved = await ctx.git(
        repo,
        ['rev-parse', '--verify', '--quiet', `refs/remotes/${name}^{commit}`],
        { okExitCodes: [0, 1, 128] },
      );
      const text = resolved.stdout.toString('utf8').trim();
      oid = /^[0-9a-f]{40,64}$/.test(text) ? text : null;
    }
    let head: NonNullable<GitRepositoryInfo['defaultBranch']>['head'] = null;
    if (oid !== null) {
      const log = await ctx.git(repo, ['log', '-1', `--format=${HEAD_FORMAT}`, oid, '--']);
      const [sha = '', subject = '', authorName = '', authorDate = ''] = log.stdout
        .toString('utf8')
        .replace(/\n$/, '')
        .split('\u0000');
      const date = isoOrNull(authorDate);
      if (/^[0-9a-f]{40,64}$/.test(sha) && date !== null) {
        head = { sha, subject, authorName, authorDate: date };
      }
    }
    const upstreamRef = local?.upstream ?? null;
    let ahead: number | null = null;
    let behind: number | null = null;
    if (local && upstreamRef) {
      const counted = await ctx.git(
        repo,
        ['rev-list', '--left-right', '--count', `refs/heads/${name}...${upstreamRef}`, '--'],
        // 128: the upstream ref is gone (deleted on the remote and pruned).
        { okExitCodes: [0, 128] },
      );
      const match = /^(\d+)\s+(\d+)/.exec(counted.stdout.toString('utf8'));
      if (counted.exitCode === 0 && match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
    }
    defaultBranch = {
      name,
      head,
      upstream: upstreamRef ? shortUpstream(upstreamRef) : null,
      ahead,
      behind,
    };
    if (oid !== null) {
      // Branches whose tip is reachable from the default branch's commit: merged into it.
      const merged = await ctx.git(repo, [
        'for-each-ref',
        '--format=%(refname)',
        `--merged=${oid}`,
        'refs/heads/',
      ]);
      const names = new Set(
        bstrToUtf8(bstrFromBuffer(merged.stdout))
          .split('\n')
          .filter((line) => line.startsWith('refs/heads/'))
          .map((line) => line.slice('refs/heads/'.length)),
      );
      for (const b of branches) b.merged = names.has(b.name);
    }
  }
  branches.sort((a, b) => b.time - a.time || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const config = await readRemoteConfig(ctx, project);
  return {
    defaultBranch,
    localBranches: heads.size,
    tags,
    remotes: config.remotes.map((r) => ({
      name: r.name,
      url: r.url === null ? null : stripUrlCredentials(r.url),
      pushUrl: r.pushUrl === null ? null : stripUrlCredentials(r.pushUrl),
    })),
    lastActivityAt: last === null ? null : new Date(last).toISOString(),
    branches: branches.slice(0, MAX_LISTED_BRANCHES).map(({ time: _time, ...b }) => b),
  };
}
