import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { BULK_UNDO_MAX_ENTRIES, BULK_UNDO_TTL_MS, type ServerEvent } from '@octopus-diff/contracts';
import { describe, expect, it } from 'vitest';
import { fileMatchesSelector, filterByPaths, mayHaveFiles, UndoStore } from '../src/bulk-review.js';
import { EventHub } from '../src/events.js';
import { createLogger } from '../src/logger.js';
import { policyInputFor, validateReviewPolicyTarget } from '../src/review-policy.js';
import { bookmarkKey, coveredByCommits } from '../src/review-state.js';
import { SettingsService } from '../src/settings.js';
import { parseStoredSettings } from '../src/settings-store.js';
import { DB_FILE, SCHEMA_VERSION, Store } from '../src/store.js';
import { fakeFile } from './fake-git-core.js';
import { tempDir } from './helpers.js';

const silent = createLogger({ level: 'silent' });

describe('UndoStore', () => {
  it('hands out single-use tokens that expire after the TTL', () => {
    let now = new Date('2026-03-01T00:00:00.000Z');
    const store = new UndoStore({ now: () => now });
    const entry = {
      at: now.toISOString(),
      scopeKind: 'working' as const,
      reviewed: true,
      changes: [],
    };
    const token = store.put(entry);
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(store.size).toBe(1);
    expect(store.take('unknown')).toBeNull();
    expect(store.take(token)).toEqual(entry);
    expect(store.take(token)).toBeNull();

    const expiring = store.put(entry);
    now = new Date(now.getTime() + BULK_UNDO_TTL_MS - 1);
    expect(store.size).toBe(1);
    now = new Date(now.getTime() + 1);
    expect(store.take(expiring)).toBeNull();
    expect(store.size).toBe(0);
  });

  it('keeps at most the newest BULK_UNDO_MAX_ENTRIES entries', () => {
    const store = new UndoStore();
    const tokens: string[] = [];
    for (let i = 0; i < BULK_UNDO_MAX_ENTRIES + 5; i++) {
      tokens.push(store.put({ at: 'x', scopeKind: 'working', reviewed: true, changes: [] }));
    }
    expect(store.size).toBe(BULK_UNDO_MAX_ENTRIES);
    for (const old of tokens.slice(0, 5)) expect(store.take(old)).toBeNull();
    const newest = tokens[tokens.length - 1] ?? '';
    expect(store.take(newest)).not.toBeNull();
    const custom = new UndoStore({ maxEntries: 1 });
    const first = custom.put({ at: 'x', scopeKind: 'working', reviewed: true, changes: [] });
    custom.put({ at: 'x', scopeKind: 'working', reviewed: true, changes: [] });
    expect(custom.take(first)).toBeNull();
  });
});

describe('bulk review helpers', () => {
  const raw = Buffer.from([0x66, 0xff]).toString('base64');
  const files = [
    fakeFile('a.ts'),
    fakeFile('dir/b.ts'),
    fakeFile('f�', { rawPath: raw }),
    fakeFile('f�2'),
  ];

  it('selects files by path, with rawPath taking precedence', () => {
    expect(
      filterByPaths(files, [{ path: 'a.ts' }, { path: 'nope.ts' }]).map((f) => f.path),
    ).toEqual(['a.ts']);
    expect(filterByPaths(files, [{ path: 'f�' }]).map((f) => f.path)).toEqual([]);
    expect(filterByPaths(files, [{ path: 'f�', rawPath: raw }]).map((f) => f.rawPath)).toEqual([
      raw,
    ]);
    expect(filterByPaths(files, [{ path: 'f�2' }]).map((f) => f.path)).toEqual(['f�2']);
    expect(fileMatchesSelector({ path: 'x', rawPath: raw }, { path: 'x' })).toBe(false);
    expect(fileMatchesSelector({ path: 'x' }, { path: 'x' })).toBe(true);
    expect(fileMatchesSelector({ path: 'x', rawPath: raw }, { path: 'y', rawPath: raw })).toBe(
      true,
    );
  });

  it('prefilters worktrees by summary counts like the inbox', () => {
    const summary = {
      changedFiles: 0,
      counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    } as Parameters<typeof mayHaveFiles>[0];
    expect(mayHaveFiles(summary, { kind: 'working' })).toBe(false);
    expect(mayHaveFiles(summary, { kind: 'staged' })).toBe(false);
    expect(mayHaveFiles(summary, { kind: 'unstaged' })).toBe(false);
    expect(mayHaveFiles(summary, { kind: 'branch' })).toBe(true);
    expect(mayHaveFiles(summary, { kind: 'commit', sha: 'a'.repeat(40) })).toBe(true);
    expect(
      mayHaveFiles(
        { ...summary, counts: { ...summary.counts, untracked: 1 } },
        { kind: 'unstaged' },
      ),
    ).toBe(true);
    expect(
      mayHaveFiles({ ...summary, counts: { ...summary.counts, staged: 1 } }, { kind: 'staged' }),
    ).toBe(true);
    expect(mayHaveFiles({ ...summary, changedFiles: 1 }, { kind: 'working' })).toBe(true);
  });

  it('builds resolver input and validates targets against the registry', () => {
    expect(
      policyInputFor({ id: 'p', scanRootId: 's' }, { id: 'w', branch: 'feat', detached: false }),
    ).toEqual({ worktreeId: 'w', projectId: 'p', branch: 'feat', scanRootId: 's' });
    expect(
      policyInputFor({ id: 'p', scanRootId: null }, { id: 'w', branch: 'x', detached: true })
        .branch,
    ).toBeNull();
    const registry = {
      hasProject: (id: string) => id === 'p',
      hasScanRoot: (id: string) => id === 's',
      projectOfWorktree: (id: string) => (id === 'w' ? 'p' : null),
    };
    expect(validateReviewPolicyTarget({ kind: 'folder', scanRootId: 's' }, registry)).toEqual({
      projectId: null,
    });
    expect(validateReviewPolicyTarget({ kind: 'worktree', worktreeId: 'w' }, registry)).toEqual({
      projectId: 'p',
    });
    expect(
      validateReviewPolicyTarget({ kind: 'branch', projectId: 'p', branch: 'any' }, registry),
    ).toEqual({ projectId: 'p' });
    expect(() => validateReviewPolicyTarget({ kind: 'project', projectId: 'q' }, registry)).toThrow(
      /project not found/,
    );
    expect(() => validateReviewPolicyTarget({ kind: 'folder', scanRootId: 'q' }, registry)).toThrow(
      /scan root not found/,
    );
    expect(() =>
      validateReviewPolicyTarget({ kind: 'worktree', worktreeId: 'q' }, registry),
    ).toThrow(/worktree not found/);
  });
});

describe('settings store (migration v2)', () => {
  it('parses stored settings leniently', () => {
    expect(parseStoredSettings(null)).toEqual({
      review: { defaultEnabled: true },
      forges: { enabled: true, hosts: {} },
    });
    expect(parseStoredSettings('{nope')).toEqual({
      review: { defaultEnabled: true },
      forges: { enabled: true, hosts: {} },
    });
    expect(parseStoredSettings('{"review":{"defaultEnabled":false}}')).toEqual({
      review: { defaultEnabled: false },
      forges: { enabled: true, hosts: {} },
    });
    expect(parseStoredSettings('{"review":{}}')).toEqual({
      review: { defaultEnabled: true },
      forges: { enabled: true, hosts: {} },
    });
    expect(parseStoredSettings('{"review":{"defaultEnabled":"no"}}')).toEqual({
      review: { defaultEnabled: true },
      forges: { enabled: true, hosts: {} },
    });
    expect(parseStoredSettings('{"future":1}')).toEqual({
      review: { defaultEnabled: true },
      forges: { enabled: true, hosts: {} },
    });
  });

  it('migrates a v1 database and persists settings, revision and overrides', async () => {
    const dir = await tempDir();
    const { DatabaseSync } = await import('node:sqlite');
    await mkdir(dir, { recursive: true });
    const legacy = new DatabaseSync(path.join(dir, DB_FILE));
    legacy.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, common_dir TEXT NOT NULL,
        main_worktree_path TEXT, bare INTEGER NOT NULL DEFAULT 0, detected_default_branch TEXT,
        default_branch_override TEXT, scan_root_id TEXT, added_at TEXT NOT NULL,
        worktrees_json TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE scan_roots (id TEXT PRIMARY KEY, path TEXT NOT NULL, depth INTEGER NOT NULL,
        added_at TEXT NOT NULL, last_scanned_at TEXT);
      CREATE TABLE scan_exclusions (scan_root_id TEXT NOT NULL, project_id TEXT NOT NULL,
        excluded_at TEXT NOT NULL, PRIMARY KEY (scan_root_id, project_id));
      CREATE TABLE reviewed (project_id TEXT NOT NULL, scope_kind TEXT NOT NULL, path TEXT NOT NULL,
        raw INTEGER NOT NULL DEFAULT 0, patch_hash TEXT NOT NULL, reviewed_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL, PRIMARY KEY (project_id, scope_kind, raw, path, patch_hash));
      CREATE INDEX reviewed_last_seen ON reviewed (last_seen_at);
      INSERT INTO reviewed VALUES ('0123456789abcdef', 'working', 'a', 0, 'h', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      PRAGMA user_version = 1;
    `);
    legacy.close();

    const store = await Store.open(dir);
    expect(SCHEMA_VERSION).toBe(3);
    expect(store.schemaVersion()).toBe(3);
    expect(store.getBookmark('0123456789abcdef', 'branch:main')).toBeNull();
    expect(store.listReviewMarks('0123456789abcdef', 'working')).toHaveLength(1);
    expect(store.settings.getRevision()).toBe(0);
    expect(store.settings.getSettings()).toEqual({
      review: { defaultEnabled: true },
      forges: { enabled: true, hosts: {} },
    });
    expect(store.settings.listOverrides()).toEqual([]);

    store.settings.setSettings({ review: { defaultEnabled: false } });
    store.settings.setRevision(7);
    store.settings.upsertOverride(
      { kind: 'worktree', worktreeId: 'w'.repeat(16) },
      false,
      '2026-03-01T00:00:00.000Z',
      { projectId: 'p'.repeat(16) },
    );
    store.settings.upsertOverride(
      { kind: 'branch', projectId: 'p'.repeat(16), branch: 'feat' },
      true,
      '2026-03-01T00:00:00.000Z',
      { projectId: 'p'.repeat(16) },
    );
    store.settings.upsertOverride(
      { kind: 'folder', scanRootId: 's'.repeat(16) },
      false,
      '2026-03-01T00:00:00.000Z',
      { projectId: null },
    );
    // Replacing keeps one row per target.
    store.settings.upsertOverride(
      { kind: 'folder', scanRootId: 's'.repeat(16) },
      true,
      '2026-03-02T00:00:00.000Z',
      { projectId: null },
    );
    store.close();

    const reopened = await Store.open(dir);
    expect(reopened.settings.getRevision()).toBe(7);
    expect(reopened.settings.getSettings()).toEqual({
      review: { defaultEnabled: false },
      forges: { enabled: true, hosts: {} },
    });
    const overrides = reopened.settings.listOverrides();
    expect(overrides).toHaveLength(3);
    expect(overrides.find((o) => o.target.kind === 'folder')).toMatchObject({
      enabled: true,
      updatedAt: '2026-03-02T00:00:00.000Z',
      scanRootId: 's'.repeat(16),
      projectId: null,
    });
    expect(overrides.find((o) => o.target.kind === 'worktree')?.projectId).toBe('p'.repeat(16));
    expect(reopened.settings.deleteOverridesForProject('p'.repeat(16))).toBe(2);
    expect(reopened.settings.deleteOverridesForScanRoot('s'.repeat(16))).toBe(1);
    expect(reopened.settings.deleteOverride({ kind: 'folder', scanRootId: 's'.repeat(16) })).toBe(
      false,
    );
    expect(reopened.settings.listOverrides()).toEqual([]);
    reopened.close();
  });
});

describe('SettingsService', () => {
  it('keeps the revision on no-op changes and emits settings.changed otherwise', async () => {
    const store = await Store.open(await tempDir());
    const hub = new EventHub();
    const events: ServerEvent[] = [];
    hub.on((e) => events.push(e));
    const service = new SettingsService({ store, hub, logger: silent });
    expect(service.revision).toBe(0);
    expect(service.update({})).toMatchObject({ revision: 0 });
    expect(service.update({ review: { defaultEnabled: true } }).revision).toBe(0);
    expect(service.update({ review: { defaultEnabled: false } }).revision).toBe(1);
    const target = { kind: 'project', projectId: 'p'.repeat(16) } as const;
    expect(service.setOverride(target, null, { projectId: null }).revision).toBe(1);
    expect(service.setOverride(target, true, { projectId: target.projectId }).revision).toBe(2);
    expect(service.setOverride(target, true, { projectId: target.projectId }).revision).toBe(2);
    expect(service.setOverride(target, false, { projectId: target.projectId }).revision).toBe(3);
    expect(
      service.resolve({
        worktreeId: 'w'.repeat(16),
        projectId: target.projectId,
        branch: null,
        scanRootId: null,
      }),
    ).toEqual({ enabled: false, source: 'project' });
    expect(
      service.resolve({
        worktreeId: 'w'.repeat(16),
        projectId: 'q'.repeat(16),
        branch: null,
        scanRootId: null,
      }),
    ).toEqual({ enabled: false, source: 'default' });
    service.onProjectRemoved('q'.repeat(16));
    expect(service.revision).toBe(3);
    service.onProjectRemoved(target.projectId);
    expect(service.revision).toBe(4);
    expect(service.response().overrides).toEqual([]);
    expect(events.map((e) => (e.type === 'settings.changed' ? e.revision : e.type))).toEqual([
      1, 2, 3, 4,
    ]);
    expect(store.settings.getRevision()).toBe(4);
    hub.close();
    store.close();
  });
});

describe('settings store: forges', () => {
  it('fills forge defaults and keeps stored host overrides', () => {
    expect(
      parseStoredSettings('{"review":{"defaultEnabled":true},"forges":{"enabled":false}}'),
    ).toEqual({
      review: { defaultEnabled: true },
      forges: { enabled: false, hosts: {} },
    });
    expect(
      parseStoredSettings(
        '{"review":{"defaultEnabled":true},"forges":{"hosts":{"git.acme.io":"gitlab"}}}',
      ),
    ).toEqual({
      review: { defaultEnabled: true },
      forges: { enabled: true, hosts: { 'git.acme.io': 'gitlab' } },
    });
  });
});

describe('status flow v2 store and helpers', () => {
  it('stores bookmarks and reviewed commits per project; deleting a project drops them', async () => {
    const store = await Store.open(await tempDir());
    const p = '0123456789abcdef';
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    expect(store.getBookmark(p, 'branch:main')).toBeNull();
    store.setBookmark(p, 'branch:main', a, '2026-01-01T00:00:00.000Z');
    store.setBookmark(p, 'branch:main', b, '2026-01-02T00:00:00.000Z');
    expect(store.getBookmark(p, 'branch:main')).toBe(b);
    expect(store.getBookmark(p, 'branch:other')).toBeNull();
    expect(store.addReviewedCommits(p, [{ sha: a, patchId: 'x' }], 'now')).toEqual([a]);
    expect(
      store.addReviewedCommits(
        p,
        [
          { sha: a, patchId: 'x' },
          { sha: `${a}..${b}`, patchId: 'y' },
        ],
        'now',
      ),
    ).toEqual([`${a}..${b}`]);
    expect(
      store
        .listReviewedCommits(p)
        .map((c) => c.patchId)
        .sort(),
    ).toEqual(['x', 'y']);
    store.removeReviewedCommits(p, [a]);
    expect(store.listReviewedCommits(p)).toEqual([{ sha: `${a}..${b}`, patchId: 'y' }]);
    store.setBookmark(p, 'branch:main', null, 'now');
    expect(store.getBookmark(p, 'branch:main')).toBeNull();
    store.setBookmark(p, 'branch:main', a, 'now');
    store.deleteProject(p);
    expect(store.getBookmark(p, 'branch:main')).toBeNull();
    expect(store.listReviewedCommits(p)).toEqual([]);
    store.close();
  });

  it('keys bookmarks by branch, or by worktree when detached', () => {
    expect(bookmarkKey({ id: 'w1', branch: 'main', detached: false })).toBe('branch:main');
    expect(bookmarkKey({ id: 'w1', branch: null, detached: true })).toBe('worktree:w1');
  });

  it('a file is covered by reviewed commits only without uncommitted changes and unreviewed touches', () => {
    const file = {
      path: 'a.txt',
      oldPath: null,
      staged: false,
      unstaged: false,
      status: 'modified' as const,
    };
    expect(coveredByCommits(file, null)).toBe(false);
    expect(coveredByCommits(file, new Set())).toBe(true);
    expect(coveredByCommits(file, new Set(['a.txt']))).toBe(false);
    expect(coveredByCommits({ ...file, unstaged: true }, new Set())).toBe(false);
    expect(coveredByCommits({ ...file, status: 'untracked' }, new Set())).toBe(false);
    expect(
      coveredByCommits({ ...file, status: 'renamed', oldPath: 'old.txt' }, new Set(['old.txt'])),
    ).toBe(false);
  });
});
