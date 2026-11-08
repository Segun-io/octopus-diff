import type { DatabaseSync, StatementSync } from 'node:sqlite';
import {
  type AppSettings,
  AppSettingsSchema,
  DEFAULT_APP_SETTINGS,
  type ReviewOverride,
  type ReviewPolicyTarget,
  reviewTargetKey,
} from '@octopus-diff/contracts';

/**
 * SQLite migration v2 (UX round 1, COORDINATION §2.3): app settings and review-policy overrides.
 *
 * `settings` is a key/value table of JSON documents: `app` holds the `AppSettings` document and
 * `revision` the counter that `SettingsResponse.revision` / `settings.changed` report (persisted
 * so it keeps increasing across restarts). `review_overrides` has one row per target, keyed by
 * `reviewTargetKey`; `project_id` / `scan_root_id` are filled for every kind they apply to so the
 * overrides of a removed project (project, branch and worktree rows) or scan root can be deleted
 * with one statement. Nothing here refers to anything inside a repository.
 */
export const SETTINGS_MIGRATION_V2 = `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE review_overrides (
    target_key TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    scan_root_id TEXT,
    project_id TEXT,
    branch TEXT,
    worktree_id TEXT,
    enabled INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX review_overrides_project ON review_overrides (project_id);
  CREATE INDEX review_overrides_scan_root ON review_overrides (scan_root_id);
`;

const SETTINGS_KEY = 'app';
const REVISION_KEY = 'revision';

/** A stored override plus the owner columns used for cleanup. */
export interface StoredReviewOverride extends ReviewOverride {
  /** Owning project for project/branch/worktree targets; null for folders. */
  projectId: string | null;
  /** The scan root for folder targets; null otherwise. */
  scanRootId: string | null;
}

type Row = Record<string, unknown>;

const str = (v: unknown): string => String(v);
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function targetFromRow(r: Row): ReviewPolicyTarget | null {
  switch (r.kind) {
    case 'folder':
      return r.scan_root_id ? { kind: 'folder', scanRootId: str(r.scan_root_id) } : null;
    case 'project':
      return r.project_id ? { kind: 'project', projectId: str(r.project_id) } : null;
    case 'branch':
      return r.project_id && r.branch
        ? { kind: 'branch', projectId: str(r.project_id), branch: str(r.branch) }
        : null;
    case 'worktree':
      return r.worktree_id ? { kind: 'worktree', worktreeId: str(r.worktree_id) } : null;
    default:
      return null;
  }
}

/**
 * Merges a stored settings document with the defaults, so settings added later get their default
 * and a corrupt document falls back instead of failing startup.
 */
export function parseStoredSettings(json: string | null): AppSettings {
  if (json === null) return structuredClone(DEFAULT_APP_SETTINGS);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return structuredClone(DEFAULT_APP_SETTINGS);
  }
  const merged = {
    ...DEFAULT_APP_SETTINGS,
    ...(typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}),
    review: {
      ...DEFAULT_APP_SETTINGS.review,
      ...((parsed as { review?: Record<string, unknown> } | null)?.review ?? {}),
    },
  };
  const result = AppSettingsSchema.safeParse(merged);
  return result.success ? result.data : structuredClone(DEFAULT_APP_SETTINGS);
}

/**
 * Data access for the v2 tables. Methods never open transactions themselves: callers wrap them in
 * `Store.transaction` when several statements must be atomic.
 */
export class SettingsStore {
  readonly #db: DatabaseSync;
  readonly #stmts = new Map<string, StatementSync>();

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  #stmt(sql: string): StatementSync {
    let stmt = this.#stmts.get(sql);
    if (!stmt) {
      stmt = this.#db.prepare(sql);
      this.#stmts.set(sql, stmt);
    }
    return stmt;
  }

  #getValue(key: string): string | null {
    const row = this.#stmt('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined;
    return row === undefined ? null : str(row.value);
  }

  #setValue(key: string, value: string): void {
    this.#stmt(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    ).run(key, value);
  }

  getRevision(): number {
    const raw = this.#getValue(REVISION_KEY);
    const n = raw === null ? 0 : Number(raw);
    return Number.isSafeInteger(n) && n >= 0 ? n : 0;
  }

  setRevision(revision: number): void {
    this.#setValue(REVISION_KEY, String(revision));
  }

  getSettings(): AppSettings {
    return parseStoredSettings(this.#getValue(SETTINGS_KEY));
  }

  setSettings(settings: AppSettings): void {
    this.#setValue(SETTINGS_KEY, JSON.stringify(settings));
  }

  listOverrides(): StoredReviewOverride[] {
    const rows = this.#stmt('SELECT * FROM review_overrides ORDER BY target_key').all() as Row[];
    const out: StoredReviewOverride[] = [];
    for (const r of rows) {
      const target = targetFromRow(r);
      if (!target) continue;
      out.push({
        target,
        enabled: Number(r.enabled) === 1,
        updatedAt: str(r.updated_at),
        projectId: strOrNull(r.project_id),
        scanRootId: strOrNull(r.scan_root_id),
      });
    }
    return out;
  }

  /** Inserts or replaces the override of `target`. `owner.projectId` is required for worktrees. */
  upsertOverride(
    target: ReviewPolicyTarget,
    enabled: boolean,
    updatedAt: string,
    owner: { projectId: string | null },
  ): void {
    const projectId =
      target.kind === 'folder'
        ? null
        : target.kind === 'worktree'
          ? owner.projectId
          : target.projectId;
    this.#stmt(
      `INSERT INTO review_overrides
         (target_key, kind, scan_root_id, project_id, branch, worktree_id, enabled, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (target_key) DO UPDATE SET
         enabled = excluded.enabled, updated_at = excluded.updated_at, project_id = excluded.project_id`,
    ).run(
      reviewTargetKey(target),
      target.kind,
      target.kind === 'folder' ? target.scanRootId : null,
      projectId,
      target.kind === 'branch' ? target.branch : null,
      target.kind === 'worktree' ? target.worktreeId : null,
      enabled ? 1 : 0,
      updatedAt,
    );
  }

  /** Returns true when a row was deleted. */
  deleteOverride(target: ReviewPolicyTarget): boolean {
    const result = this.#stmt('DELETE FROM review_overrides WHERE target_key = ?').run(
      reviewTargetKey(target),
    );
    return Number(result.changes) > 0;
  }

  /** Deletes the project, branch and worktree overrides of a project. Returns the row count. */
  deleteOverridesForProject(projectId: string): number {
    return Number(
      this.#stmt('DELETE FROM review_overrides WHERE project_id = ?').run(projectId).changes,
    );
  }

  /** Deletes the folder override of a scan root. Returns the row count. */
  deleteOverridesForScanRoot(scanRootId: string): number {
    return Number(
      this.#stmt('DELETE FROM review_overrides WHERE scan_root_id = ?').run(scanRootId).changes,
    );
  }
}
