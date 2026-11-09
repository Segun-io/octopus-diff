import type {
  GitBranchConfig,
  GitRemote,
  GitRemoteConfig,
  ProjectLocator,
} from '@octopus-diff/contracts';
import type { GitContext } from './context.js';
import { projectRepoFor } from './discovery.js';

/**
 * Remote and branch-tracking config for the forge integration (docs/FORGES.md). One
 * `git config --null --get-regexp` read over every config scope; nothing is fetched and no remote
 * is contacted. `url.<base>.insteadOf` / `pushInsteadOf` rewrites are applied here, the way
 * `git remote get-url` would, so the forge layer sees the URL git actually uses.
 */

/** Keys are canonical in `--get-regexp` output: section and variable lower case. */
export const REMOTE_CONFIG_REGEX =
  '^(remote\\..*\\.(url|pushurl|gh-resolved)|remote\\.pushdefault|branch\\..*\\.(remote|merge|pushremote)|url\\..*\\.(insteadof|pushinsteadof))$';

interface RewriteRule {
  base: string;
  prefix: string;
}

/** Splits `section.sub.section.variable` (the subsection may contain dots). */
function splitKey(key: string): { section: string; sub: string | null; variable: string } | null {
  const first = key.indexOf('.');
  const last = key.lastIndexOf('.');
  if (first === -1) return null;
  const section = key.slice(0, first);
  if (first === last) return { section, sub: null, variable: key.slice(first + 1) };
  return { section, sub: key.slice(first + 1, last), variable: key.slice(last + 1) };
}

/** Longest matching prefix wins, as in git's `url.<base>.insteadOf`. */
export function rewriteUrl(url: string, rules: readonly RewriteRule[]): string | null {
  let best: RewriteRule | null = null;
  for (const rule of rules) {
    if (rule.prefix.length > 0 && url.startsWith(rule.prefix)) {
      if (best === null || rule.prefix.length > best.prefix.length) best = rule;
    }
  }
  return best === null ? null : best.base + url.slice(best.prefix.length);
}

/** Parses `git config --null --get-regexp REMOTE_CONFIG_REGEX` output (`key\nvalue\0`...). */
export function parseRemoteConfig(output: string): GitRemoteConfig {
  const remotes = new Map<
    string,
    { url: string | null; pushUrl: string | null; gh: string | null }
  >();
  const branches: Record<string, GitBranchConfig> = Object.create(null);
  const insteadOf: RewriteRule[] = [];
  const pushInsteadOf: RewriteRule[] = [];
  let pushDefault: string | null = null;

  const remote = (name: string) => {
    let entry = remotes.get(name);
    if (!entry) {
      entry = { url: null, pushUrl: null, gh: null };
      remotes.set(name, entry);
    }
    return entry;
  };

  for (const record of output.split('\u0000')) {
    if (record.length === 0) continue;
    const newline = record.indexOf('\n');
    // A key without a value (`[remote "x"] url`) means boolean true: nothing usable here.
    if (newline === -1) continue;
    const key = record.slice(0, newline);
    const value = record.slice(newline + 1);
    const parts = splitKey(key);
    if (!parts) continue;
    const { section, sub, variable } = parts;
    if (section === 'remote') {
      if (sub === null) {
        if (variable === 'pushdefault') pushDefault = value || null;
        continue;
      }
      const entry = remote(sub);
      // Several `url` values configure fetch fallbacks; git fetches from the first.
      if (variable === 'url') entry.url ??= value;
      else if (variable === 'pushurl') entry.pushUrl ??= value;
      else if (variable === 'gh-resolved') entry.gh = value || null;
    } else if (section === 'branch' && sub !== null) {
      const branch = (branches[sub] ??= { remote: null, merge: null, pushRemote: null });
      if (variable === 'remote') branch.remote = value || null;
      else if (variable === 'merge') branch.merge = value || null;
      else if (variable === 'pushremote') branch.pushRemote = value || null;
    } else if (section === 'url' && sub !== null) {
      if (variable === 'insteadof') insteadOf.push({ base: sub, prefix: value });
      else if (variable === 'pushinsteadof') pushInsteadOf.push({ base: sub, prefix: value });
    }
  }

  const list: GitRemote[] = [];
  for (const [name, entry] of remotes) {
    const url = entry.url === null ? null : (rewriteUrl(entry.url, insteadOf) ?? entry.url);
    const pushUrl =
      entry.pushUrl !== null
        ? (rewriteUrl(entry.pushUrl, insteadOf) ?? entry.pushUrl)
        : entry.url === null
          ? null
          : (rewriteUrl(entry.url, pushInsteadOf) ?? null);
    list.push({ name, url, pushUrl, ghResolved: entry.gh });
  }
  return { remotes: list, branches: { ...branches }, pushDefault };
}

export async function readRemoteConfig(
  ctx: GitContext,
  project: ProjectLocator,
): Promise<GitRemoteConfig> {
  const repo = await projectRepoFor(ctx, project);
  const result = await ctx.git(repo, ['config', '--null', '--get-regexp', REMOTE_CONFIG_REGEX], {
    // 1 = no matching key (no remotes at all).
    okExitCodes: [0, 1],
  });
  return parseRemoteConfig(result.stdout.toString('utf8'));
}
