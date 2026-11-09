import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  type AppSettings,
  type ChangeRequest,
  type ChangeRequestConversation,
  type ChangeRequestConversationResponse,
  type ChangeRequestDetail,
  type ChangeRequestDetailResponse,
  DEFAULT_FORGE_SETTINGS,
  FORGE_DETAIL_CLOSED_TTL_MS,
  FORGE_DETAIL_TTL_MS,
  FORGE_KINDS,
  FORGE_MIN_REFETCH_MS,
  FORGE_POLL_INTERVAL_MS,
  FORGE_REPOSITORY_TTL_MS,
  type ForgeCliStatus,
  ForgeHostSchema,
  type ForgeKind,
  type ForgeRepositoryInfo,
  type ForgeSettings,
  type ForgesResponse,
  type GitCore,
  type GitRemoteConfig,
  type Logger,
  type ProjectForge,
  type ProjectForgeState,
  type ProjectForgeStatus,
  type ProjectListItem,
  type RepositoryForgeResponse,
  type ServerEvent,
  type WorktreeForge,
} from '@octopus-diff/contracts';
import {
  type BranchHead,
  ForgeCli,
  ForgeClient,
  loginHint,
  parseRemoteUrl,
  parseSshConfigAliases,
  pickChangeRequest,
  resolveBranchHead,
  resolveProjectForge,
} from '@octopus-diff/forge';
import { ApiError } from './errors.js';

/**
 * Forge integration service (docs/FORGES.md): which forge repository each project's pull/merge
 * requests live in, and which request belongs to each worktree's branch.
 *
 * Cost control, in order: nothing runs while `forges.enabled` is false; a project without a
 * remote on a host costs one `git config` read and never starts a forge CLI (so fixture repos and
 * offline setups spawn no `gh`/`glab` at all); projects with only the default branch checked out
 * are not queried; each queried project is one GraphQL request per refresh, at most every
 * `FORGE_MIN_REFETCH_MS` unless forced, and polled every `FORGE_POLL_INTERVAL_MS`. Only hosts a
 * CLI reports as signed in are ever queried.
 */

/** A forge repository a single-object query is about. */
export type ForgeTargetLike = Pick<ProjectForge, 'kind' | 'host' | 'repository' | 'webUrl'>;

/**
 * What the service needs from the CLI layer (tests pass a fake). The detail methods are optional
 * so older fakes still compile; without them the detail routes answer `unavailable`.
 */
export interface ForgeClientLike {
  probe(kind: ForgeKind): Promise<ForgeCliStatus>;
  fetchChangeRequests(
    forge: Pick<ProjectForge, 'kind' | 'host' | 'repository'>,
    branches: readonly string[],
  ): Promise<Map<string, ChangeRequest[]>>;
  fetchRepository?(forge: ForgeTargetLike): Promise<ForgeRepositoryInfo>;
  fetchDetail?(forge: ForgeTargetLike, number: number): Promise<ChangeRequestDetail | null>;
  fetchConversation?(
    forge: ForgeTargetLike,
    number: number,
  ): Promise<ChangeRequestConversation | null>;
}

/**
 * Image sources the UI may load (DECISIONS #74): per host a forge CLI is signed in to, the forge
 * itself and where it serves avatars and attachments. Host patterns without a scheme; the CSP
 * builder prefixes `https://`. Hosts are validated (`ForgeHostSchema`), so no wildcard or CSP
 * syntax can come from user input.
 */
export function forgeImageHosts(settings: ForgeSettings, clis: Iterable<ForgeCliStatus>): string[] {
  if (!settings.enabled || settings.images === false) return [];
  const out = new Set<string>();
  for (const cli of clis) {
    if (!cli.available) continue;
    for (const { host } of cli.accounts) {
      if (!ForgeHostSchema.safeParse(host).success) continue;
      if (settings.hosts[host] === 'none') continue;
      if (cli.kind === 'github') {
        if (host === 'github.com') {
          out.add('github.com');
          out.add('*.githubusercontent.com');
        } else {
          out.add(host);
          out.add(`*.${host}`);
        }
      } else {
        out.add(host);
        out.add('secure.gravatar.com');
      }
    }
  }
  return [...out].sort();
}

/** A cached single-object fetch: value, when, in-flight dedupe, last error. */
interface Entry<T> {
  value: T | null;
  /** `value` exists but the forge says the object is gone. */
  missing: boolean;
  fetchedAt: number;
  /** ISO time of `fetchedAt`. */
  fetchedIso: string | null;
  lastAttempt: number;
  error: string | null;
  /** Batch fingerprint the value was fetched for (`updatedAt|headSha|checks`). */
  fingerprint: string;
  inflight: Promise<void> | null;
}

function emptyEntry<T>(): Entry<T> {
  return {
    value: null,
    missing: false,
    fetchedAt: 0,
    fetchedIso: null,
    lastAttempt: 0,
    error: null,
    fingerprint: '',
    inflight: null,
  };
}

function fingerprintOf(cr: ChangeRequest): string {
  return [cr.updatedAt ?? '', cr.headSha ?? '', cr.checks?.state ?? '', cr.state].join('|');
}

export interface ForgeServiceOptions {
  core: { listProjects(): Promise<ProjectListItem[]> };
  gitCore: Pick<GitCore, 'readRemoteConfig'>;
  settings: { readonly settings: AppSettings };
  hub: { on(listener: (event: ServerEvent) => void): () => void; emit(event: ServerEvent): void };
  logger: Logger;
  /** Default: a `ForgeClient` over the real `gh` / `glab` with `cwd` as the neutral directory. */
  client?: ForgeClientLike;
  /** Neutral working directory for the CLIs (the daemon's state dir). */
  cwd?: string;
  /** `~/.ssh/config` text; default reads the file (null when absent). */
  readSshConfig?: () => Promise<string | null>;
  pollMs?: number;
  minRefetchMs?: number;
  /** How long CLI probes are reused (default 10 min). */
  cliTtlMs?: number;
  /** Debounce for event-triggered refreshes (default 1500 ms). */
  debounceMs?: number;
  now?: () => Date;
}

interface ProjectCache {
  forge: ProjectForge | null;
  status: ProjectForgeStatus;
  message: string | null;
  fetchedAt: string | null;
  lastFetch: number;
  /** Sorted head branches of the last fetch. */
  fetchedKey: string;
  config: GitRemoteConfig | null;
  /** Local branch -> where it is pushed. */
  heads: Map<string, BranchHead>;
  /** Head branch -> requests with that head branch name. */
  requests: Map<string, ChangeRequest[]>;
  inflight: Promise<void> | null;
}

interface Candidate {
  worktreeId: string;
  branch: string;
  headSha: string | null;
}

function candidatesOf(item: ProjectListItem): Candidate[] {
  const out: Candidate[] = [];
  const defaultBranch = item.project.defaultBranch;
  for (const { worktree, summary } of item.worktrees) {
    if (worktree.missing || worktree.bare) continue;
    const branch = summary?.branch ?? worktree.branch;
    const detached = summary?.detached ?? worktree.detached;
    if (detached || branch === null || branch === defaultBranch) continue;
    out.push({ worktreeId: worktree.id, branch, headSha: summary?.headSha ?? worktree.headSha });
  }
  return out;
}

function emptyCache(): ProjectCache {
  return {
    forge: null,
    status: 'pending',
    message: null,
    fetchedAt: null,
    lastFetch: 0,
    fetchedKey: '',
    config: null,
    heads: new Map(),
    requests: new Map(),
    inflight: null,
  };
}

async function defaultReadSshConfig(): Promise<string | null> {
  try {
    return await readFile(path.join(homedir(), '.ssh', 'config'), 'utf8');
  } catch {
    return null;
  }
}

export class ForgeService {
  readonly #o: Required<Omit<ForgeServiceOptions, 'client' | 'cwd' | 'readSshConfig' | 'now'>> & {
    client: ForgeClientLike;
    readSshConfig: () => Promise<string | null>;
    now: () => Date;
  };
  readonly #projects = new Map<string, ProjectCache>();
  #clis = new Map<ForgeKind, ForgeCliStatus>();
  #clisAt = 0;
  #probing: Promise<void> | null = null;
  #aliases: Map<string, string> | null = null;
  #aliasesAt = 0;
  #settingsKey: string;
  #timer: NodeJS.Timeout | null = null;
  readonly #debounce = new Map<string, NodeJS.Timeout>();
  #unsubscribe: (() => void) | null = null;
  #closed = false;

  constructor(options: ForgeServiceOptions) {
    this.#o = {
      core: options.core,
      gitCore: options.gitCore,
      settings: options.settings,
      hub: options.hub,
      logger: options.logger,
      client:
        options.client ?? new ForgeClient(new ForgeCli(options.cwd ? { cwd: options.cwd } : {})),
      readSshConfig: options.readSshConfig ?? defaultReadSshConfig,
      pollMs: options.pollMs ?? FORGE_POLL_INTERVAL_MS,
      minRefetchMs: options.minRefetchMs ?? FORGE_MIN_REFETCH_MS,
      cliTtlMs: options.cliTtlMs ?? 10 * 60_000,
      debounceMs: options.debounceMs ?? 1500,
      now: options.now ?? (() => new Date()),
    };
    this.#settingsKey = JSON.stringify(this.#forgeSettings());
  }

  #forgeSettings(): ForgeSettings {
    return this.#o.settings.settings.forges ?? DEFAULT_FORGE_SETTINGS;
  }

  get enabled(): boolean {
    return this.#forgeSettings().enabled;
  }

  /** Subscribes to registry/settings events and starts the poll. The first refresh runs now. */
  start(): void {
    this.#unsubscribe = this.#o.hub.on((event) => this.#onEvent(event));
    this.#timer = setInterval(() => {
      void this.refresh().catch((error) => {
        if (!this.#closed) this.#o.logger.warn('forge poll failed', { error });
      });
    }, this.#o.pollMs);
    this.#timer.unref();
    void this.refresh().catch((error) => {
      if (!this.#closed) this.#o.logger.warn('forge refresh failed', { error });
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#unsubscribe?.();
    if (this.#timer) clearInterval(this.#timer);
    for (const t of this.#debounce.values()) clearTimeout(t);
    this.#debounce.clear();
    await Promise.allSettled([...this.#projects.values()].map((c) => c.inflight));
  }

  #onEvent(event: ServerEvent): void {
    switch (event.type) {
      case 'worktree.added':
      case 'worktree.removed':
      case 'worktree.changed':
      case 'project.added':
      case 'project.updated':
        this.#schedule(event.projectId);
        return;
      case 'project.removed':
        this.#projects.delete(event.projectId);
        return;
      case 'settings.changed': {
        const key = JSON.stringify(this.#forgeSettings());
        if (key === this.#settingsKey) return;
        this.#settingsKey = key;
        for (const cache of this.#projects.values()) cache.fetchedKey = '';
        void this.refresh(undefined, { force: true }).catch(() => {});
        return;
      }
      default:
        return;
    }
  }

  /**
   * Debounced per-project refresh. `worktree.changed` fires on every edit; the refresh itself is
   * cheap unless the set of branches changed or the cache is older than `minRefetchMs`.
   */
  #schedule(projectId: string): void {
    if (this.#closed) return;
    const existing = this.#debounce.get(projectId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.#debounce.delete(projectId);
      void this.refresh([projectId], { onlyIfBranchesChanged: true }).catch(() => {});
    }, this.#o.debounceMs);
    timer.unref();
    this.#debounce.set(projectId, timer);
  }

  async #ensureClis(force: boolean): Promise<Map<ForgeKind, ForgeCliStatus>> {
    const now = this.#o.now().getTime();
    const stale = now - this.#clisAt > (force ? 30_000 : this.#o.cliTtlMs);
    if (this.#clis.size === 0 || stale) {
      this.#probing ??= (async () => {
        const results = await Promise.all(FORGE_KINDS.map((kind) => this.#o.client.probe(kind)));
        const before = JSON.stringify(
          [...this.#clis.values()].map((c) => [c.available, c.auth, c.accounts]),
        );
        this.#clis = new Map(results.map((r) => [r.kind, r]));
        this.#clisAt = this.#o.now().getTime();
        const after = JSON.stringify(results.map((c) => [c.available, c.auth, c.accounts]));
        if (before !== after) this.#o.hub.emit({ type: 'forge.updated', projectIds: [] });
      })().finally(() => {
        this.#probing = null;
      });
      await this.#probing;
    }
    return this.#clis;
  }

  async #sshAliases(): Promise<Map<string, string>> {
    const now = this.#o.now().getTime();
    if (this.#aliases === null || now - this.#aliasesAt > this.#o.cliTtlMs) {
      const text = await this.#o.readSshConfig().catch(() => null);
      this.#aliases = text === null ? new Map() : parseSshConfigAliases(text);
      this.#aliasesAt = now;
    }
    return this.#aliases;
  }

  /**
   * Refreshes the listed projects (default: all). `force` re-probes stale CLIs and ignores the
   * per-project rate limit; `onlyIfBranchesChanged` skips projects whose branch set is unchanged.
   */
  async refresh(
    projectIds?: readonly string[],
    options: { force?: boolean; onlyIfBranchesChanged?: boolean } = {},
  ): Promise<void> {
    if (this.#closed) return;
    const items = await this.#o.core.listProjects();
    const wanted = projectIds ? new Set(projectIds) : null;
    for (const id of this.#projects.keys()) {
      if (!items.some((i) => i.project.id === id)) this.#projects.delete(id);
    }
    const queue = items.filter((i) => wanted === null || wanted.has(i.project.id));
    const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (let item = queue.shift(); item && !this.#closed; item = queue.shift()) {
        await this.#refreshProject(item, options);
      }
    });
    await Promise.all(workers);
  }

  #refreshProject(
    item: ProjectListItem,
    options: { force?: boolean; onlyIfBranchesChanged?: boolean },
  ): Promise<void> {
    const id = item.project.id;
    let cache = this.#projects.get(id);
    if (!cache) {
      cache = emptyCache();
      this.#projects.set(id, cache);
    }
    if (cache.inflight) return cache.inflight;
    const run = this.#doRefresh(item, cache, options)
      .catch((error) => {
        // Shutting down: git-core may already be disposed.
        if (this.#closed) return;
        this.#o.logger.warn('forge refresh failed', { projectId: id, error });
      })
      .finally(() => {
        if (cache) cache.inflight = null;
      });
    cache.inflight = run;
    return run;
  }

  async #doRefresh(
    item: ProjectListItem,
    cache: ProjectCache,
    options: { force?: boolean; onlyIfBranchesChanged?: boolean },
  ): Promise<void> {
    const projectId = item.project.id;
    const before = this.#snapshot(cache);
    const set = (status: ProjectForgeStatus, message: string | null) => {
      cache.status = status;
      cache.message = message;
    };
    const finish = () => {
      if (this.#snapshot(cache) !== before) {
        this.#o.hub.emit({ type: 'forge.updated', projectIds: [projectId] });
      }
    };

    const settings = this.#forgeSettings();
    if (!settings.enabled) {
      set('disabled', 'Forge integration is turned off in Settings.');
      return finish();
    }
    const candidates = candidatesOf(item);
    const branchKeyLocal = candidates
      .map((c) => c.branch)
      .sort()
      .join('\n');

    if (options.onlyIfBranchesChanged && cache.status !== 'pending') {
      const known = [...cache.heads.keys()].sort().join('\n');
      const fresh = this.#o.now().getTime() - cache.lastFetch < this.#o.pollMs;
      if (known === branchKeyLocal && fresh) return;
    }

    if (!this.#o.gitCore.readRemoteConfig) {
      set('no-forge', 'This git-core cannot read remotes.');
      return finish();
    }
    const config = await this.#o.gitCore.readRemoteConfig({
      id: projectId,
      commonDir: item.project.commonDir,
    });
    cache.config = config;
    const hasHost = config.remotes.some((r) => r.url !== null && parseRemoteUrl(r.url) !== null);
    if (!hasHost) {
      cache.forge = null;
      cache.heads = new Map();
      set(
        'no-forge',
        config.remotes.length === 0
          ? 'No git remote is configured.'
          : 'No remote is on a forge host.',
      );
      return finish();
    }

    const clis = await this.#ensureClis(options.force ?? false);
    const logins = {
      github: new Set(clis.get('github')?.accounts.map((a) => a.host) ?? []),
      gitlab: new Set(clis.get('gitlab')?.accounts.map((a) => a.host) ?? []),
    };
    const sshAliases = await this.#sshAliases();
    const resolution = resolveProjectForge(config, {
      overrides: settings.hosts,
      logins,
      sshAliases,
    });
    if (resolution.forge === null) {
      cache.forge = null;
      cache.heads = new Map();
      if (resolution.reason === 'ignored') {
        set('ignored', `${resolution.host ?? 'This host'} is set to "never query" in Settings.`);
      } else {
        set(
          'no-forge',
          resolution.host
            ? `${resolution.host} is not recognised as GitHub or GitLab. Sign in to it with gh or glab, or add a host override in Settings.`
            : 'No remote is on a forge host.',
        );
      }
      return finish();
    }
    const forge = resolution.forge;
    if (cache.forge && JSON.stringify(cache.forge) !== JSON.stringify(forge)) {
      cache.requests = new Map();
      cache.fetchedKey = '';
      cache.fetchedAt = null;
    }
    cache.forge = forge;
    cache.heads = new Map(
      candidates.map((c) => [c.branch, resolveBranchHead(c.branch, config, forge, sshAliases)]),
    );
    if (candidates.length === 0) {
      set('idle', null);
      return finish();
    }
    const cli = clis.get(forge.kind);
    if (!cli?.available) {
      set('cli-missing', cli?.hint ?? 'The forge CLI is not installed.');
      return finish();
    }
    if (!cli.accounts.some((a) => a.host === forge.host)) {
      set('unauthenticated', loginHint(forge.kind, forge.host));
      return finish();
    }

    const heads = [...new Set([...cache.heads.values()].map((h) => h.headBranch))].sort();
    const key = heads.join('\n');
    const now = this.#o.now().getTime();
    if (
      !options.force &&
      key === cache.fetchedKey &&
      now - cache.lastFetch < this.#o.minRefetchMs
    ) {
      return finish();
    }
    if (cache.status !== 'ok' && cache.status !== 'error') set('pending', null);
    cache.lastFetch = now;
    try {
      const fetched = await this.#o.client.fetchChangeRequests(forge, heads);
      cache.requests = fetched;
      cache.fetchedKey = key;
      cache.fetchedAt = this.#o.now().toISOString();
      set('ok', null);
    } catch (error) {
      set('error', error instanceof Error ? error.message : String(error));
      this.#o.logger.debug('forge fetch failed', { projectId, error });
    }
    return finish();
  }

  /** What subscribers can see change (ignores timestamps of identical results). */
  #snapshot(cache: ProjectCache): string {
    return JSON.stringify({
      forge: cache.forge,
      status: cache.status,
      message: cache.message,
      requests: [...cache.requests],
      heads: [...cache.heads],
    });
  }

  // --- request detail, conversation and repository information (DECISIONS #73-#76) ---------

  readonly #details = new Map<string, Entry<ChangeRequestDetail>>();
  readonly #conversations = new Map<string, Entry<ChangeRequestConversation>>();
  readonly #repositories = new Map<string, Entry<ForgeRepositoryInfo>>();

  /** Image hosts for the CSP and the responses (empty when forges or images are off). */
  imageHosts(): string[] {
    return forgeImageHosts(this.#forgeSettings(), this.#clis.values());
  }

  /**
   * The worktree's matched request, or why there is none. Throws `not_found` for an unknown
   * worktree id. Never runs a forge query (only cached data and the project list).
   */
  async #matchWorktree(
    worktreeId: string,
  ): Promise<
    | { ok: true; forge: ProjectForge; changeRequest: ChangeRequest }
    | { ok: false; status: 'no-request' | 'unavailable'; message: string | null }
  > {
    const items = await this.#o.core.listProjects();
    const item = items.find((i) => i.worktrees.some((w) => w.worktree.id === worktreeId));
    if (!item) throw new ApiError('not_found', `unknown worktree: ${worktreeId}`);
    if (!this.enabled) {
      return {
        ok: false,
        status: 'no-request',
        message: 'Forge integration is turned off in Settings.',
      };
    }
    const cache = this.#projects.get(item.project.id);
    if (!cache?.forge) {
      return { ok: false, status: 'no-request', message: cache?.message ?? null };
    }
    if (cache.status === 'cli-missing' || cache.status === 'unauthenticated') {
      return { ok: false, status: 'unavailable', message: cache.message };
    }
    const candidate = candidatesOf(item).find((c) => c.worktreeId === worktreeId);
    const head = candidate ? cache.heads.get(candidate.branch) : undefined;
    const changeRequest = head
      ? pickChangeRequest(cache.requests.get(head.headBranch) ?? [], head, cache.forge.repository)
      : null;
    if (!changeRequest) return { ok: false, status: 'no-request', message: null };
    return { ok: true, forge: cache.forge, changeRequest };
  }

  /**
   * Serves `entry` from cache when fresh, else fetches (deduped). A failed fetch keeps the old
   * value (stale-while-error). `force` refetches unless the last attempt is under
   * `minRefetchMs` old.
   */
  async #load<T>(
    entry: Entry<T>,
    ttl: number,
    fingerprint: string,
    force: boolean,
    fetch: () => Promise<T | null>,
  ): Promise<void> {
    const now = this.#o.now().getTime();
    const spaced = now - entry.lastAttempt >= this.#o.minRefetchMs;
    const fresh =
      (entry.value !== null || entry.missing) &&
      now - entry.fetchedAt < ttl &&
      entry.fingerprint === fingerprint;
    if (entry.inflight) return entry.inflight;
    if (fresh && !force) return;
    if (!spaced && (entry.value !== null || entry.missing || entry.error !== null)) return;
    entry.lastAttempt = now;
    entry.inflight = (async () => {
      try {
        const value = await fetch();
        entry.value = value;
        entry.missing = value === null;
        entry.fetchedAt = this.#o.now().getTime();
        entry.fetchedIso = this.#o.now().toISOString();
        entry.fingerprint = fingerprint;
        entry.error = null;
      } catch (error) {
        entry.error = error instanceof Error ? error.message : String(error);
        this.#o.logger.debug('forge detail fetch failed', { error });
      }
    })().finally(() => {
      entry.inflight = null;
    });
    return entry.inflight;
  }

  #requestKey(forge: ProjectForge, number: number): string {
    return `${forge.kind}\u0000${forge.host}\u0000${forge.repository}\u0000${number}`;
  }

  #ttlFor(cr: ChangeRequest): number {
    return cr.state === 'open' ? FORGE_DETAIL_TTL_MS : FORGE_DETAIL_CLOSED_TTL_MS;
  }

  /** `GET /api/forges/worktrees/:worktreeId/request`. */
  async detail(worktreeId: string, options: { force?: boolean } = {}) {
    const imageHosts = this.imageHosts();
    const base = { worktreeId, imageHosts };
    const match = await this.#matchWorktree(worktreeId);
    if (!match.ok) {
      return {
        ...base,
        status: match.status,
        message: match.message,
        request: null,
        fetchedAt: null,
      } satisfies ChangeRequestDetailResponse;
    }
    const { forge, changeRequest } = match;
    const fetchDetail = this.#o.client.fetchDetail?.bind(this.#o.client);
    if (!fetchDetail) {
      return {
        ...base,
        status: 'unavailable',
        message: 'This forge client cannot read request details.',
        request: null,
        fetchedAt: null,
      } satisfies ChangeRequestDetailResponse;
    }
    const key = this.#requestKey(forge, changeRequest.number);
    let entry = this.#details.get(key);
    if (!entry) {
      entry = emptyEntry();
      this.#details.set(key, entry);
    }
    await this.#load(
      entry,
      this.#ttlFor(changeRequest),
      fingerprintOf(changeRequest),
      options.force ?? false,
      () => fetchDetail(forge, changeRequest.number),
    );
    if (entry.value === null) {
      return {
        ...base,
        status: entry.missing ? 'no-request' : 'unavailable',
        message: entry.missing
          ? `${changeRequest.kind === 'github' ? 'Pull request' : 'Merge request'} ${changeRequest.number} was not found.`
          : (entry.error ?? 'Not loaded yet.'),
        request: null,
        fetchedAt: null,
      } satisfies ChangeRequestDetailResponse;
    }
    return {
      ...base,
      status: 'ok',
      message: entry.error,
      request: entry.value,
      fetchedAt: entry.fetchedIso,
    } satisfies ChangeRequestDetailResponse;
  }

  /** `GET /api/forges/worktrees/:worktreeId/request/conversation`. */
  async conversation(worktreeId: string, options: { force?: boolean } = {}) {
    const imageHosts = this.imageHosts();
    const base = { worktreeId, imageHosts };
    const match = await this.#matchWorktree(worktreeId);
    if (!match.ok) {
      return {
        ...base,
        status: match.status,
        message: match.message,
        conversation: null,
        fetchedAt: null,
      } satisfies ChangeRequestConversationResponse;
    }
    const { forge, changeRequest } = match;
    const fetchConversation = this.#o.client.fetchConversation?.bind(this.#o.client);
    if (!fetchConversation) {
      return {
        ...base,
        status: 'unavailable',
        message: 'This forge client cannot read conversations.',
        conversation: null,
        fetchedAt: null,
      } satisfies ChangeRequestConversationResponse;
    }
    const key = this.#requestKey(forge, changeRequest.number);
    let entry = this.#conversations.get(key);
    if (!entry) {
      entry = emptyEntry();
      this.#conversations.set(key, entry);
    }
    // The conversation does not change with CI: only the request's update time and head count.
    const fingerprint = `${changeRequest.updatedAt ?? ''}|${changeRequest.headSha ?? ''}`;
    await this.#load(entry, this.#ttlFor(changeRequest), fingerprint, options.force ?? false, () =>
      fetchConversation(forge, changeRequest.number),
    );
    if (entry.value === null) {
      return {
        ...base,
        status: entry.missing ? 'no-request' : 'unavailable',
        message: entry.missing ? 'The request was not found.' : (entry.error ?? 'Not loaded yet.'),
        conversation: null,
        fetchedAt: null,
      } satisfies ChangeRequestConversationResponse;
    }
    return {
      ...base,
      status: 'ok',
      message: entry.error,
      conversation: entry.value,
      fetchedAt: entry.fetchedIso,
    } satisfies ChangeRequestConversationResponse;
  }

  /** `POST /api/forges/worktrees/:worktreeId/request/refresh`: both caches, 15 s spacing. */
  async refreshRequest(worktreeId: string): Promise<ChangeRequestDetailResponse> {
    const detail = await this.detail(worktreeId, { force: true });
    if (detail.status === 'ok') {
      await this.conversation(worktreeId, { force: true }).catch(() => undefined);
    }
    return detail;
  }

  /**
   * `GET /api/forges/projects/:projectId/repository`: forge facts, fetched lazily (when the
   * project Overview opens) and cached 10 minutes. Open requests are joined to the worktrees
   * whose matched request they are. Throws `not_found` for an unknown project.
   */
  async repository(
    projectId: string,
    options: { force?: boolean } = {},
  ): Promise<RepositoryForgeResponse> {
    const items = await this.#o.core.listProjects();
    const item = items.find((i) => i.project.id === projectId);
    if (!item) throw new ApiError('not_found', `unknown project: ${projectId}`);
    const empty = (
      status: ProjectForgeStatus,
      message: string | null,
      forge: ProjectForge | null,
    ): RepositoryForgeResponse => ({
      projectId,
      status,
      message,
      forge,
      repository: null,
      fetchedAt: null,
    });
    if (!this.enabled)
      return empty('disabled', 'Forge integration is turned off in Settings.', null);
    let cache = this.#projects.get(projectId);
    if (!cache || cache.status === 'pending') {
      await this.refresh([projectId]);
      cache = this.#projects.get(projectId);
    }
    if (!cache) return empty('pending', null, null);
    const forge = cache.forge;
    if (!forge) return empty(cache.status, cache.message, null);
    const clis = await this.#ensureClis(false);
    const cli = clis.get(forge.kind);
    if (!cli?.available) {
      return empty('cli-missing', cli?.hint ?? 'The forge CLI is not installed.', forge);
    }
    if (!cli.accounts.some((a) => a.host === forge.host)) {
      return empty('unauthenticated', loginHint(forge.kind, forge.host), forge);
    }
    const fetchRepository = this.#o.client.fetchRepository?.bind(this.#o.client);
    if (!fetchRepository) {
      return empty('error', 'This forge client cannot read repositories.', forge);
    }
    const key = `${projectId}\u0000${JSON.stringify(forge)}`;
    let entry = this.#repositories.get(key);
    if (!entry) {
      for (const k of this.#repositories.keys()) {
        if (k.startsWith(`${projectId}\u0000`)) this.#repositories.delete(k);
      }
      entry = emptyEntry();
      this.#repositories.set(key, entry);
    }
    await this.#load(entry, FORGE_REPOSITORY_TTL_MS, '', options.force ?? false, () =>
      fetchRepository(forge),
    );
    if (entry.value === null) {
      return empty('error', entry.error ?? 'Not loaded yet.', forge);
    }
    // Join open requests to local worktrees (cached batch data, no query).
    const byNumber = new Map<number, string>();
    for (const candidate of candidatesOf(item)) {
      const head = cache.heads.get(candidate.branch);
      if (!head) continue;
      const cr = pickChangeRequest(
        cache.requests.get(head.headBranch) ?? [],
        head,
        forge.repository,
      );
      if (cr) byNumber.set(cr.number, candidate.worktreeId);
    }
    const repository: ForgeRepositoryInfo = {
      ...entry.value,
      requests: entry.value.requests.map((r) => ({
        ...r,
        worktreeId: byNumber.get(r.number) ?? null,
      })),
    };
    return {
      projectId,
      status: entry.error ? 'error' : 'ok',
      message: entry.error,
      forge,
      repository,
      fetchedAt: entry.fetchedIso,
    };
  }

  /** `GET /api/forges`: cached data joined with the live worktree list (no network). */
  async response(): Promise<ForgesResponse> {
    const items = await this.#o.core.listProjects();
    const enabled = this.enabled;
    const projects: ProjectForgeState[] = [];
    for (const item of items) {
      const cache = this.#projects.get(item.project.id);
      if (!cache) {
        if (enabled) this.#schedule(item.project.id);
        projects.push({
          projectId: item.project.id,
          forge: null,
          status: enabled ? 'pending' : 'disabled',
          message: null,
          worktrees: [],
          fetchedAt: null,
        });
        continue;
      }
      const worktrees: WorktreeForge[] = [];
      if (cache.forge && enabled) {
        for (const candidate of candidatesOf(item)) {
          const head = cache.heads.get(candidate.branch);
          if (!head) {
            // A branch the last refresh did not see: look it up soon.
            this.#schedule(item.project.id);
            continue;
          }
          const changeRequest = pickChangeRequest(
            cache.requests.get(head.headBranch) ?? [],
            head,
            cache.forge.repository,
          );
          worktrees.push({
            worktreeId: candidate.worktreeId,
            branch: head.headBranch,
            changeRequest,
            sync:
              changeRequest?.headSha && candidate.headSha
                ? changeRequest.headSha === candidate.headSha
                  ? 'same'
                  : 'differs'
                : 'unknown',
          });
        }
      }
      projects.push({
        projectId: item.project.id,
        forge: cache.forge,
        status: enabled ? cache.status : 'disabled',
        message: enabled ? cache.message : null,
        worktrees,
        fetchedAt: cache.fetchedAt,
      });
    }
    return {
      enabled,
      clis: FORGE_KINDS.map((k) => this.#clis.get(k)).filter((c): c is ForgeCliStatus => !!c),
      projects,
      generatedAt: this.#o.now().toISOString(),
    };
  }
}
