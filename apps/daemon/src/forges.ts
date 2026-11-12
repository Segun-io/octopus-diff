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
  estimateQueryPoints,
  ForgeCli,
  ForgeClient,
  type ForgeQueryKind,
  isRateLimitMessage,
  loginHint,
  parseRemoteUrl,
  parseSshConfigAliases,
  pickChangeRequest,
  resolveBranchHead,
  resolveProjectForge,
} from '@octopus-diff/forge';
import { ApiError } from './errors.js';
import { type BudgetLimits, ForgeBudget, type ForgePriority } from './forge-budget.js';

/**
 * Forge integration service (docs/FORGES.md): which forge repository each project's pull/merge
 * requests live in, and which request belongs to each worktree's branch.
 *
 * Cost control, in order: nothing runs while `forges.enabled` is false; a project without a
 * remote on a host costs one `git config` read and never starts a forge CLI (so fixture repos and
 * offline setups spawn no `gh`/`glab` at all); projects with only the default branch checked out
 * are not queried; each queried project is one GraphQL request per refresh, at most every
 * `FORGE_MIN_REFETCH_MS` unless forced, and polled every `FORGE_POLL_INTERVAL_MS` while a browser
 * is looking (every 10 minutes when none is, stretched further for big fleets). Only hosts a CLI
 * reports as signed in are ever queried. Every query is admitted by the `ForgeBudget` (DECISIONS
 * #197): per-priority hourly ceilings under GitHub's 5 000 points, and a backoff when the forge
 * refuses.
 */

/** Polling targets, in points per hour, for the fleet poll (the user's other tools need the rest). */
const POLL_TARGET_ATTENTIVE = 1000;
const POLL_TARGET_IDLE = 300;
const POLL_MAX_MS = 30 * 60_000;
/** A fresh daemon counts a browser as looking for this long before the first focus report. */
const STARTUP_ATTENTION_MS = 6 * 60_000;
const HOUR_MS = 3_600_000;
/** While a project's Overview is in view its repository information is at most this old. */
const REPOSITORY_HOT_TTL_MS = 2 * 60_000;

/** Why a lookup did not run: the budget said no. Shown as the entry's "last loaded data" note. */
class ForgeBudgetError extends Error {}

interface RefreshOptions {
  force?: boolean;
  onlyIfBranchesChanged?: boolean;
  /** Which hourly ceiling applies; default: forced = interactive, event-driven = event, else background. */
  priority?: ForgePriority;
  /** Unforced: how old the last fetch must be to fetch again (default `minRefetchMs`). */
  minAgeMs?: number;
  /** Even when forced, leave a project whose batch is younger than this alone. */
  skipFresherThanMs?: number;
  /** A per-call allowance of points shared by all projects of the call (Check again). */
  allowance?: { left: number };
}

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
  /** The in-flight fetch was forced (a later forced call can share it). */
  inflightForced: boolean;
  /** Last time a request asked for it (eviction). */
  lastAccess: number;
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
    inflightForced: false,
    lastAccess: 0,
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
  /** Poll interval while a browser is looking (default `FORGE_POLL_INTERVAL_MS`, 2 min). */
  pollMs?: number;
  /** Poll interval when no browser has reported being visible for `attentionMs` (default 10 min). */
  idlePollMs?: number;
  /** Interval of the extra poll of the project in view (default 60 s). */
  hotPollMs?: number;
  /** How long after the last focus report a browser counts as looking (default 30 min). */
  attentionMs?: number;
  /** A project coming into view is looked up again when its batch is older than this (30 s). */
  focusStaleMs?: number;
  /** "Check again" leaves a project fetched less than this long ago alone (default 5 s: a double click). */
  checkAgainSkipMs?: number;
  /** Points one "Check again" may spend (default 150); the poll catches up with the rest. */
  checkAgainMaxPoints?: number;
  /** Rate-limit ceilings (default `DEFAULT_BUDGET_LIMITS`). */
  budgetLimits?: Partial<BudgetLimits>;
  /** Detail / conversation / repository entries kept per kind (default 64, least recently used out). */
  maxCacheEntries?: number;
  /** Entries nobody asked for in this long are dropped (default 1 hour). */
  cacheMaxAgeMs?: number;
  minRefetchMs?: number;
  /** How long CLI probes are reused (default 10 min). */
  cliTtlMs?: number;
  /** Debounce for event-triggered refreshes (default 1500 ms). */
  debounceMs?: number;
  /**
   * After a branch was pushed (its upstream or push configuration changed) and no request was
   * found for it, the project is looked up again after each of these delays: a pull request is
   * usually created a moment after the push (default 30 s and 90 s).
   */
  followUpMs?: readonly number[];
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
  /** The candidates' branch configuration (upstream, push remote) at the last look; a push changes it. */
  pushKey: string | null;
  /** Local branches whose push configuration changed and that are still waiting for a request. */
  followBranches: Set<string>;
  config: GitRemoteConfig | null;
  /** Local branch -> where it is pushed. */
  heads: Map<string, BranchHead>;
  /** Head branch -> requests with that head branch name. */
  requests: Map<string, ChangeRequest[]>;
  inflight: Promise<void> | null;
  /** The in-flight batch fetch was forced (a later forced call shares it). */
  inflightForced: boolean;
  /** The forge settings the in-flight fetch started under (it is shared only under the same ones). */
  inflightSettings: string;
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

/** What a `git push -u` / `gh pr create` changes for the worktrees' branches. */
function pushKeyOf(config: GitRemoteConfig, candidates: readonly Candidate[]): string {
  return JSON.stringify([
    config.pushDefault,
    candidates.map((c) => [c.branch, config.branches[c.branch] ?? null]),
  ]);
}

/** Local branches whose upstream or push configuration differs between two `pushKeyOf` results. */
function pushedBranchesOf(before: string, after: string): string[] {
  try {
    const [oldDefault, oldBranches] = JSON.parse(before) as [unknown, Array<[string, unknown]>];
    const [newDefault, newBranches] = JSON.parse(after) as [unknown, Array<[string, unknown]>];
    const old = new Map(oldBranches.map(([name, value]) => [name, JSON.stringify(value)]));
    const everything = JSON.stringify(oldDefault) !== JSON.stringify(newDefault);
    return newBranches
      .filter(([name, value]) => everything || (old.get(name) ?? 'null') !== JSON.stringify(value))
      .map(([name]) => name);
  } catch {
    return [];
  }
}

/** Which requests the batch knows (number and state): the repository list depends on it. */
function requestsSignature(cache: ProjectCache): string {
  const parts: string[] = [];
  for (const list of cache.requests.values()) {
    for (const cr of list) parts.push(`${cr.number}:${cr.state}`);
  }
  return parts.sort().join(',');
}

function emptyCache(): ProjectCache {
  return {
    forge: null,
    status: 'pending',
    message: null,
    fetchedAt: null,
    lastFetch: 0,
    fetchedKey: '',
    pushKey: null,
    followBranches: new Set(),
    config: null,
    heads: new Map(),
    requests: new Map(),
    inflight: null,
    inflightForced: false,
    inflightSettings: '',
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
  readonly #o: Required<
    Omit<ForgeServiceOptions, 'client' | 'cwd' | 'readSshConfig' | 'now' | 'budgetLimits'>
  > & {
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
  #hotTimer: NodeJS.Timeout | null = null;
  readonly #budget: ForgeBudget;
  #budgetKey = '';
  /** A browser reported being visible until this time (ms); 0 = it reported being hidden. */
  #attentionUntil = 0;
  /** The project the user is looking at, from the focus reports. */
  #hot: string | null = null;
  /** The project's Overview (not just one of its worktrees) is what is in view. */
  #hotOverview = false;
  #rounding = false;
  /** The wait before the next fleet poll as last scheduled (base interval or stretched). */
  #pollDelay = 0;
  #lastRoundAt = 0;
  readonly #debounce = new Map<string, NodeJS.Timeout>();
  readonly #followUps = new Map<string, NodeJS.Timeout[]>();
  #unsubscribe: (() => void) | null = null;
  #closed = false;

  constructor(options: ForgeServiceOptions) {
    this.#budget = new ForgeBudget({
      now: () => (options.now ?? (() => new Date()))().getTime(),
      ...(options.budgetLimits ? { limits: options.budgetLimits } : {}),
    });
    this.#o = {
      core: options.core,
      gitCore: options.gitCore,
      settings: options.settings,
      hub: options.hub,
      logger: options.logger,
      client:
        options.client ??
        new ForgeClient(new ForgeCli(options.cwd ? { cwd: options.cwd } : {}), {
          // What the forge itself says is left (GitHub: `rateLimit { cost remaining resetAt }`).
          onCost: (cost) => {
            this.#budget.observe(cost.kind, cost.host, cost);
            this.#announceBudget();
          },
        }),
      readSshConfig: options.readSshConfig ?? defaultReadSshConfig,
      pollMs: options.pollMs ?? FORGE_POLL_INTERVAL_MS,
      idlePollMs: options.idlePollMs ?? 10 * 60_000,
      hotPollMs: options.hotPollMs ?? 60_000,
      attentionMs: options.attentionMs ?? 30 * 60_000,
      focusStaleMs: options.focusStaleMs ?? 30_000,
      checkAgainSkipMs: options.checkAgainSkipMs ?? 5000,
      checkAgainMaxPoints: options.checkAgainMaxPoints ?? 150,
      maxCacheEntries: options.maxCacheEntries ?? 64,
      cacheMaxAgeMs: options.cacheMaxAgeMs ?? HOUR_MS,
      minRefetchMs: options.minRefetchMs ?? FORGE_MIN_REFETCH_MS,
      cliTtlMs: options.cliTtlMs ?? 10 * 60_000,
      debounceMs: options.debounceMs ?? 1500,
      followUpMs: options.followUpMs ?? [30_000, 90_000],
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
    // The daemon is usually started with a browser (it reports within seconds of loading): count
    // it as looking for a few minutes, then only while it keeps reporting.
    this.#attentionUntil = this.#now() + Math.min(this.#o.attentionMs, STARTUP_ATTENTION_MS);
    void this.#pollRound();
    this.#hotTimer = setInterval(() => this.#hotTick(), this.#o.hotPollMs);
    this.#hotTimer.unref();
  }

  #now(): number {
    return this.#o.now().getTime();
  }

  /** Is a browser looking (it reported a visible tab recently)? */
  #attentive(): boolean {
    return this.#now() < this.#attentionUntil;
  }

  /** How long the fleet poll waits now: faster while someone looks, slower when nobody does. */
  #pollBase(): number {
    return this.#attentive() ? this.#o.pollMs : this.#o.idlePollMs;
  }

  /**
   * One fleet poll, then the next one is scheduled: at the base interval, or later when this
   * round was so big that the base interval would spend more than the polling target per hour
   * (100 repositories at 1 point and a 2-minute interval would be 3 000 points an hour).
   */
  async #pollRound(): Promise<void> {
    if (this.#closed || this.#rounding) return;
    this.#rounding = true;
    if (this.#timer) clearTimeout(this.#timer);
    const before = this.#budget.totalSpent;
    try {
      this.#lastRoundAt = this.#now();
      await this.refresh();
      this.#sweepCaches();
    } catch (error) {
      if (!this.#closed) this.#o.logger.warn('forge poll failed', { error });
    } finally {
      this.#rounding = false;
    }
    if (this.#closed) return;
    const base = this.#pollBase();
    const target = this.#attentive() ? POLL_TARGET_ATTENTIVE : POLL_TARGET_IDLE;
    const stretched = ((this.#budget.totalSpent - before) / target) * HOUR_MS;
    const delay = Math.min(Math.max(base, stretched), Math.max(base, POLL_MAX_MS));
    this.#pollDelay = delay;
    this.#timer = setTimeout(() => void this.#pollRound(), delay);
    this.#timer.unref();
  }

  /** The project in view is looked up on its own at a shorter interval while someone looks. */
  #hotTick(): void {
    const hot = this.#hot;
    if (this.#closed || hot === null || !this.#attentive() || !this.enabled) return;
    void this.refresh([hot], {
      minAgeMs: Math.max(this.#o.hotPollMs / 2, this.#o.minRefetchMs),
      // A timer, not a person: it spends the background share only (and nothing once that is used).
      priority: 'background',
    }).catch(() => {});
    if (this.#hotOverview) void this.#revalidateRepository(hot).catch(() => {});
  }

  /**
   * The open project's Overview lists the forge's newest open requests, including those of branches
   * no worktree has checked out, which no batch ever asks about. While its Overview is in view and
   * its repository information is older than `REPOSITORY_HOT_TTL_MS`, load it again in the
   * background (1 point) and tell the UI when it changed (stale-while-revalidate).
   */
  async #revalidateRepository(projectId: string): Promise<void> {
    const prefix = `${projectId}\u0000`;
    const known = [...this.#repositories].some(
      ([key, entry]) => key.startsWith(prefix) && entry.value !== null && entry.inflight === null,
    );
    if (!known) return;
    const before = JSON.stringify(
      [...this.#repositories].find(([key]) => key.startsWith(prefix))?.[1].value,
    );
    await this.repository(projectId, { ttlMs: REPOSITORY_HOT_TTL_MS, priority: 'background' });
    const after = JSON.stringify(
      [...this.#repositories].find(([key]) => key.startsWith(prefix))?.[1].value,
    );
    if (before !== after) this.#o.hub.emit({ type: 'forge.updated', projectIds: [projectId] });
  }

  /**
   * The browser's focus report (`PUT /api/focus`). Hidden: no one is looking, polling slows down.
   * Visible: someone is, so a project that comes into view is looked up when its data is older
   * than `focusStaleMs`, and the fleet poll runs now when it has been waiting longer than a
   * normal interval (coming back after a break). This is the cheap answer to "a request created
   * on the forge's web page": nothing reaches the network until a person looks.
   */
  focusChanged(visible: boolean, projectId: string | null, overview = false): void {
    if (this.#closed) return;
    if (!visible) {
      this.#attentionUntil = 0;
      this.#hot = null;
      this.#hotOverview = false;
      return;
    }
    const wasAttentive = this.#attentive();
    const previous = this.#hot;
    this.#attentionUntil = this.#now() + this.#o.attentionMs;
    this.#hot = projectId;
    this.#hotOverview = overview;
    if (!this.enabled) return;
    if (!wasAttentive && this.#now() - this.#lastRoundAt >= this.#o.pollMs) {
      void this.#pollRound();
    }
    if (projectId !== null && (projectId !== previous || !wasAttentive)) {
      void this.refresh([projectId], {
        minAgeMs: this.#o.focusStaleMs,
        priority: 'event',
      }).catch(() => {});
    }
  }

  /** What a budget change looks like to the UI: send `forge.updated` when a host's state moves. */
  #announceBudget(): void {
    const key = JSON.stringify(this.#budget.snapshot().map((b) => [b.host, b.state]));
    if (key === this.#budgetKey) return;
    const first = this.#budgetKey === '';
    this.#budgetKey = key;
    // A budget appearing as `ok` is not news.
    if (first && this.#budget.snapshot().every((b) => b.state === 'ok')) return;
    this.#o.hub.emit({ type: 'forge.updated', projectIds: [] });
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#unsubscribe?.();
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#hotTimer) clearInterval(this.#hotTimer);
    for (const t of this.#debounce.values()) clearTimeout(t);
    this.#debounce.clear();
    for (const timers of this.#followUps.values()) for (const t of timers) clearTimeout(t);
    this.#followUps.clear();
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
   * A git change in one of the project's worktrees that `worktree.changed` does not announce: the
   * summary's state hash ignores branch config, so `git config branch.x.pushRemote` or
   * `remote.pushDefault` (a push destination change) never raises that event. The core reports
   * every watcher `git` dirtying here; the debounced refresh reads the push configuration (one
   * `git config` read when nothing else changed) and looks the project up when it differs.
   */
  gitChanged(projectId: string): void {
    this.#schedule(projectId);
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

  /**
   * Does a branch that was just pushed still have no request? (The follow-ups stop once it has
   * one, whichever lookup found it.)
   */
  #stillWaiting(projectId: string): boolean {
    const cache = this.#projects.get(projectId);
    if (!cache?.forge) return false;
    let waiting = false;
    for (const branch of [...cache.followBranches]) {
      const head = cache.heads.get(branch);
      if (!head) {
        cache.followBranches.delete(branch); // the branch is gone
        continue;
      }
      if (
        pickChangeRequest(
          cache.requests.get(head.headBranch) ?? [],
          head,
          cache.forge.repository,
        ) === null
      ) {
        waiting = true;
      } else {
        cache.followBranches.delete(branch); // found: no more lookups for it
      }
    }
    return waiting;
  }

  /** Looks the project up again later (forced: the 15 s spacing must not swallow it). */
  #followUp(projectId: string): void {
    if (this.#closed) return;
    for (const t of this.#followUps.get(projectId) ?? []) clearTimeout(t);
    const timers = this.#o.followUpMs.map((ms) => {
      const timer = setTimeout(() => {
        // Found in the meantime (by the poll, a refresh): the rest of the points are saved.
        if (!this.#stillWaiting(projectId)) return;
        void this.refresh([projectId], { force: true, priority: 'event' }).catch(() => {});
      }, ms);
      timer.unref();
      return timer;
    });
    this.#followUps.set(projectId, timers);
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
  async refresh(projectIds?: readonly string[], options: RefreshOptions = {}): Promise<void> {
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

  #refreshProject(item: ProjectListItem, options: RefreshOptions): Promise<void> {
    const id = item.project.id;
    let cache = this.#projects.get(id);
    if (!cache) {
      cache = emptyCache();
      this.#projects.set(id, cache);
    }
    if (cache.inflight) {
      // A forced fetch already running is as fresh as a new one would be (two browser tabs
      // refreshing the same project cost one forge query, as for details in `#load`).
      // A settings change (a host override, the switch) queues its own forced refresh: sharing a
      // batch that captured the previous settings would restore the old forge and requests.
      if (
        !options.force ||
        (cache.inflightForced && cache.inflightSettings === JSON.stringify(this.#forgeSettings()))
      ) {
        return cache.inflight;
      }
      // A forced refresh must see the forge as it is now, not a plain lookup that started earlier.
      return cache.inflight.then(() => this.#refreshProject(item, options));
    }
    const run = this.#doRefresh(item, cache, options)
      .catch((error) => {
        // Shutting down: git-core may already be disposed.
        if (this.#closed) return;
        this.#o.logger.warn('forge refresh failed', { projectId: id, error });
      })
      .finally(() => {
        if (cache) {
          cache.inflight = null;
          cache.inflightForced = false;
        }
      });
    cache.inflight = run;
    cache.inflightForced = options.force === true;
    cache.inflightSettings = JSON.stringify(this.#forgeSettings());
    return run;
  }

  async #doRefresh(
    item: ProjectListItem,
    cache: ProjectCache,
    options: RefreshOptions,
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
      // An edit never makes a project older than the poll would have left it be fetched again.
      const fresh = this.#now() - cache.lastFetch < Math.max(this.#pollBase(), this.#pollDelay);
      // A pushed branch can have a new request even though the branch set is the same.
      if (
        known === branchKeyLocal &&
        fresh &&
        !(await this.#pushChanged(item, cache, candidates))
      ) {
        return;
      }
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
    const pushKey = pushKeyOf(config, candidates);
    // Only a changed upstream or push destination is a push; a new worktree on a new branch is not.
    const pushedBranches =
      cache.pushKey !== null && cache.pushKey !== pushKey
        ? pushedBranchesOf(cache.pushKey, pushKey)
        : [];
    const pushed = pushedBranches.length > 0;
    cache.pushKey = pushKey;
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
    const now = this.#now();
    const unchanged = key === cache.fetchedKey;
    if (
      !options.force &&
      !pushed &&
      unchanged &&
      now - cache.lastFetch < (options.minAgeMs ?? this.#o.minRefetchMs)
    ) {
      return finish();
    }
    if (
      options.skipFresherThanMs !== undefined &&
      cache.status === 'ok' &&
      unchanged &&
      now - cache.lastFetch < options.skipFresherThanMs
    ) {
      return finish();
    }
    const points = estimateQueryPoints(forge.kind, 'batch', heads.length);
    if (options.allowance && options.allowance.left < points) return finish();
    const priority =
      options.priority ??
      (options.force ? 'interactive' : options.onlyIfBranchesChanged ? 'event' : 'background');
    const verdict = this.#budget.decide(forge.kind, forge.host, priority, points);
    if (!verdict.ok) {
      this.#o.logger.debug('forge fetch held back', { projectId, reason: verdict.reason });
      // Nothing loaded yet: say why. Otherwise the last good data stays as it is.
      if (cache.status === 'pending') set('pending', verdict.message);
      return finish();
    }
    if (options.allowance) options.allowance.left -= points;
    if (cache.status !== 'ok' && cache.status !== 'error') {
      set('pending', null);
      // The forge is known now and the lookup starts: tell the clients at once, so a slow first
      // lookup is named ("Waiting for GitHub...") while it runs, not only after it finished.
      this.#o.hub.emit({ type: 'forge.updated', projectIds: [projectId] });
    }
    cache.lastFetch = now;
    this.#budget.spend(forge.kind, forge.host, points);
    try {
      const fetched = await this.#o.client.fetchChangeRequests(forge, heads);
      this.#budget.succeeded(forge.kind, forge.host);
      cache.requests = fetched;
      cache.fetchedKey = key;
      cache.fetchedAt = this.#o.now().toISOString();
      set('ok', null);
      if (pushed) {
        // Branches still waiting for a request from an earlier push stay on the list.
        cache.followBranches = new Set([...cache.followBranches, ...pushedBranches]);
        if (this.#stillWaiting(projectId)) this.#followUp(projectId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isRateLimitMessage(message)) this.#budget.rateLimited(forge.kind, forge.host);
      set('error', message);
      this.#o.logger.debug('forge fetch failed', { projectId, error });
    }
    this.#announceBudget();
    return finish();
  }

  /** Did a candidate's upstream or push configuration change since the last look? (one git config read) */
  async #pushChanged(
    item: ProjectListItem,
    cache: ProjectCache,
    candidates: readonly Candidate[],
  ): Promise<boolean> {
    if (cache.pushKey === null || !this.#o.gitCore.readRemoteConfig) return false;
    const config = await this.#o.gitCore.readRemoteConfig({
      id: item.project.id,
      commonDir: item.project.commonDir,
    });
    return pushKeyOf(config, candidates) !== cache.pushKey;
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
   * value (stale-while-error). `force` (the user pressed Refresh) always refetches, with no
   * spacing: a fetch already running is shared when it was forced too, else it is awaited and a
   * new one follows (its answer may predate the click). Without `force`, a retry after an error
   * or a missing object waits `minRefetchMs` (a changed fingerprint or an expired TTL does not).
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
    if (entry.inflight) {
      if (!force || entry.inflightForced) return entry.inflight;
      await entry.inflight;
      return this.#load(entry, ttl, fingerprint, force, fetch);
    }
    if (fresh && !force) return;
    if (!force && !spaced && (entry.missing || entry.error !== null)) {
      return;
    }
    entry.lastAttempt = now;
    entry.inflightForced = force;
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

  /**
   * Admits one single-object query (detail, conversation, repository) against the budget. These
   * run because someone opened or refreshed something, so they use the user's ceiling (a timer, such
   * as the open Overview's reload, passes `background` and gets only the background share); a refusal
   * surfaces as the entry's error, with the last good data kept.
   */
  async #guarded<T>(
    forge: ForgeTargetLike,
    kind: ForgeQueryKind,
    run: () => Promise<T>,
    priority: ForgePriority = 'interactive',
  ): Promise<T> {
    const points = estimateQueryPoints(forge.kind, kind);
    const verdict = this.#budget.decide(forge.kind, forge.host, priority, points);
    if (!verdict.ok) throw new ForgeBudgetError(verdict.message);
    this.#budget.spend(forge.kind, forge.host, points);
    try {
      const value = await run();
      this.#budget.succeeded(forge.kind, forge.host);
      return value;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isRateLimitMessage(message)) this.#budget.rateLimited(forge.kind, forge.host);
      throw error;
    } finally {
      this.#announceBudget();
    }
  }

  /** Marks an entry as used and keeps the map to `maxCacheEntries` (least recently used out). */
  #touch<T>(map: Map<string, Entry<T>>, entry: Entry<T>): void {
    entry.lastAccess = this.#now();
    if (map.size <= this.#o.maxCacheEntries) return;
    const idle = [...map].filter(([, e]) => e.inflight === null && e !== entry);
    idle.sort(([, a], [, b]) => a.lastAccess - b.lastAccess);
    for (const [key] of idle) {
      if (map.size <= this.#o.maxCacheEntries) break;
      map.delete(key);
    }
  }

  /** Drops entries nobody asked for in `cacheMaxAgeMs` (a long-running daemon keeps no old request). */
  #sweepCaches(): void {
    const limit = this.#now() - this.#o.cacheMaxAgeMs;
    for (const map of [this.#details, this.#conversations, this.#repositories] as Array<
      Map<string, Entry<unknown>>
    >) {
      for (const [key, entry] of map) {
        if (entry.inflight === null && entry.lastAccess < limit) map.delete(key);
      }
    }
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
    this.#touch(this.#details, entry);
    await this.#load(
      entry,
      this.#ttlFor(changeRequest),
      fingerprintOf(changeRequest),
      options.force ?? false,
      () => this.#guarded(forge, 'detail', () => fetchDetail(forge, changeRequest.number)),
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
    this.#touch(this.#conversations, entry);
    // The conversation does not change with CI: only the request's update time and head count.
    const fingerprint = `${changeRequest.updatedAt ?? ''}|${changeRequest.headSha ?? ''}`;
    await this.#load(entry, this.#ttlFor(changeRequest), fingerprint, options.force ?? false, () =>
      this.#guarded(forge, 'conversation', () => fetchConversation(forge, changeRequest.number)),
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

  /**
   * Settings "Check again" (`POST /api/forges/refresh`): re-probe the CLIs and refetch every
   * project, but a project fetched in the last `checkAgainSkipMs` (5 s) is left alone (a double click costs
   * nothing) and one call spends at most `checkAgainMaxPoints`; the poll catches up with the rest.
   */
  async checkAgain(projectIds?: readonly string[]): Promise<void> {
    await this.refresh(projectIds, {
      force: true,
      skipFresherThanMs: this.#o.checkAgainSkipMs,
      allowance: { left: this.#o.checkAgainMaxPoints },
    });
  }

  /**
   * `POST /api/forges/worktrees/:worktreeId/request/refresh`: the user asked the forge again, so
   * nothing may be served from a cache. The project's batch (the chip, the header, the matched
   * request and the cache keys derive from it) is refetched first, then the detail and the
   * conversation, each with no spacing. Costs three queries (3 points).
   */
  async refreshRequest(worktreeId: string): Promise<ChangeRequestDetailResponse> {
    const items = await this.#o.core.listProjects();
    const item = items.find((i) => i.worktrees.some((w) => w.worktree.id === worktreeId));
    if (!item) throw new ApiError('not_found', `unknown worktree: ${worktreeId}`);
    if (this.enabled) await this.refresh([item.project.id], { force: true });
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
    options: { force?: boolean; ttlMs?: number; priority?: ForgePriority } = {},
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
    this.#touch(this.#repositories, entry);
    // The batch's set of requests is part of the key: a request it just discovered (or one that
    // was merged) makes the cached list of open requests wrong long before its 10 minutes.
    await this.#load(
      entry,
      options.ttlMs ?? FORGE_REPOSITORY_TTL_MS,
      requestsSignature(cache),
      options.force ?? false,
      () => this.#guarded(forge, 'repository', () => fetchRepository(forge), options.priority),
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
    const budgets = enabled ? this.#budget.snapshot() : [];
    return {
      enabled,
      clis: FORGE_KINDS.map((k) => this.#clis.get(k)).filter((c): c is ForgeCliStatus => !!c),
      projects,
      ...(budgets.length > 0 ? { budgets } : {}),
      generatedAt: this.#o.now().toISOString(),
    };
  }
}
