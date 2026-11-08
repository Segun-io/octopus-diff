/**
 * In-memory mock of the octopus-diff daemon (dev/test only; never imported from `src/`).
 * Produces contract-shaped data for every route plus a change simulator that emits SSE events.
 */
import {
  type AddProjectResponse,
  type AddScanRootResponse,
  type ChangedFile,
  type CommitInfo,
  type CommitsResponse,
  type DiffQuery,
  type DiffResponse,
  type DiffScope,
  type FilesResponse,
  type HealthResponse,
  type InboxResponse,
  type Project,
  type ProjectListItem,
  type ProjectsResponse,
  type RefreshResponse,
  type ReviewRequest,
  type ScanRoot,
  type ServerEvent,
  scopeKey,
  type Worktree,
  type WorktreeSummary,
} from '@octopus-diff/contracts';
import { buildPatch, countLines, fileSides, type MockFile, type MockFileKind } from './content.js';
import {
  byteLength,
  bytesToBase64,
  fnv1a32,
  hash16,
  hash40,
  intBetween,
  isoAt,
  makeClock,
  pick,
  prng,
} from './util.js';

export type MockDataset = 'demo' | 'large' | 'empty';

export interface MockBackendOptions {
  dataset?: MockDataset;
  seed?: number;
  /** Large dataset shape (default 10 projects × 3 worktrees × 200 files). */
  largeProjects?: number;
  largeWorktreesPerProject?: number;
  largeFilesPerWorktree?: number;
}

/** Soft limit: above this the patch is omitted unless `full=true`. Hard cap: patch is cut. */
export const MOCK_SOFT_LIMIT = 256 * 1024;
export const MOCK_HARD_LIMIT = 1024 * 1024;

export class MockApiError extends Error {
  constructor(
    readonly status: number,
    readonly code:
      | 'bad_request'
      | 'unauthorized'
      | 'not_found'
      | 'not_a_repository'
      | 'conflict'
      | 'internal',
    message: string,
  ) {
    super(message);
  }
}

interface MockCommit {
  info: CommitInfo;
  files: MockFile[];
}

interface MockWorktree {
  worktree: Worktree;
  files: MockFile[];
  branchFiles: MockFile[];
  commits: MockCommit[];
  upstream: string | null;
  aheadBehindRef: string | null;
  ahead: number | null;
  behind: number | null;
  inProgress: WorktreeSummary['inProgress'];
  /** Summary failed to compute (exercises error display). */
  error: string | null;
  updatedAt: string;
  revision: number;
}

interface MockProject {
  project: Project;
  worktrees: MockWorktree[];
}

type Listener = (event: ServerEvent) => void;

interface CanonicalPatch {
  patch: string;
  hash: string;
  byteLength: number;
  additions: number | null;
  deletions: number | null;
}

const now = makeClock(60 * 60 * 1000);

const DIRS = ['src', 'src/lib', 'src/components', 'src/server', 'test', 'docs', 'scripts'];
const NAMES = [
  'index.ts',
  'router.ts',
  'cache.ts',
  'auth.ts',
  'App.tsx',
  'Button.tsx',
  'styles.css',
  'config.json',
  'README.md',
  'utils.py',
  'main.go',
  'lib.rs',
  'session.ts',
  'store.ts',
  'events.ts',
];

export class MockBackend {
  readonly projects: MockProject[] = [];
  readonly scanRoots: ScanRoot[] = [];
  readonly reviews = new Set<string>();
  focus: string | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly patchCache = new Map<string, CanonicalPatch>();
  private readonly rand: () => number;
  private readonly startedAt = isoAt(0);

  constructor(readonly options: MockBackendOptions = {}) {
    this.rand = prng(options.seed ?? 42);
    const dataset = options.dataset ?? 'demo';
    if (dataset === 'demo') this.buildDemo();
    else if (dataset === 'large') this.buildLarge();
  }

  // --- events ---------------------------------------------------------------------------

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: ServerEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  hello(): ServerEvent {
    return { type: 'hello', version: '0.0.0-mock', startedAt: this.startedAt };
  }

  // --- dataset construction -------------------------------------------------------------

  private makeProject(
    name: string,
    opts: { scanRootId?: string | null; defaultBranch?: string | null } = {},
  ): MockProject {
    const path = `/home/dev/code/${name}`;
    const project: Project = {
      id: hash16(`${path}/.git`),
      name,
      commonDir: `${path}/.git`,
      mainWorktreePath: path,
      bare: false,
      defaultBranch: opts.defaultBranch === undefined ? 'main' : opts.defaultBranch,
      defaultBranchOverride: null,
      scanRootId: opts.scanRootId ?? null,
      addedAt: isoAt(-86_400_000 + this.projects.length * 1000),
    };
    const mp: MockProject = { project, worktrees: [] };
    this.projects.push(mp);
    return mp;
  }

  private makeWorktree(
    mp: MockProject,
    opts: {
      branch: string | null;
      isMain?: boolean;
      path?: string;
      upstream?: string | null;
      ahead?: number | null;
      behind?: number | null;
      inProgress?: WorktreeSummary['inProgress'];
      error?: string | null;
      missing?: boolean;
      locked?: boolean;
    },
  ): MockWorktree {
    const isMain = opts.isMain ?? false;
    const path =
      opts.path ??
      (isMain
        ? (mp.project.mainWorktreePath ?? `/home/dev/code/${mp.project.name}`)
        : `/home/dev/.t3/worktrees/${mp.project.name}/${(opts.branch ?? 'detached').replace(/\//g, '-')}`);
    const id = hash16(path);
    const branch = opts.branch;
    const worktree: Worktree = {
      id,
      projectId: mp.project.id,
      path,
      branch,
      headSha: hash40(`head:${id}`),
      detached: branch === null,
      isMain,
      bare: false,
      locked: opts.locked ?? false,
      prunable: false,
      missing: opts.missing ?? false,
    };
    const upstream = opts.upstream ?? null;
    const defaultBranch = mp.project.defaultBranch;
    const aheadBehindRef =
      upstream ?? (defaultBranch && branch !== defaultBranch ? defaultBranch : null);
    const mw: MockWorktree = {
      worktree,
      files: [],
      branchFiles: [],
      commits: [],
      upstream,
      aheadBehindRef,
      ahead: aheadBehindRef ? (opts.ahead ?? 0) : null,
      behind: aheadBehindRef ? (opts.behind ?? 0) : null,
      inProgress: opts.inProgress ?? null,
      error: opts.error ?? null,
      updatedAt: now(),
      revision: 0,
    };
    mw.commits = this.makeCommits(mw, 25);
    mp.worktrees.push(mw);
    return mw;
  }

  private makeCommits(mw: MockWorktree, count: number): MockCommit[] {
    const commits: MockCommit[] = [];
    const subjects = [
      'Add retry logic to fetch client',
      'Fix cache invalidation on rename',
      'Refactor router into modules',
      'Update dependencies',
      'Improve error messages',
      'Add tests for review marks',
      'Initial commit',
    ];
    let parent: string | null = null;
    const shas: string[] = [];
    for (let i = count - 1; i >= 0; i--) shas.push(hash40(`commit:${mw.worktree.id}:${i}`));
    shas.reverse();
    for (let i = 0; i < count; i++) {
      const sha = shas[i] ?? hash40(`c${i}`);
      parent = i + 1 < count ? (shas[i + 1] ?? null) : null;
      const r = prng(fnv1a32(sha));
      const files: MockFile[] = [];
      const n = intBetween(r, 1, 5);
      for (let f = 0; f < n; f++) {
        files.push({
          path: `${pick(r, DIRS)}/${pick(r, NAMES)}`.replace(/^(.*)$/, (p) => p),
          oldPath: null,
          status:
            i === count - 1
              ? 'added'
              : pick(r, ['modified', 'modified', 'added', 'deleted'] as const),
          kind: 'text',
          staged: false,
          unstaged: false,
          seed: fnv1a32(`${sha}:${f}`),
          version: 0,
          lines: intBetween(r, 20, 120),
        });
      }
      const date = isoAt(-(i + 1) * 3_600_000);
      commits.push({
        info: {
          sha,
          shortSha: sha.slice(0, 7),
          parents: parent ? [parent] : [],
          subject: `${subjects[i % subjects.length]}${i > 6 ? ` (#${100 + i})` : ''}`,
          authorName: i % 3 === 0 ? 'Claude' : 'Dev',
          authorEmail: i % 3 === 0 ? 'agent@example.com' : 'dev@example.com',
          authorDate: date,
          committerDate: date,
        },
        files: dedupe(files),
      });
    }
    return commits;
  }

  private file(
    path: string,
    status: MockFile['status'],
    opts: Partial<Omit<MockFile, 'path' | 'status'>> & { kind?: MockFileKind } = {},
  ): MockFile {
    const staged =
      opts.staged ?? (status === 'added' || status === 'renamed' || status === 'deleted');
    return {
      path,
      oldPath: opts.oldPath ?? null,
      status,
      kind: opts.kind ?? 'text',
      staged: status === 'untracked' ? false : staged,
      unstaged:
        opts.unstaged ??
        (status === 'untracked' || status === 'modified' || status === 'conflicted'),
      seed: opts.seed ?? fnv1a32(path),
      version: opts.version ?? 0,
      lines: opts.lines ?? 60,
      ...(opts.rawPath ? { rawPath: opts.rawPath } : {}),
    };
  }

  private buildDemo(): void {
    const api = this.makeProject('octopus-api');
    const apiMain = this.makeWorktree(api, {
      branch: 'main',
      isMain: true,
      upstream: 'origin/main',
      ahead: 1,
      behind: 3,
    });
    apiMain.files = [
      this.file('src/server/router.ts', 'modified', { staged: true, unstaged: true }),
      this.file('README.md', 'modified'),
    ];

    const auth = this.makeWorktree(api, { branch: 'feat/auth', ahead: 4, behind: 0 });
    const nonUtf8Bytes = new Uint8Array([
      0x64, 0x6f, 0x63, 0x73, 0x2f, 0x72, 0xe9, 0x73, 0x75, 0x6d, 0xe9, 0x2e, 0x6d, 0x64,
    ]);
    auth.files = [
      this.file('src/auth/session.ts', 'modified'),
      this.file('src/auth/token.ts', 'added', { lines: 40 }),
      this.file('src/auth/legacy.ts', 'deleted'),
      this.file('src/auth/middleware.ts', 'renamed', {
        oldPath: 'src/middleware/auth.ts',
        version: 1,
      }),
      this.file('src/auth/README.md', 'renamed', { oldPath: 'docs/auth.md', version: 0 }),
      this.file('src/auth/policy.ts', 'copied', {
        oldPath: 'src/auth/session.ts',
        version: 1,
        staged: true,
      }),
      this.file('assets/logo.png', 'modified', { kind: 'binary' }),
      this.file('vendor/libgit', 'modified', { kind: 'submodule' }),
      this.file('config/current.json', 'modified', { kind: 'symlink', unstaged: true }),
      this.file('scripts/deploy.sh', 'modified', { kind: 'mode-only' }),
      this.file('src/format.ts', 'modified', { kind: 'whitespace', lines: 40 }),
      this.file('windows/build.bat', 'modified', { kind: 'crlf', lines: 30 }),
      this.file('src/auth/merge.ts', 'conflicted', { kind: 'conflict', staged: false }),
      this.file('src/auth/type.ts', 'typechange'),
      this.file('src/auth/.keep', 'added', { kind: 'empty' }),
      this.file('notes/todo.md', 'untracked', { lines: 12 }),
      this.file('data/generated-big.ts', 'added', { kind: 'big', lines: 4000 }),
      this.file('data/fixtures.min.json', 'added', { kind: 'huge', lines: 30_000 }),
      this.file('docs/r�sum�.md', 'untracked', { rawPath: bytesToBase64(nonUtf8Bytes), lines: 10 }),
    ];
    auth.branchFiles = [
      this.file('src/auth/oauth.ts', 'added', { lines: 80 }),
      this.file('src/server/router.ts', 'modified'),
    ];

    const cache = this.makeWorktree(api, {
      branch: 'fix/cache',
      path: '/home/dev/code/octopus-api/.claude/worktrees/fix-cache',
      ahead: 2,
      behind: 1,
    });
    cache.files = [
      this.file('src/lib/cache.ts', 'modified', { staged: true, unstaged: false }),
      this.file('test/cache.test.ts', 'added', { lines: 50 }),
    ];
    cache.branchFiles = [this.file('src/lib/cache.ts', 'modified', { seed: 7 })];

    const detached = this.makeWorktree(api, {
      branch: null,
      path: '/home/dev/.t3/worktrees/octopus-api/bisect',
    });
    detached.files = [];

    const web = this.makeProject('web-dashboard');
    const webMain = this.makeWorktree(web, {
      branch: 'main',
      isMain: true,
      upstream: 'origin/main',
      ahead: 2,
      behind: 1,
    });
    webMain.files = [
      this.file('src/components/Chart.tsx', 'modified', { lines: 120 }),
      this.file('src/components/Table.tsx', 'modified'),
      this.file('src/styles.css', 'modified', { lines: 40 }),
      this.file('package.json', 'modified', { lines: 30, staged: true, unstaged: false }),
    ];
    this.makeWorktree(web, { branch: 'agent/codex-123', ahead: 0, behind: 5 });

    const infra = this.makeProject('infra', { defaultBranch: null });
    this.makeWorktree(infra, { branch: 'trunk', isMain: true });

    const docs = this.makeProject('docs-site');
    const docsMain = this.makeWorktree(docs, { branch: null, isMain: true, inProgress: 'rebase' });
    docsMain.files = [this.file('content/intro.md', 'conflicted', { kind: 'conflict', lines: 30 })];

    const legacy = this.makeProject('legacy-tool');
    this.makeWorktree(legacy, {
      branch: 'master',
      isMain: true,
      error: 'git status timed out after 10000 ms',
    });
    this.makeWorktree(legacy, { branch: 'old-experiment', missing: true, locked: true });
  }

  private buildLarge(): void {
    const projects = this.options.largeProjects ?? 10;
    const perProject = this.options.largeWorktreesPerProject ?? 3;
    const filesPer = this.options.largeFilesPerWorktree ?? 200;
    for (let p = 0; p < projects; p++) {
      const mp = this.makeProject(`service-${String(p).padStart(2, '0')}`);
      for (let w = 0; w < perProject; w++) {
        const mw = this.makeWorktree(mp, {
          branch: w === 0 ? 'main' : `agent/task-${p}-${w}`,
          isMain: w === 0,
          upstream: w === 0 ? 'origin/main' : null,
          ahead: intBetween(this.rand, 0, 9),
          behind: intBetween(this.rand, 0, 9),
        });
        const files: MockFile[] = [];
        for (let f = 0; f < filesPer; f++) {
          const dir = DIRS[f % DIRS.length] ?? 'src';
          const name = `${dir}/mod${String(f).padStart(3, '0')}-${NAMES[f % NAMES.length]}`;
          const r = this.rand();
          const status: MockFile['status'] =
            r < 0.75 ? 'modified' : r < 0.85 ? 'added' : r < 0.92 ? 'untracked' : 'deleted';
          files.push(
            this.file(name, status, {
              lines: intBetween(this.rand, 30, 150),
              seed: fnv1a32(`${mw.worktree.id}:${name}`),
            }),
          );
        }
        mw.files = files;
      }
    }
  }

  // --- lookups --------------------------------------------------------------------------

  private findWorktree(worktreeId: string): { mp: MockProject; mw: MockWorktree } {
    for (const mp of this.projects) {
      const mw = mp.worktrees.find((w) => w.worktree.id === worktreeId);
      if (mw) return { mp, mw };
    }
    throw new MockApiError(404, 'not_found', `unknown worktree ${worktreeId}`);
  }

  private filesForScope(mw: MockWorktree, scope: DiffScope): MockFile[] {
    switch (scope.kind) {
      case 'working':
        return mw.files;
      case 'staged':
        return mw.files.filter((f) => f.staged && f.status !== 'untracked');
      case 'unstaged':
        return mw.files.filter((f) => f.unstaged && f.status !== 'untracked');
      case 'branch':
        return mw.worktree.isMain ? [] : mw.branchFiles;
      case 'commit': {
        const sha = scope.sha.toLowerCase();
        const commit = mw.commits.find((c) => c.info.sha.startsWith(sha));
        if (!commit) throw new MockApiError(404, 'not_found', `unknown commit ${scope.sha}`);
        return commit.files;
      }
    }
  }

  private canonicalPatch(mw: MockWorktree, scope: DiffScope, file: MockFile): CanonicalPatch {
    const key = `${mw.worktree.id}|${scopeKey(scope)}|${file.path}|${file.version}|${file.status}`;
    let entry = this.patchCache.get(key);
    if (entry === undefined) {
      const patch = buildPatch(file);
      entry = {
        patch,
        hash: hash40(patch),
        byteLength: byteLength(patch),
        ...countLines(patch, file.kind === 'binary'),
      };
      this.patchCache.set(key, entry);
    }
    return entry;
  }

  private reviewKey(
    projectId: string,
    scopeKind: string,
    file: { path: string; rawPath?: string | undefined },
    patchHash: string,
  ): string {
    return `${projectId}|${scopeKind}|${file.rawPath ?? file.path}|${patchHash}`;
  }

  private changedFile(
    mp: MockProject,
    mw: MockWorktree,
    scope: DiffScope,
    file: MockFile,
  ): ChangedFile {
    const counts = this.canonicalPatch(mw, scope, file);
    const patchHash = counts.hash;
    const sides = fileSides(file);
    const binary = file.kind === 'binary';
    const tracksStage =
      scope.kind === 'working' || scope.kind === 'staged' || scope.kind === 'unstaged';
    return {
      path: file.path,
      ...(file.rawPath ? { rawPath: file.rawPath } : {}),
      oldPath: file.oldPath,
      status: file.status,
      binary,
      oldMode: sides.oldMode,
      newMode: sides.newMode,
      additions: counts.additions,
      deletions: counts.deletions,
      patchHash,
      staged: tracksStage ? file.staged : false,
      unstaged: tracksStage ? file.unstaged : false,
      reviewed: this.reviews.has(this.reviewKey(mp.project.id, scope.kind, file, patchHash)),
    };
  }

  private changedFiles(mp: MockProject, mw: MockWorktree, scope: DiffScope): ChangedFile[] {
    return this.filesForScope(mw, scope)
      .map((f) => this.changedFile(mp, mw, scope, f))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  private summary(mp: MockProject, mw: MockWorktree): WorktreeSummary {
    const files = this.changedFiles(mp, mw, { kind: 'working' });
    let additions = 0;
    let deletions = 0;
    for (const f of files) {
      additions += f.additions ?? 0;
      deletions += f.deletions ?? 0;
    }
    const counts = {
      staged: mw.files.filter((f) => f.staged && f.status !== 'untracked').length,
      unstaged: mw.files.filter((f) => f.unstaged && f.status !== 'untracked').length,
      untracked: mw.files.filter((f) => f.status === 'untracked').length,
      conflicted: mw.files.filter((f) => f.status === 'conflicted').length,
    };
    const stateHash = hash16(
      `${mw.worktree.headSha}|${mw.revision}|${files.map((f) => `${f.path}:${f.patchHash}`).join(',')}`,
    );
    return {
      worktreeId: mw.worktree.id,
      projectId: mp.project.id,
      branch: mw.worktree.branch,
      headSha: mw.worktree.headSha,
      detached: mw.worktree.detached,
      upstream: mw.upstream,
      aheadBehindRef: mw.aheadBehindRef,
      ahead: mw.ahead,
      behind: mw.behind,
      counts,
      changedFiles: files.length,
      additions,
      deletions,
      inProgress: mw.inProgress,
      stateHash,
      updatedAt: mw.updatedAt,
    };
  }

  // --- routes ---------------------------------------------------------------------------

  health(): HealthResponse {
    return {
      ok: true,
      name: 'octopus-diff',
      version: '0.0.0-mock',
      apiVersion: 1,
      git: { version: '2.53.0', supported: true },
      watcher: { mode: 'native', warnings: [] },
      startedAt: this.startedAt,
      uptimeMs: 1000,
    };
  }

  listProjects(): ProjectsResponse {
    return { projects: this.projects.map((mp) => this.projectItem(mp)) };
  }

  private projectItem(mp: MockProject): ProjectListItem {
    return {
      project: mp.project,
      worktrees: mp.worktrees.map((mw) => ({
        worktree: mw.worktree,
        summary: mw.error || mw.worktree.missing ? null : this.summary(mp, mw),
        error: mw.error ? { code: 'timeout', message: mw.error } : null,
      })),
    };
  }

  inbox(scope: DiffScope, onlyUnreviewed: boolean): InboxResponse {
    if (scope.kind === 'commit') {
      throw new MockApiError(400, 'bad_request', 'commit scope is not supported by the inbox');
    }
    const entries: InboxResponse['entries'] = [];
    for (const mp of this.projects) {
      for (const mw of mp.worktrees) {
        if (mw.error || mw.worktree.missing) continue;
        let files = this.changedFiles(mp, mw, scope);
        if (onlyUnreviewed) files = files.filter((f) => !f.reviewed);
        if (files.length === 0) continue;
        entries.push({
          project: mp.project,
          worktree: mw.worktree,
          summary: this.summary(mp, mw),
          files,
        });
      }
    }
    return { scope, entries, generatedAt: now() };
  }

  listFiles(worktreeId: string, scope: DiffScope): FilesResponse {
    const { mp, mw } = this.findWorktree(worktreeId);
    if (mw.error) throw new MockApiError(500, 'internal', mw.error);
    return {
      worktreeId,
      scope,
      stateHash: this.summary(mp, mw).stateHash,
      files: this.changedFiles(mp, mw, scope),
    };
  }

  getDiff(worktreeId: string, query: DiffQuery): DiffResponse {
    const { mp, mw } = this.findWorktree(worktreeId);
    const files = this.filesForScope(mw, query.scope);
    const file = files.find((f) =>
      query.rawPath ? f.rawPath === query.rawPath : f.path === query.path,
    );
    if (!file) throw new MockApiError(404, 'not_found', `no changes for ${query.path}`);
    const changed = this.changedFile(mp, mw, query.scope, file);
    const { patch: canonical, byteLength: size } = this.canonicalPatch(mw, query.scope, file);
    let patch =
      query.ignoreWhitespace || query.context !== undefined
        ? buildPatch(file, {
            ignoreWhitespace: query.ignoreWhitespace,
            context: query.context ?? 3,
          })
        : canonical;
    let tooLarge = false;
    let truncated = false;
    if (changed.binary) patch = '';
    else if (size > MOCK_SOFT_LIMIT && !query.full) {
      tooLarge = true;
      patch = '';
    } else if (byteLength(patch) > MOCK_HARD_LIMIT) {
      truncated = true;
      const cut = patch.lastIndexOf('\n', MOCK_HARD_LIMIT);
      patch = patch.slice(0, cut + 1);
    }
    const { staged: _staged, unstaged: _unstaged, ...identity } = changed;
    return {
      worktreeId,
      scope: query.scope,
      diff: { ...identity, patch, tooLarge, truncated, byteLength: size },
    };
  }

  listCommits(worktreeId: string, limit: number): CommitsResponse {
    const { mw } = this.findWorktree(worktreeId);
    return { commits: mw.commits.slice(0, limit).map((c) => c.info) };
  }

  refresh(worktreeId: string): RefreshResponse {
    const { mp, mw } = this.findWorktree(worktreeId);
    if (mw.error) throw new MockApiError(500, 'internal', mw.error);
    return { summary: this.summary(mp, mw) };
  }

  setReview(req: ReviewRequest): { ok: true; reviewed: boolean } {
    const key = this.reviewKey(req.projectId, req.scopeKind, req, req.patchHash);
    if (req.reviewed) this.reviews.add(key);
    else this.reviews.delete(key);
    this.emit({
      type: 'review.changed',
      projectId: req.projectId,
      scopeKind: req.scopeKind,
      path: req.path,
      ...(req.rawPath ? { rawPath: req.rawPath } : {}),
      patchHash: req.patchHash,
      reviewed: req.reviewed,
    });
    return { ok: true, reviewed: req.reviewed };
  }

  setFocus(worktreeId: string | null): { ok: true } {
    this.focus = worktreeId;
    return { ok: true };
  }

  addProject(path: string): AddProjectResponse {
    const trimmed = path.replace(/\/+$/, '');
    if (/not-?a-?repo/i.test(trimmed)) {
      throw new MockApiError(400, 'not_a_repository', `${trimmed} is not inside a git repository`);
    }
    const name = trimmed.split('/').pop() || 'project';
    const existing = this.projects.find((p) => p.project.name === name);
    if (existing) return { project: this.projectItem(existing), created: false };
    const mp = this.makeProject(name);
    const mw = this.makeWorktree(mp, { branch: 'main', isMain: true });
    mw.files = [
      this.file('src/index.ts', 'modified'),
      this.file('NEW.md', 'untracked', { lines: 8 }),
    ];
    this.emit({ type: 'project.added', projectId: mp.project.id });
    return { project: this.projectItem(mp), created: true };
  }

  removeProject(projectId: string): { ok: true } {
    const index = this.projects.findIndex((p) => p.project.id === projectId);
    if (index === -1) throw new MockApiError(404, 'not_found', `unknown project ${projectId}`);
    this.projects.splice(index, 1);
    this.emit({ type: 'project.removed', projectId });
    return { ok: true };
  }

  listScanRoots(): { scanRoots: ScanRoot[] } {
    return { scanRoots: this.scanRoots };
  }

  addScanRoot(path: string, depth: number, delayMs = 800): AddScanRootResponse {
    const clean = path.replace(/\/+$/, '');
    const existing = this.scanRoots.find((s) => s.path === clean);
    if (existing) return { scanRoot: existing, created: false };
    const scanRoot: ScanRoot = {
      id: hash16(clean),
      path: clean.startsWith('/') ? clean : `/home/dev/${clean}`,
      depth,
      addedAt: now(),
      lastScannedAt: null,
      projectCount: 0,
    };
    this.scanRoots.push(scanRoot);
    this.emit({
      type: 'scan.progress',
      scanRootId: scanRoot.id,
      state: 'scanning',
      scannedDirs: 0,
      foundRepos: 0,
      message: null,
    });
    const finish = () => {
      const base = clean.split('/').pop() || 'scan';
      for (const suffix of ['alpha', 'beta']) {
        const mp = this.makeProject(`${base}-${suffix}`, { scanRootId: scanRoot.id });
        const mw = this.makeWorktree(mp, { branch: 'main', isMain: true });
        mw.files = [this.file('src/main.ts', 'modified')];
        this.emit({ type: 'project.added', projectId: mp.project.id });
      }
      scanRoot.projectCount = 2;
      scanRoot.lastScannedAt = now();
      this.emit({
        type: 'scan.progress',
        scanRootId: scanRoot.id,
        state: 'done',
        scannedDirs: 42,
        foundRepos: 2,
        message: null,
      });
    };
    if (delayMs <= 0) finish();
    else setTimeout(finish, delayMs);
    return { scanRoot, created: true };
  }

  removeScanRoot(scanRootId: string): { ok: true } {
    const index = this.scanRoots.findIndex((s) => s.id === scanRootId);
    if (index === -1) throw new MockApiError(404, 'not_found', `unknown scan root ${scanRootId}`);
    this.scanRoots.splice(index, 1);
    return { ok: true };
  }

  // --- change simulation ----------------------------------------------------------------

  /** All worktrees that can be mutated (summary computable). */
  worktreeIds(): string[] {
    return this.projects.flatMap((mp) =>
      mp.worktrees.filter((w) => !w.error && !w.worktree.missing).map((w) => w.worktree.id),
    );
  }

  /**
   * Simulates an agent editing a worktree: edits an existing file (its patch changes), adds a
   * new untracked file, or reverts one. Emits `worktree.changed`. Returns what changed.
   */
  mutate(
    worktreeId?: string,
    action?: 'edit' | 'add' | 'revert',
    targetPath?: string,
  ): { worktreeId: string; path: string; action: string } {
    const ids = this.worktreeIds();
    const targetId =
      worktreeId ?? (this.focus && this.rand() < 0.6 ? this.focus : pick(this.rand, ids));
    const { mp, mw } = this.findWorktree(targetId);
    const candidates = mw.files.filter((f) => f.kind === 'text' && f.status !== 'deleted');
    const targeted = targetPath ? candidates.filter((f) => f.path === targetPath) : [];
    const editable = targeted.length > 0 ? targeted : candidates;
    const roll = this.rand();
    const chosen =
      action ??
      (editable.length === 0 || roll < 0.15
        ? 'add'
        : roll < 0.22 && editable.length > 1
          ? 'revert'
          : 'edit');
    let path: string;
    if (chosen === 'add' || editable.length === 0) {
      path = `src/agent/generated-${mw.revision + 1}-${intBetween(this.rand, 100, 999)}.ts`;
      mw.files.push(this.file(path, 'untracked', { lines: intBetween(this.rand, 5, 40) }));
    } else if (chosen === 'revert') {
      const victim = pick(this.rand, editable);
      path = victim.path;
      mw.files.splice(mw.files.indexOf(victim), 1);
    } else {
      const victim = pick(this.rand, editable);
      victim.version += 1;
      victim.unstaged = true;
      path = victim.path;
    }
    mw.revision += 1;
    mw.updatedAt = now();
    const summary = this.summary(mp, mw);
    this.emit({
      type: 'worktree.changed',
      projectId: mp.project.id,
      worktreeId: mw.worktree.id,
      stateHash: summary.stateHash,
    });
    return { worktreeId: mw.worktree.id, path, action: chosen };
  }

  /** Starts random mutations every `intervalMs`; returns a stop function. */
  startSimulator(intervalMs: number): () => void {
    const timer = setInterval(() => {
      if (this.worktreeIds().length > 0) this.mutate();
    }, intervalMs);
    return () => clearInterval(timer);
  }
}

function dedupe(files: MockFile[]): MockFile[] {
  const seen = new Set<string>();
  return files.filter((f) => {
    if (seen.has(f.path)) return false;
    seen.add(f.path);
    return true;
  });
}
