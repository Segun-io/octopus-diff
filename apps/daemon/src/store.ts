import path from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { ScopeKind, Worktree } from '@octopus-diff/contracts';
import { SETTINGS_MIGRATION_V2, SettingsStore } from './settings-store.js';

export const DB_FILE = 'octopus-diff.db';

/** Review marks whose patch hash was not seen for this long are garbage-collected (PLAN §5.7). */
export const REVIEW_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** `last_seen_at` is refreshed at most this often per mark, to keep listing cheap. */
export const REVIEW_TOUCH_INTERVAL_MS = 24 * 60 * 60 * 1000;

type SqliteModule = typeof import('node:sqlite');
let sqliteModule: Promise<SqliteModule> | undefined;

/**
 * Loads `node:sqlite`, dropping only its one-time ExperimentalWarning (Node 22–24 print it on
 * first load; Node 26 no longer does). Every other warning passes through untouched.
 */
export function loadSqlite(): Promise<SqliteModule> {
  sqliteModule ??= (async () => {
    const original = process.emitWarning;
    const filtered = ((warning: string | Error, ...rest: unknown[]) => {
      const message = typeof warning === 'string' ? warning : warning.message;
      const type =
        typeof rest[0] === 'string'
          ? rest[0]
          : typeof rest[0] === 'object' && rest[0] !== null
            ? (rest[0] as { type?: string }).type
            : warning instanceof Error
              ? warning.name
              : undefined;
      if (type === 'ExperimentalWarning' && /sqlite/i.test(message)) return;
      return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
    }) as typeof process.emitWarning;
    process.emitWarning = filtered;
    try {
      return await import('node:sqlite');
    } finally {
      if (process.emitWarning === filtered) process.emitWarning = original;
    }
  })();
  return sqliteModule;
}

export interface ProjectRow {
  id: string;
  name: string;
  commonDir: string;
  mainWorktreePath: string | null;
  bare: boolean;
  detectedDefaultBranch: string | null;
  defaultBranchOverride: string | null;
  scanRootId: string | null;
  addedAt: string;
  /** Last known worktrees, so the registry is usable (and vanished paths reportable) at startup. */
  worktrees: Worktree[];
}

export interface ScanRootRow {
  id: string;
  path: string;
  depth: number;
  addedAt: string;
  lastScannedAt: string | null;
}

/** Review key per PLAN §5.7 / DECISIONS #13: `rawPath` replaces `path` when present. */
export interface ReviewKey {
  projectId: string;
  scopeKind: ScopeKind;
  path: string;
  rawPath?: string | undefined;
  patchHash: string;
}

export interface ReviewMark {
  /** `rawPath ?? path`. */
  path: string;
  raw: boolean;
  patchHash: string;
  reviewedAt: string;
  lastSeenAt: string;
}

/** In-memory lookup key for a review mark (path kind, path, patch hash). */
export function reviewLookupKey(raw: boolean, pathOrRaw: string, patchHash: string): string {
  return `${raw ? 'r' : 'p'}:${pathOrRaw}\u0000${patchHash}`;
}

const MIGRATIONS: readonly string[] = [
  // v1
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    common_dir TEXT NOT NULL,
    main_worktree_path TEXT,
    bare INTEGER NOT NULL DEFAULT 0,
    detected_default_branch TEXT,
    default_branch_override TEXT,
    scan_root_id TEXT,
    added_at TEXT NOT NULL,
    worktrees_json TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE scan_roots (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    depth INTEGER NOT NULL,
    added_at TEXT NOT NULL,
    last_scanned_at TEXT
  );
  CREATE TABLE scan_exclusions (
    scan_root_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    excluded_at TEXT NOT NULL,
    PRIMARY KEY (scan_root_id, project_id)
  );
  CREATE TABLE reviewed (
    project_id TEXT NOT NULL,
    scope_kind TEXT NOT NULL,
    path TEXT NOT NULL,
    raw INTEGER NOT NULL DEFAULT 0,
    patch_hash TEXT NOT NULL,
    reviewed_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    PRIMARY KEY (project_id, scope_kind, raw, path, patch_hash)
  );
  CREATE INDEX reviewed_last_seen ON reviewed (last_seen_at);
  `,
  // v2: app settings + review-policy overrides (UX round 1), see settings-store.ts
  SETTINGS_MIGRATION_V2,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

type Row = Record<string, unknown>;

const str = (v: unknown): string => String(v);
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function parseWorktrees(json: unknown): Worktree[] {
  if (typeof json !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as Worktree[]) : [];
  } catch {
    return [];
  }
}

function toProjectRow(r: Row): ProjectRow {
  return {
    id: str(r.id),
    name: str(r.name),
    commonDir: str(r.common_dir),
    mainWorktreePath: strOrNull(r.main_worktree_path),
    bare: Number(r.bare) === 1,
    detectedDefaultBranch: strOrNull(r.detected_default_branch),
    defaultBranchOverride: strOrNull(r.default_branch_override),
    scanRootId: strOrNull(r.scan_root_id),
    addedAt: str(r.added_at),
    worktrees: parseWorktrees(r.worktrees_json),
  };
}

function toScanRootRow(r: Row): ScanRootRow {
  return {
    id: str(r.id),
    path: str(r.path),
    depth: Number(r.depth),
    addedAt: str(r.added_at),
    lastScannedAt: strOrNull(r.last_scanned_at),
  };
}

/**
 * App state in SQLite (`node:sqlite`, synchronous). Holds the project registry, scan roots and
 * review marks; never anything inside a repository.
 */
export class Store {
  readonly file: string;
  readonly #db: DatabaseSync;
  readonly #stmts: Record<string, StatementSync> = {};
  /** Settings and review-policy overrides (v2 tables); wrap multi-statement writes in `transaction`. */
  readonly settings: SettingsStore;
  #closed = false;

  private constructor(db: DatabaseSync, file: string) {
    this.#db = db;
    this.file = file;
    this.settings = new SettingsStore(db);
  }

  /** Opens (creating if needed) `<stateDir>/octopus-diff.db` and applies migrations. */
  static async open(stateDir: string): Promise<Store> {
    const { DatabaseSync } = await loadSqlite();
    const file = path.join(stateDir, DB_FILE);
    const db = new DatabaseSync(file, { timeout: 5000, enableForeignKeyConstraints: true });
    const store = new Store(db, file);
    try {
      store.#migrate();
    } catch (error) {
      db.close();
      throw error;
    }
    return store;
  }

  get closed(): boolean {
    return this.#closed;
  }

  #migrate(): void {
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA synchronous = NORMAL');
    const row = this.#db.prepare('PRAGMA user_version').get() as Row | undefined;
    const current = Number(row?.user_version ?? 0);
    if (current > MIGRATIONS.length) {
      throw new Error(
        `state database ${this.file} has schema version ${current}, newer than this daemon supports (${MIGRATIONS.length})`,
      );
    }
    for (let version = current; version < MIGRATIONS.length; version++) {
      const sql = MIGRATIONS[version] ?? '';
      this.transaction(() => {
        this.#db.exec(sql);
        this.#db.exec(`PRAGMA user_version = ${version + 1}`);
      });
    }
  }

  #stmt(sql: string): StatementSync {
    let stmt = this.#stmts[sql];
    if (!stmt) {
      stmt = this.#db.prepare(sql);
      this.#stmts[sql] = stmt;
    }
    return stmt;
  }

  transaction<T>(fn: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  schemaVersion(): number {
    const row = this.#db.prepare('PRAGMA user_version').get() as Row | undefined;
    return Number(row?.user_version ?? 0);
  }

  // --- projects --------------------------------------------------------------------------------

  listProjects(): ProjectRow[] {
    return (this.#stmt('SELECT * FROM projects ORDER BY added_at, id').all() as Row[]).map(
      toProjectRow,
    );
  }

  insertProject(row: ProjectRow): void {
    this.#stmt(
      `INSERT INTO projects (id, name, common_dir, main_worktree_path, bare, detected_default_branch,
        default_branch_override, scan_root_id, added_at, worktrees_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.name,
      row.commonDir,
      row.mainWorktreePath,
      row.bare ? 1 : 0,
      row.detectedDefaultBranch,
      row.defaultBranchOverride,
      row.scanRootId,
      row.addedAt,
      JSON.stringify(row.worktrees),
    );
  }

  updateProjectInfo(
    id: string,
    info: Pick<
      ProjectRow,
      'name' | 'commonDir' | 'mainWorktreePath' | 'bare' | 'detectedDefaultBranch'
    >,
  ): void {
    this.#stmt(
      `UPDATE projects SET name = ?, common_dir = ?, main_worktree_path = ?, bare = ?,
        detected_default_branch = ? WHERE id = ?`,
    ).run(
      info.name,
      info.commonDir,
      info.mainWorktreePath,
      info.bare ? 1 : 0,
      info.detectedDefaultBranch,
      id,
    );
  }

  setProjectWorktrees(id: string, worktrees: Worktree[]): void {
    this.#stmt('UPDATE projects SET worktrees_json = ? WHERE id = ?').run(
      JSON.stringify(worktrees),
      id,
    );
  }

  setDefaultBranchOverride(id: string, value: string | null): void {
    this.#stmt('UPDATE projects SET default_branch_override = ? WHERE id = ?').run(value, id);
  }

  setProjectScanRoot(id: string, scanRootId: string | null): void {
    this.#stmt('UPDATE projects SET scan_root_id = ? WHERE id = ?').run(scanRootId, id);
  }

  /** Deletes a project with its review marks (PLAN §5.7: no marks for removed projects). */
  deleteProject(id: string): void {
    this.transaction(() => {
      this.#stmt('DELETE FROM projects WHERE id = ?').run(id);
      this.#stmt('DELETE FROM reviewed WHERE project_id = ?').run(id);
    });
  }

  // --- scan roots ------------------------------------------------------------------------------

  listScanRoots(): ScanRootRow[] {
    return (this.#stmt('SELECT * FROM scan_roots ORDER BY added_at, id').all() as Row[]).map(
      toScanRootRow,
    );
  }

  insertScanRoot(row: ScanRootRow): void {
    this.#stmt(
      'INSERT INTO scan_roots (id, path, depth, added_at, last_scanned_at) VALUES (?, ?, ?, ?, ?)',
    ).run(row.id, row.path, row.depth, row.addedAt, row.lastScannedAt);
  }

  setScanRootDepth(id: string, depth: number): void {
    this.#stmt('UPDATE scan_roots SET depth = ? WHERE id = ?').run(depth, id);
  }

  setScanRootScanned(id: string, at: string): void {
    this.#stmt('UPDATE scan_roots SET last_scanned_at = ? WHERE id = ?').run(at, id);
  }

  deleteScanRoot(id: string): void {
    this.transaction(() => {
      this.#stmt('DELETE FROM scan_roots WHERE id = ?').run(id);
      this.#stmt('DELETE FROM scan_exclusions WHERE scan_root_id = ?').run(id);
    });
  }

  /** Remembers that the user removed a scan-discovered project, so rescans don't re-add it. */
  addScanExclusion(scanRootId: string, projectId: string, at: string): void {
    this.#stmt(
      'INSERT OR REPLACE INTO scan_exclusions (scan_root_id, project_id, excluded_at) VALUES (?, ?, ?)',
    ).run(scanRootId, projectId, at);
  }

  clearScanExclusions(projectId: string): void {
    this.#stmt('DELETE FROM scan_exclusions WHERE project_id = ?').run(projectId);
  }

  isScanExcluded(scanRootId: string, projectId: string): boolean {
    return (
      this.#stmt(
        'SELECT 1 AS x FROM scan_exclusions WHERE scan_root_id = ? AND project_id = ?',
      ).get(scanRootId, projectId) !== undefined
    );
  }

  // --- review marks ----------------------------------------------------------------------------

  listReviewMarks(projectId: string, scopeKind: ScopeKind): ReviewMark[] {
    const rows = this.#stmt(
      'SELECT path, raw, patch_hash, reviewed_at, last_seen_at FROM reviewed WHERE project_id = ? AND scope_kind = ?',
    ).all(projectId, scopeKind) as Row[];
    return rows.map((r) => ({
      path: str(r.path),
      raw: Number(r.raw) === 1,
      patchHash: str(r.patch_hash),
      reviewedAt: str(r.reviewed_at),
      lastSeenAt: str(r.last_seen_at),
    }));
  }

  setReviewed(key: ReviewKey, reviewed: boolean, at: string): void {
    const raw = key.rawPath !== undefined;
    const p = key.rawPath ?? key.path;
    if (reviewed) {
      this.#stmt(
        `INSERT INTO reviewed (project_id, scope_kind, path, raw, patch_hash, reviewed_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, scope_kind, raw, path, patch_hash)
         DO UPDATE SET reviewed_at = excluded.reviewed_at, last_seen_at = excluded.last_seen_at`,
      ).run(key.projectId, key.scopeKind, p, raw ? 1 : 0, key.patchHash, at, at);
    } else {
      this.#stmt(
        'DELETE FROM reviewed WHERE project_id = ? AND scope_kind = ? AND raw = ? AND path = ? AND patch_hash = ?',
      ).run(key.projectId, key.scopeKind, raw ? 1 : 0, p, key.patchHash);
    }
  }

  touchReviewMarks(
    projectId: string,
    scopeKind: ScopeKind,
    marks: ReadonlyArray<Pick<ReviewMark, 'path' | 'raw' | 'patchHash'>>,
    at: string,
  ): void {
    if (marks.length === 0) return;
    const stmt = this.#stmt(
      'UPDATE reviewed SET last_seen_at = ? WHERE project_id = ? AND scope_kind = ? AND raw = ? AND path = ? AND patch_hash = ?',
    );
    this.transaction(() => {
      for (const m of marks) stmt.run(at, projectId, scopeKind, m.raw ? 1 : 0, m.path, m.patchHash);
    });
  }

  countReviewMarks(): number {
    const row = this.#stmt('SELECT COUNT(*) AS n FROM reviewed').get() as Row | undefined;
    return Number(row?.n ?? 0);
  }

  /**
   * Deletes review marks of projects that are no longer registered and marks whose patch hash
   * was not seen since `staleBefore` (ISO timestamp).
   */
  gcReviewMarks(staleBefore: string): { orphaned: number; stale: number } {
    return this.transaction(() => {
      const orphaned = this.#stmt(
        'DELETE FROM reviewed WHERE project_id NOT IN (SELECT id FROM projects)',
      ).run().changes;
      const stale = this.#stmt('DELETE FROM reviewed WHERE last_seen_at < ?').run(
        staleBefore,
      ).changes;
      this.#stmt(
        'DELETE FROM scan_exclusions WHERE scan_root_id NOT IN (SELECT id FROM scan_roots)',
      ).run();
      return { orphaned: Number(orphaned), stale: Number(stale) };
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}
