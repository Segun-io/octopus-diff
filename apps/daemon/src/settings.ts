import {
  type AppSettings,
  type AppSettingsPatch,
  type EffectiveReviewPolicy,
  type Logger,
  type ResolveReviewPolicyInput,
  type ReviewOverride,
  type ReviewPolicyTarget,
  resolveReviewPolicyFromMap,
  reviewTargetKey,
  type SettingsResponse,
} from '@octopus-diff/contracts';
import type { EventHub } from './events.js';
import type { ReviewPolicyProvider } from './review-policy.js';
import type { StoredReviewOverride } from './settings-store.js';
import type { Store } from './store.js';

export interface SettingsServiceOptions {
  store: Store;
  hub: EventHub;
  logger: Logger;
  now?: () => Date;
}

const KIND_ORDER: Record<ReviewPolicyTarget['kind'], number> = {
  folder: 0,
  project: 1,
  branch: 2,
  worktree: 3,
};

function compareOverrides(a: ReviewOverride, b: ReviewOverride): number {
  const ka = KIND_ORDER[a.target.kind];
  const kb = KIND_ORDER[b.target.kind];
  if (ka !== kb) return ka - kb;
  const sa = reviewTargetKey(a.target);
  const sb = reviewTargetKey(b.target);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/**
 * App settings and review-policy overrides (COORDINATION §2.1, §2.3): the daemon-side, shared
 * state. Everything is kept in memory (loaded once from SQLite, written through on change), so
 * resolving the effective policy of a worktree is a few map lookups on the hot list paths.
 *
 * `revision` increases on every change of settings or overrides, is persisted, and is sent in the
 * `settings.changed` event (also to the caller of the change). Precedence is never computed here:
 * `resolve` delegates to the contracts' `resolveReviewPolicyFromMap`.
 */
export class SettingsService implements ReviewPolicyProvider {
  readonly #store: Store;
  readonly #hub: EventHub;
  readonly #log: Logger;
  readonly #now: () => Date;
  #settings: AppSettings;
  #revision: number;
  /** Overrides by `reviewTargetKey`. */
  readonly #overrides = new Map<string, StoredReviewOverride>();
  /** key -> enabled, the shape the contract resolver wants; rebuilt on change. */
  #map: ReadonlyMap<string, boolean> = new Map();

  constructor(options: SettingsServiceOptions) {
    this.#store = options.store;
    this.#hub = options.hub;
    this.#log = options.logger;
    this.#now = options.now ?? (() => new Date());
    this.#settings = this.#store.settings.getSettings();
    this.#revision = this.#store.settings.getRevision();
    for (const o of this.#store.settings.listOverrides()) {
      this.#overrides.set(reviewTargetKey(o.target), o);
    }
    this.#rebuildMap();
  }

  get revision(): number {
    return this.#revision;
  }

  get settings(): AppSettings {
    return this.#settings;
  }

  get defaultEnabled(): boolean {
    return this.#settings.review.defaultEnabled;
  }

  /** The current override map (shared, read-only; rebuilt on every change). */
  overrideMap(): ReadonlyMap<string, boolean> {
    return this.#map;
  }

  /** Full `GET /api/settings` response. */
  response(): SettingsResponse {
    const overrides: ReviewOverride[] = [...this.#overrides.values()]
      .map((o) => ({ target: o.target, enabled: o.enabled, updatedAt: o.updatedAt }))
      .sort(compareOverrides);
    return { settings: structuredClone(this.#settings), overrides, revision: this.#revision };
  }

  /** `PATCH /api/settings`: partial update; a no-op patch keeps the revision. */
  update(patch: AppSettingsPatch): SettingsResponse {
    const next: AppSettings = {
      ...this.#settings,
      review: { ...this.#settings.review, ...(patch.review ?? {}) },
    };
    if (JSON.stringify(next) !== JSON.stringify(this.#settings)) {
      this.#store.transaction(() => {
        this.#store.settings.setSettings(next);
        this.#store.settings.setRevision(this.#revision + 1);
      });
      this.#settings = next;
      this.#bumped();
    }
    return this.response();
  }

  /**
   * `PUT /api/review-policy`: sets (`enabled` boolean) or removes (`null`) the override of a
   * target the caller has already validated. `owner.projectId` is the worktree's project (needed
   * so the row is deleted with the project). Identical state keeps the revision.
   */
  setOverride(
    target: ReviewPolicyTarget,
    enabled: boolean | null,
    owner: { projectId: string | null },
  ): SettingsResponse {
    const key = reviewTargetKey(target);
    const existing = this.#overrides.get(key);
    if (enabled === null) {
      if (existing) {
        this.#store.transaction(() => {
          this.#store.settings.deleteOverride(target);
          this.#store.settings.setRevision(this.#revision + 1);
        });
        this.#overrides.delete(key);
        this.#rebuildMap();
        this.#bumped();
      }
      return this.response();
    }
    if (existing && existing.enabled === enabled) return this.response();
    const updatedAt = this.#now().toISOString();
    const projectId =
      target.kind === 'folder'
        ? null
        : target.kind === 'worktree'
          ? owner.projectId
          : target.projectId;
    this.#store.transaction(() => {
      this.#store.settings.upsertOverride(target, enabled, updatedAt, { projectId });
      this.#store.settings.setRevision(this.#revision + 1);
    });
    this.#overrides.set(key, {
      target,
      enabled,
      updatedAt,
      projectId,
      scanRootId: target.kind === 'folder' ? target.scanRootId : null,
    });
    this.#rebuildMap();
    this.#bumped();
    return this.response();
  }

  /** Effective policy of one worktree (the contracts' precedence rule over the cached map). */
  resolve(
    input: Omit<ResolveReviewPolicyInput, 'overrides' | 'defaultEnabled'>,
  ): EffectiveReviewPolicy {
    return resolveReviewPolicyFromMap(
      { ...input, defaultEnabled: this.#settings.review.defaultEnabled },
      this.#map,
    );
  }

  /** Deletes the project, branch and worktree overrides of a removed project. */
  onProjectRemoved(projectId: string): void {
    this.#cleanup(
      (o) => o.projectId === projectId,
      () => this.#store.settings.deleteOverridesForProject(projectId),
    );
  }

  /** Deletes the folder override of a removed scan root (its projects are dropped separately). */
  onScanRootRemoved(scanRootId: string): void {
    this.#cleanup(
      (o) => o.scanRootId === scanRootId,
      () => this.#store.settings.deleteOverridesForScanRoot(scanRootId),
    );
  }

  #cleanup(matches: (o: StoredReviewOverride) => boolean, run: () => number): void {
    const keys = [...this.#overrides.entries()].filter(([, o]) => matches(o)).map(([k]) => k);
    if (keys.length === 0) return;
    try {
      this.#store.transaction(() => {
        run();
        this.#store.settings.setRevision(this.#revision + 1);
      });
    } catch (error) {
      this.#log.warn('could not delete review overrides', { error });
      return;
    }
    for (const k of keys) this.#overrides.delete(k);
    this.#rebuildMap();
    this.#bumped();
  }

  #rebuildMap(): void {
    const map = new Map<string, boolean>();
    for (const [key, o] of this.#overrides) map.set(key, o.enabled);
    this.#map = map;
  }

  #bumped(): void {
    this.#revision += 1;
    this.#hub.emit({ type: 'settings.changed', revision: this.#revision });
  }
}
