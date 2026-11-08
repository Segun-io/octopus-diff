import type { FileStatus, InProgressOperation, ScopeKind } from '@octopus-diff/contracts';

/**
 * The fixture manifest: everything a test needs to know about the generated repositories.
 *
 * Expectations are ground truth from two sources:
 * - what the generator did (branches, upstreams, the special case placed at each path), and
 * - git itself, run read-only at generation time under the isolated config (`oracle.ts`):
 *   per-scope file lists, statuses, line counts, ahead/behind. Unit tests check that the two agree.
 */
export const MANIFEST_VERSION = 1;

/** Every special case PLAN §6 WS4 asks the fixtures to cover. */
export const SPECIAL_CASES = [
  'untracked',
  'staged-and-unstaged',
  'renamed',
  'copied',
  'deleted',
  'staged-deleted',
  'added',
  'binary',
  'very-large',
  'minified',
  'crlf',
  'non-utf8-filename',
  'symlink',
  'submodule',
  'typechange',
  'conflict',
  'unicode-filename',
  'whitespace-only',
  'stat-dirty',
] as const;
export type SpecialCase = (typeof SPECIAL_CASES)[number];

/** Who may modify a repository while a test or bench runs. */
export type RepoRole =
  /** Never modified after generation: the read-only proof harness snapshots these. */
  | 'control'
  /** Tests and the agent simulator edit these. Excluded from the read-only proof. */
  | 'mutable'
  /** Perf-bench repositories (the bench edits a few of them). */
  | 'bench'
  /** Helper repositories (origins, submodule sources). Never registered with the daemon. */
  | 'source';

export interface ExpectedFile {
  /** Repo-relative display path (lossy U+FFFD replacement when `rawPath` is set). */
  path: string;
  /** Base64 of the raw path bytes; only for non-UTF-8 paths. */
  rawPath?: string;
  oldPath: string | null;
  status: FileStatus;
  binary: boolean;
  /** Null for binary files (and files git reports no line counts for). */
  additions: number | null;
  deletions: number | null;
  /** Git modes from the index/worktree when known (120000 symlink, 160000 submodule). */
  newMode: string | null;
  oldMode: string | null;
}

/** A line of `git status --porcelain=v2` reduced to what tests need. */
export interface ExpectedStatusEntry {
  path: string;
  rawPath?: string;
  oldPath: string | null;
  /** `ordinary` (1), `renamed` (2, rename or copy), `unmerged` (u), `untracked` (?). */
  kind: 'ordinary' | 'renamed' | 'unmerged' | 'untracked';
  /** Index (X) and worktree (Y) status letters; `.` = unchanged, `?` for untracked. */
  x: string;
  y: string;
}

export interface ExpectedCounts {
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
}

export interface CommitFixture {
  sha: string;
  subject: string;
  parents: string[];
  /** Files of `<sha>^..<sha>` (root commits: against the empty tree). Present for listed commits. */
  files?: ExpectedFile[];
}

export interface WorktreeFixture {
  /** Fixture-local name, unique across the manifest (e.g. `alpha`, `alpha-login`). */
  name: string;
  /** Expected `WorktreeId` (contracts #8: sha256(realpath) first 16 hex chars). */
  id: string;
  /** Realpath of the worktree root (bare entry: the git dir). */
  path: string;
  isMain: boolean;
  bare: boolean;
  branch: string | null;
  detached: boolean;
  headSha: string | null;
  /** Upstream tracking ref (`origin/main`) or null. */
  upstream: string | null;
  /**
   * Expected ahead/behind. `undefined` = don't assert (the contract leaves it to git-core, e.g.
   * for detached worktrees); `null` = must be null.
   */
  aheadBehindRef?: string | null;
  ahead?: number | null;
  behind?: number | null;
  counts: ExpectedCounts;
  /** Distinct paths changed in the working scope (tracked changes + untracked). */
  changedFiles: number;
  dirty: boolean;
  inProgress: InProgressOperation | null;
  status: ExpectedStatusEntry[];
  /** Expected files per scope (working, staged, unstaged; branch when it applies). */
  scopes: Partial<Record<Exclude<ScopeKind, 'commit'>, ExpectedFile[]>>;
  /** Recent commits reachable from HEAD, newest first (at most 20). */
  commits: CommitFixture[];
}

export interface ProjectFixture {
  /** Display name the UI should show (basename of the main worktree, or of the git dir). */
  name: string;
  /** Expected `ProjectId` (contracts #8). */
  id: string;
  role: RepoRole;
  /** Realpath of the common git dir. */
  commonDir: string;
  mainWorktreePath: string | null;
  bare: boolean;
  /** Expected detected default branch. */
  defaultBranch: string | null;
  /** How the e2e suite registers it: by path, or found under a scan root. */
  registration: { kind: 'path'; path: string } | { kind: 'scan'; scanRoot: string } | null;
  worktrees: WorktreeFixture[];
  /** Special cases placed in this project: case → worktree name + path. */
  cases: Partial<Record<SpecialCase, CaseLocation>>;
}

export interface CaseLocation {
  worktree: string;
  path: string;
  rawPath?: string;
  /** Text that appears on an added line of the case's diff (for UI assertions). */
  addedMarker?: string;
  /** Text that appears on a removed line of the case's diff. */
  removedMarker?: string;
}

export interface ScanRootFixture {
  path: string;
  depth: number;
  /** Project names that a scan of `path` at `depth` must find. */
  expectedProjects: string[];
  /** Repository directories under `path` that must NOT be found (node_modules, too deep). */
  excludedRepoPaths: string[];
  /** Symlinks that form loops (the scanner must not follow them forever). */
  symlinkLoops: string[];
}

export interface FixtureManifest {
  version: typeof MANIFEST_VERSION;
  seed: number;
  /** Realpath of the fixture root (under the OS temp dir). */
  root: string;
  createdAt: string;
  /** Isolated git config + variables used for every git process. Pass `vars` to the daemon. */
  git: { configPath: string; vars: Record<string, string> };
  projects: ProjectFixture[];
  scanRoots: ScanRootFixture[];
  /** Paths the e2e suite registers explicitly with the daemon. */
  registerPaths: string[];
}

export function findProject(manifest: FixtureManifest, name: string): ProjectFixture {
  const project = manifest.projects.find((p) => p.name === name);
  if (!project) throw new Error(`fixture project not found: ${name}`);
  return project;
}

export function findWorktree(
  manifest: FixtureManifest,
  name: string,
): { project: ProjectFixture; worktree: WorktreeFixture } {
  for (const project of manifest.projects) {
    const worktree = project.worktrees.find((w) => w.name === name);
    if (worktree) return { project, worktree };
  }
  throw new Error(`fixture worktree not found: ${name}`);
}

export function allWorktrees(
  manifest: FixtureManifest,
  filter: (project: ProjectFixture) => boolean = () => true,
): Array<{ project: ProjectFixture; worktree: WorktreeFixture }> {
  return manifest.projects
    .filter(filter)
    .flatMap((project) => project.worktrees.map((worktree) => ({ project, worktree })));
}

/** Projects the daemon is expected to know about (everything except helper `source` repos). */
export function registeredProjects(manifest: FixtureManifest): ProjectFixture[] {
  return manifest.projects.filter((p) => p.role !== 'source' && p.registration !== null);
}
