import type { ForgeBudgetState, ForgeKind } from '@octopus-diff/contracts';

/**
 * The forge rate-limit budget (DECISIONS #197). GitHub allows 5 000 GraphQL points per hour per
 * user, shared by every tool that uses the same sign-in (the user's terminal `gh`, T3 Code, CI
 * helpers), so octopus-diff keeps its own ceilings well under it and keeps a reserve for them:
 *
 *   background (the poll, the hot-project poll)   stops at   1 500 points in the last hour
 *   event-driven (a push, a new branch, focus)    stops at   2 500
 *   user-asked (Refresh, Check again, opening)    stops at   4 000
 *
 * and stops everything when the forge itself reports few points left or refuses a request
 * (exponential backoff, until the reported reset when known). Per host: gitlab.com, a GitHub
 * Enterprise Server and github.com have separate limits. For GitLab a request counts as one unit;
 * its real limits are far above these ceilings, so only the backoff ever matters there.
 *
 * The ledger holds estimates (`estimateQueryPoints`, arithmetic from the query shape); the
 * forge's own `remaining` (every GitHub response carries it) is the authority and overrides them
 * whenever it is known.
 */

export type ForgePriority = 'interactive' | 'event' | 'background';

export interface BudgetLimits {
  background: number;
  event: number;
  interactive: number;
  /** Below this many points left (as the forge reports) only user-asked requests run. */
  lowRemaining: number;
  /** Below this many points left nothing runs. */
  floorRemaining: number;
}

export const DEFAULT_BUDGET_LIMITS: BudgetLimits = {
  background: 1500,
  event: 2500,
  interactive: 4000,
  lowRemaining: 500,
  floorRemaining: 100,
};

const HOUR_MS = 3_600_000;
const BACKOFF_FIRST_MS = 5 * 60_000;
const BACKOFF_MAX_MS = 60 * 60_000;

export type BudgetVerdict =
  | { ok: true }
  | { ok: false; reason: 'backoff' | 'low' | 'busy'; message: string; resumeAt: number | null };

interface HostLedger {
  kind: ForgeKind;
  entries: Array<{ at: number; points: number }>;
  remaining: number | null;
  /** When `remaining` was last reported (it expires with the window, at the latest after an hour). */
  remainingAt: number;
  resetAt: number | null;
  backoffUntil: number;
  backoffStep: number;
}

export class ForgeBudget {
  readonly limits: BudgetLimits;
  readonly #now: () => number;
  readonly #hosts = new Map<string, HostLedger>();
  /** Everything ever spent (monotonic): the poll measures a round by its difference. */
  #total = 0;

  constructor(options: { now: () => number; limits?: Partial<BudgetLimits> }) {
    this.#now = options.now;
    this.limits = { ...DEFAULT_BUDGET_LIMITS, ...options.limits };
  }

  get totalSpent(): number {
    return this.#total;
  }

  #host(kind: ForgeKind, host: string): HostLedger {
    let ledger = this.#hosts.get(host);
    if (!ledger) {
      ledger = {
        kind,
        entries: [],
        remaining: null,
        remainingAt: 0,
        resetAt: null,
        backoffUntil: 0,
        backoffStep: 0,
      };
      this.#hosts.set(host, ledger);
    }
    return ledger;
  }

  #spent(ledger: HostLedger, now: number): number {
    while (ledger.entries.length > 0 && (ledger.entries[0]?.at ?? now) <= now - HOUR_MS) {
      ledger.entries.shift();
    }
    return ledger.entries.reduce((n, e) => n + e.points, 0);
  }

  /** The forge's `remaining` while its window is still the one that reported it. */
  #remaining(ledger: HostLedger, now: number): number | null {
    if (ledger.remaining === null) return null;
    if (ledger.resetAt !== null && ledger.resetAt <= now) return null;
    if (now - ledger.remainingAt > HOUR_MS) return null;
    return ledger.remaining;
  }

  /** When enough old spending expires for `points` more to fit under `cap`. */
  #resumeFor(ledger: HostLedger, cap: number, points: number, now: number): number | null {
    let spent = this.#spent(ledger, now);
    for (const entry of ledger.entries) {
      spent -= entry.points;
      if (spent + points <= cap) return entry.at + HOUR_MS;
    }
    return null;
  }

  /** May a query of `points` run for `priority`? Does not spend. */
  decide(kind: ForgeKind, host: string, priority: ForgePriority, points: number): BudgetVerdict {
    const now = this.#now();
    const ledger = this.#host(kind, host);
    if (now < ledger.backoffUntil) {
      return {
        ok: false,
        reason: 'backoff',
        message: `${host} refused the last request because its rate limit is used up; lookups are paused.`,
        resumeAt: ledger.backoffUntil,
      };
    }
    const remaining = this.#remaining(ledger, now);
    if (remaining !== null) {
      const low =
        remaining - points < this.limits.floorRemaining ||
        (remaining < this.limits.lowRemaining && priority !== 'interactive');
      if (low) {
        return {
          ok: false,
          reason: 'low',
          message: `${host} reports only ${remaining} rate-limit points left; lookups wait for its next window.`,
          resumeAt: ledger.resetAt,
        };
      }
    }
    const cap = this.limits[priority];
    if (this.#spent(ledger, now) + points > cap) {
      return {
        ok: false,
        reason: 'busy',
        message: `octopus-diff has used its share of the ${host} rate limit this hour (${this.#spent(ledger, now)} of ${cap} points); lookups resume as the hour passes.`,
        resumeAt: this.#resumeFor(ledger, cap, points, now),
      };
    }
    return { ok: true };
  }

  /** Records a query that is about to run. */
  spend(kind: ForgeKind, host: string, points: number): void {
    const now = this.#now();
    const ledger = this.#host(kind, host);
    ledger.entries.push({ at: now, points });
    this.#total += points;
    if (ledger.remaining !== null) ledger.remaining = Math.max(0, ledger.remaining - points);
  }

  /** The forge's own numbers from a response (`rateLimit { cost remaining resetAt }`). */
  observe(
    kind: ForgeKind,
    host: string,
    seen: { remaining: number | null; resetAt: string | null },
  ): void {
    const ledger = this.#host(kind, host);
    if (seen.remaining !== null) {
      ledger.remaining = seen.remaining;
      ledger.remainingAt = this.#now();
    }
    if (seen.resetAt !== null) {
      const at = Date.parse(seen.resetAt);
      if (Number.isFinite(at)) ledger.resetAt = at;
    }
  }

  /** The forge refused: stop asking, until its reset when known, else with growing pauses. */
  rateLimited(kind: ForgeKind, host: string): void {
    const now = this.#now();
    const ledger = this.#host(kind, host);
    if (now < ledger.backoffUntil) return; // several queries failed at once: one backoff
    const reset = ledger.resetAt;
    const fromReset =
      reset !== null && reset > now && reset - now <= HOUR_MS + 300_000 ? reset + 5_000 : null;
    const stepped = Math.min(BACKOFF_FIRST_MS * 2 ** ledger.backoffStep, BACKOFF_MAX_MS);
    ledger.backoffUntil = now + (fromReset !== null ? fromReset - now : stepped);
    ledger.backoffStep += 1;
    if (fromReset !== null) {
      ledger.remaining = 0;
      ledger.remainingAt = now;
    }
  }

  /** A query succeeded: the next refusal starts the backoff from the beginning again. */
  succeeded(kind: ForgeKind, host: string): void {
    const ledger = this.#host(kind, host);
    if (this.#now() >= ledger.backoffUntil) ledger.backoffStep = 0;
  }

  /** One entry per host that was asked; the state the UI shows. */
  snapshot(): ForgeBudgetState[] {
    const now = this.#now();
    const out: ForgeBudgetState[] = [];
    for (const [host, ledger] of [...this.#hosts].sort(([a], [b]) => a.localeCompare(b))) {
      const spent = this.#spent(ledger, now);
      const remaining = this.#remaining(ledger, now);
      let state: ForgeBudgetState['state'] = 'ok';
      let message: string | null = null;
      let resumeAt: number | null = null;
      if (now < ledger.backoffUntil) {
        state = 'backoff';
        resumeAt = ledger.backoffUntil;
        message = `${host} refused a request because its rate limit is used up. Lookups are paused.`;
      } else if (remaining !== null && remaining < this.limits.lowRemaining) {
        state = 'low';
        resumeAt = ledger.resetAt;
        message = `${host} reports ${remaining} points left. Only requests you ask for run until its window resets.`;
      } else if (spent >= this.limits.background) {
        state = 'busy';
        resumeAt = this.#resumeFor(ledger, this.limits.background, 1, now);
        message = `octopus-diff has used its background share of the ${host} rate limit this hour. Automatic lookups resume as the hour passes.`;
      }
      out.push({
        host,
        kind: ledger.kind,
        state,
        spentLastHour: spent,
        backgroundLimit: this.limits.background,
        hourlyLimit: this.limits.interactive,
        remaining,
        resetAt: ledger.resetAt === null ? null : new Date(ledger.resetAt).toISOString(),
        resumeAt: resumeAt === null ? null : new Date(resumeAt).toISOString(),
        message,
      });
    }
    return out;
  }
}
