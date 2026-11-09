import type {
  ChangeRequest,
  ForgeHostOverride,
  ForgeKind,
  GitRemoteConfig,
  ProjectForge,
} from '@octopus-diff/contracts';
import { classifyHost, isRepositoryPathFor, parseRemoteUrl, repositoryWebUrl } from './host.js';

export interface ResolveContext {
  overrides: Readonly<Record<string, ForgeHostOverride>>;
  logins: Readonly<Record<ForgeKind, ReadonlySet<string>>>;
  /** ssh-config alias -> hostname (lower case). */
  sshAliases: ReadonlyMap<string, string>;
}

interface RemoteCandidate {
  name: string;
  kind: ForgeKind;
  host: string;
  path: string;
  detectedBy: ProjectForge['detectedBy'];
  index: number;
}

export type ProjectForgeResolution =
  | { forge: ProjectForge }
  | { forge: null; reason: 'no-remote' | 'unsupported' | 'ignored'; host: string | null };

/** Parses a remote URL and maps an ssh alias to its real hostname. */
export function remoteLocation(
  url: string,
  sshAliases: ReadonlyMap<string, string>,
): { host: string; path: string } | null {
  const parsed = parseRemoteUrl(url);
  if (!parsed) return null;
  const host = parsed.ssh ? (sshAliases.get(parsed.hostname) ?? parsed.host) : parsed.host;
  return { host, path: parsed.path };
}

/** Name ranking for the base repository, as `gh` does: upstream, then github/gitlab, origin. */
function nameRank(name: string): number {
  const lower = name.toLowerCase();
  if (lower === 'upstream') return 0;
  if (lower === 'github' || lower === 'gitlab') return 1;
  if (lower === 'origin') return 2;
  return 3;
}

/**
 * The forge repository that requests are opened against. A `gh repo set-default` mark
 * (`remote.<name>.gh-resolved`) wins; otherwise the recognised remotes are ranked
 * upstream > github/gitlab > origin > others (config order breaks ties), which is `gh`'s order
 * and picks the upstream of a fork.
 */
export function resolveProjectForge(
  config: GitRemoteConfig,
  context: ResolveContext,
): ProjectForgeResolution {
  const candidates: RemoteCandidate[] = [];
  let firstHost: string | null = null;
  let ignored = false;
  config.remotes.forEach((remote, index) => {
    if (remote.url === null) return;
    const location = remoteLocation(remote.url, context.sshAliases);
    if (!location) return;
    firstHost ??= location.host;
    const classified = classifyHost({
      host: location.host,
      overrides: context.overrides,
      logins: context.logins,
    });
    if (classified.kind === null) {
      if (classified.ignored) ignored = true;
      return;
    }
    if (!isRepositoryPathFor(classified.kind, location.path)) return;
    candidates.push({
      name: remote.name,
      kind: classified.kind,
      host: location.host,
      path: location.path,
      detectedBy: classified.detectedBy,
      index,
    });
  });
  if (candidates.length === 0) {
    if (config.remotes.length === 0) return { forge: null, reason: 'no-remote', host: null };
    return { forge: null, reason: ignored ? 'ignored' : 'unsupported', host: firstHost };
  }

  let chosen: RemoteCandidate | undefined;
  let repository: string | undefined;
  const marked = config.remotes.filter((r) => r.ghResolved !== null);
  if (marked.length === 1) {
    const mark = marked[0];
    const candidate = candidates.find((c) => c.name === mark?.name);
    if (candidate && mark?.ghResolved === 'base') chosen = candidate;
    else if (
      candidate &&
      mark?.ghResolved &&
      isRepositoryPathFor(candidate.kind, mark.ghResolved)
    ) {
      chosen = candidate;
      repository = mark.ghResolved;
    }
  }
  chosen ??= [...candidates].sort(
    (a, b) => nameRank(a.name) - nameRank(b.name) || a.index - b.index,
  )[0];
  if (!chosen) return { forge: null, reason: 'unsupported', host: firstHost };
  const path = repository ?? chosen.path;
  return {
    forge: {
      kind: chosen.kind,
      host: chosen.host,
      repository: path,
      webUrl: repositoryWebUrl(chosen.host, path),
      remoteName: chosen.name,
      detectedBy: chosen.detectedBy,
    },
  };
}

export interface BranchHead {
  /** Branch name on the head repository. */
  headBranch: string;
  /** Repository the branch is pushed to (same host as the forge), or null when unknown. */
  pushRepository: string | null;
}

/**
 * Where a local branch's commits go on the forge: its push remote
 * (`branch.<b>.pushRemote` > `remote.pushDefault` > `branch.<b>.remote` > `origin`) and the
 * remote branch name (`branch.<b>.merge` when pushing to the tracked remote, else the local name).
 */
export function resolveBranchHead(
  branch: string,
  config: GitRemoteConfig,
  forge: Pick<ProjectForge, 'host' | 'kind'>,
  sshAliases: ReadonlyMap<string, string>,
): BranchHead {
  const tracking = config.branches[branch];
  const pushRemoteName = tracking?.pushRemote ?? config.pushDefault ?? tracking?.remote ?? 'origin';
  let headBranch = branch;
  if (
    tracking?.merge?.startsWith('refs/heads/') &&
    tracking.remote !== null &&
    tracking.remote === pushRemoteName
  ) {
    headBranch = tracking.merge.slice('refs/heads/'.length) || branch;
  }
  const remote = config.remotes.find((r) => r.name === pushRemoteName);
  const url = remote?.pushUrl ?? remote?.url ?? null;
  const location = url === null ? null : remoteLocation(url, sshAliases);
  const pushRepository =
    location && location.host === forge.host && isRepositoryPathFor(forge.kind, location.path)
      ? location.path
      : null;
  return { headBranch, pushRepository };
}

/**
 * The request that belongs to a worktree's branch, from the requests whose head branch has that
 * name (forks reuse names like `main` or `fix/typo`). With a known push repository only requests
 * from it count; otherwise only same-repository requests. Then: an open request (most recently
 * updated first), else the most recently updated merged or closed one.
 */
export function pickChangeRequest(
  candidates: readonly ChangeRequest[],
  head: BranchHead,
  baseRepository: string,
): ChangeRequest | null {
  const push = head.pushRepository?.toLowerCase() ?? null;
  const own = candidates.filter((c) => {
    if (c.headBranch !== head.headBranch) return false;
    if (push !== null) {
      if (c.headRepository !== null) return c.headRepository.toLowerCase() === push;
      return !c.crossRepository && push === baseRepository.toLowerCase();
    }
    return !c.crossRepository;
  });
  const byUpdated = [...own].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  return byUpdated.find((c) => c.state === 'open') ?? byUpdated[0] ?? null;
}
