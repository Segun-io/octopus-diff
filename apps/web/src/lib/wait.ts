import type { ForgeBudgetState, ForgeKind, ForgesResponse } from '@octopus-diff/contracts';
import { relativeTime } from './time.ts';

/**
 * Loading states that say who is slow (GitHub issue #11, DECISIONS #212). Pure logic only; the
 * hooks are in `api/wait.ts` and the components in `components/WaitNote.tsx`.
 *
 * Two sources are told apart: a forge request (GitHub or GitLab: PR chips, the Request tab, the
 * Overview's repository facts) and local work (file lists, diffs, the inbox batches, review states
 * after a project was opened). `GET /api/forges` itself is a cache read on the daemon and counts
 * as local; only a project whose forge state is `pending`, or a request that must reach the forge,
 * is a wait on the forge.
 */

/**
 * A wait is only named once it has lasted this long. Below it the skeleton is all the user sees,
 * so a fast load never flashes text.
 */
export const WAIT_NOTE_DELAY_MS = 700;

/**
 * "Loading from your computer" after a project was opened stops being claimed this long after
 * the project's review states were first seen missing: a daemon that never sends them (older than
 * #10) must not leave the note up for ever. The state itself comes from the summaries.
 */
export const REVIEW_WAIT_GIVE_UP_MS = 30_000;

/** How often a shown "Last updated 3 min ago" is recomputed (a display clock, not a state signal). */
export const STALE_CLOCK_MS = 30_000;

export type WaitSource =
  | { kind: 'local' }
  | { kind: 'forge'; forge: readonly ForgeKind[]; budget?: ForgeBudgetState | null };

export const LOCAL_WAIT: WaitSource = { kind: 'local' };

export function forgeSource(
  forge: ForgeKind | readonly ForgeKind[],
  budget?: ForgeBudgetState | null,
): WaitSource {
  const kinds = typeof forge === 'string' ? [forge] : [...new Set(forge)].sort();
  return { kind: 'forge', forge: kinds, budget: budget ?? null };
}

export function forgeName(kind: ForgeKind): string {
  return kind === 'github' ? 'GitHub' : 'GitLab';
}

function names(kinds: readonly ForgeKind[]): string {
  const list = kinds.map(forgeName);
  return list.length === 0 ? 'the forge' : list.join(' and ');
}

export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * What a host's budget says to the user, or null while it is fine. `backoff`: refused, waiting
 * for the reset; `low`: little left, only requests the user asked for run; `busy`: the daemon is
 * using a lot of the quota and polls slower (docs/FORGES.md 3a).
 */
export function budgetPhrase(
  budget: ForgeBudgetState | null | undefined,
  clock: (iso: string) => string = clockTime,
): string | null {
  if (!budget || budget.state === 'ok') return null;
  const who = forgeName(budget.kind);
  switch (budget.state) {
    case 'backoff':
      return budget.resumeAt
        ? `${who} is rate-limiting requests, retrying at ${clock(budget.resumeAt)}`
        : `${who} is rate-limiting requests, retrying later`;
    case 'low':
      return budget.resumeAt
        ? `Your ${who} quota is nearly used up, checking only on request until ${clock(budget.resumeAt)}`
        : `Your ${who} quota is nearly used up, checking only on request`;
    case 'busy':
      return `Using a lot of your ${who} quota, polling slower`;
  }
}

/** The text of a wait: the budget's reason when the host is held back, else who is slow. */
export function waitText(source: WaitSource, clock: (iso: string) => string = clockTime): string {
  if (source.kind === 'local') return 'Loading from your computer…';
  return budgetPhrase(source.budget, clock) ?? `Waiting for ${names(source.forge)}…`;
}

/** `Last updated 3 min ago`; `Last updated a while ago` when the time is unknown. */
export function staleText(updatedAt: number | string | null | undefined, now: number): string {
  if (updatedAt === null || updatedAt === undefined) return 'Last updated a while ago';
  const iso = typeof updatedAt === 'number' ? new Date(updatedAt).toISOString() : updatedAt;
  const ago = relativeTime(iso, now);
  return ago === 'unknown' ? 'Last updated a while ago' : `Last updated ${ago}`;
}

/** The budget of the host `host`, or of the first host of `kind` when no host is given. */
export function budgetFor(
  budgets: ForgesResponse['budgets'],
  match: { host?: string | undefined; kind?: ForgeKind | undefined },
): ForgeBudgetState | null {
  if (!budgets) return null;
  if (match.host) {
    const byHost = budgets.find((b) => b.host === match.host);
    if (byHost) return byHost;
  }
  if (match.kind && !match.host) return budgets.find((b) => b.kind === match.kind) ?? null;
  return null;
}

/** The budget that holds lookups back (`backoff`, `low`, `busy`) over those that do not. */
export function worstBudget(budgets: readonly ForgeBudgetState[]): ForgeBudgetState | null {
  const rank = { ok: 0, busy: 1, low: 2, backoff: 3 } as const;
  let worst: ForgeBudgetState | null = null;
  for (const b of budgets) {
    if (b.state !== 'ok' && (!worst || rank[b.state] > rank[worst.state])) worst = b;
  }
  return worst;
}

/** Why shown data is old, and since when. */
export interface StaleInfo {
  /** The time of the data on screen: the forge fetch (ISO) or the query's `dataUpdatedAt`. */
  updatedAt: string | number | null;
  reason: string;
  /** The daemon's own message, for a tooltip. */
  detail: string | null;
  /** The host's budget holds lookups back (rather than one fetch having failed). */
  held: boolean;
}

/**
 * Is the data on screen older than it should be, and why? Only real signals count: the daemon
 * holds lookups back (the host's budget is `backoff` or `low`), the last fetch failed (`message`;
 * the daemon keeps the last good data), or the browser's own refetch failed with data cached.
 * Never a timer: data that is merely old is not stale, it is just not refreshed yet.
 */
export function describeStale(input: {
  forge: ForgeKind | null;
  fetchedAt: string | null;
  message: string | null;
  budget: ForgeBudgetState | null | undefined;
  failed?: boolean;
  dataUpdatedAt?: number | null;
  clock?: (iso: string) => string;
}): StaleInfo | null {
  const updatedAt = input.fetchedAt ?? input.dataUpdatedAt ?? null;
  const held = input.budget && (input.budget.state === 'backoff' || input.budget.state === 'low');
  if (held) {
    return {
      updatedAt,
      reason: budgetPhrase(input.budget, input.clock) ?? '',
      detail: input.budget?.message ?? null,
      held: true,
    };
  }
  if (input.message) {
    return {
      updatedAt,
      reason: input.forge
        ? `Could not refresh from ${forgeName(input.forge)}`
        : 'Could not refresh',
      detail: input.message,
      held: false,
    };
  }
  if (input.failed) return { updatedAt, reason: 'Could not refresh', detail: null, held: false };
  return null;
}

/**
 * Forge projects whose request lookup is running or queued (status `pending`), by forge kind. On a
 * cold start a project is `pending` with no forge yet (the daemon has not worked out which forge
 * its remotes are on): that wait is real too, named "the forge" until the forge is known.
 */
export function pendingForgeWait(forges: ForgesResponse | null | undefined): WaitSource | null {
  if (!forges?.enabled) return null;
  const pending = forges.projects.filter((p) => p.status === 'pending');
  if (pending.length === 0) return null;
  const kinds = pending.flatMap((p) => (p.forge ? [p.forge.kind] : []));
  const hosts = new Set(pending.flatMap((p) => (p.forge ? [p.forge.host] : [])));
  const budget = worstBudget((forges.budgets ?? []).filter((b) => hosts.has(b.host)));
  return forgeSource(kinds, budget);
}

/** The projects' stale state as one note: the oldest data, a rate limit's reason before a failure's. */
export function forgeStale(
  forges: ForgesResponse | null | undefined,
  clock?: (iso: string) => string,
): StaleInfo | null {
  if (!forges?.enabled) return null;
  const infos: StaleInfo[] = [];
  let oldest: string | null = null;
  for (const p of forges.projects) {
    if (!p.forge || !p.fetchedAt) continue; // nothing on screen came from the forge yet
    const info = describeStale({
      forge: p.forge.kind,
      fetchedAt: p.fetchedAt,
      message: p.status === 'error' ? p.message : null,
      budget: (forges.budgets ?? []).find((b) => b.host === p.forge?.host),
      ...(clock ? { clock } : {}),
    });
    if (!info) continue;
    infos.push(info);
    if (oldest === null || p.fetchedAt < oldest) oldest = p.fetchedAt;
  }
  const pick = infos.find((i) => i.held) ?? infos[0];
  return pick ? { ...pick, updatedAt: oldest } : null;
}
