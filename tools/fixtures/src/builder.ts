import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type IsolatedGitEnv, runGit } from './git.js';
import type { Rng } from './random.js';

/** Fixed commit clock: 2026-01-01T00:00:00Z plus one minute per commit, for deterministic shas. */
const BASE_EPOCH = 1_767_225_600;

/**
 * Whether the file system under `parentDir` accepts file names that are not valid UTF-8. Linux file
 * systems take any bytes; APFS (macOS) refuses them with EILSEQ, so scenarios leave the
 * `non-utf8-filename` case out there.
 */
export async function supportsRawFileNames(parentDir: string): Promise<boolean> {
  const dir = await mkdtemp(join(parentDir, 'raw-name-probe-'));
  try {
    await writeFile(Buffer.concat([Buffer.from(`${dir}/`), Buffer.from([0x78, 0xff])]), '');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EILSEQ') return false;
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export class BuildContext {
  readonly env: IsolatedGitEnv;
  readonly rng: Rng;
  #tick = 0;

  constructor(env: IsolatedGitEnv, rng: Rng) {
    this.env = env;
    this.rng = rng;
  }

  nextDate(): string {
    this.#tick++;
    return `@${BASE_EPOCH + this.#tick * 60} +0000`;
  }

  dateEnv(): Record<string, string> {
    const date = this.nextDate();
    return { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  }
}

/** Thin helper around one repository directory used while building fixtures. */
export class RepoBuilder {
  readonly dir: string;
  readonly ctx: BuildContext;

  constructor(ctx: BuildContext, dir: string) {
    this.ctx = ctx;
    this.dir = dir;
  }

  static async init(
    ctx: BuildContext,
    dir: string,
    options: { bare?: boolean; branch?: string } = {},
  ): Promise<RepoBuilder> {
    await mkdir(dir, { recursive: true });
    const args = ['init', '-q'];
    if (options.bare) args.push('--bare');
    args.push(`--initial-branch=${options.branch ?? 'main'}`, '.');
    await runGit(args, { cwd: dir, env: ctx.env });
    return new RepoBuilder(ctx, dir);
  }

  async git(args: string[], options: { allowFailure?: boolean } = {}): Promise<string> {
    const result = await runGit(args, {
      cwd: this.dir,
      env: this.ctx.env,
      extraEnv: this.ctx.dateEnv(),
      ...(options.allowFailure ? { allowFailure: true } : {}),
    });
    return result.stdout.toString('utf8').trim();
  }

  path(rel: string): string {
    return join(this.dir, rel);
  }

  async write(rel: string | Buffer, content: string | Buffer): Promise<void> {
    if (Buffer.isBuffer(rel)) {
      // Raw (possibly non-UTF-8) relative path.
      const full = Buffer.concat([Buffer.from(`${this.dir}/`), rel]);
      const slash = rel.lastIndexOf(0x2f);
      if (slash > 0)
        await mkdir(join(this.dir, rel.subarray(0, slash).toString()), { recursive: true });
      await writeFile(full, content);
      return;
    }
    const full = this.path(rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }

  async writeLines(rel: string, lines: readonly string[], eol = '\n'): Promise<void> {
    await this.write(rel, `${lines.join(eol)}${eol}`);
  }

  async remove(rel: string): Promise<void> {
    await rm(this.path(rel), { recursive: true, force: true });
  }

  async symlink(target: string, rel: string): Promise<void> {
    const full = this.path(rel);
    await mkdir(dirname(full), { recursive: true });
    await rm(full, { force: true });
    await symlink(target, full);
  }

  async add(...paths: string[]): Promise<void> {
    await this.git(['add', '-A', '--', ...(paths.length ? paths : ['.'])]);
  }

  /** Stages everything and commits. Returns the new HEAD sha. */
  async commitAll(message: string): Promise<string> {
    await this.git(['add', '-A']);
    return this.commit(message);
  }

  /** Commits what is staged. */
  async commit(message: string): Promise<string> {
    await this.git(['commit', '-q', '--no-verify', '-m', message]);
    return this.head();
  }

  async head(): Promise<string> {
    return this.git(['rev-parse', 'HEAD']);
  }

  /** `git worktree add`; returns a builder for the new worktree. */
  async addWorktree(
    path: string,
    options: { branch?: string; newBranch?: string; detach?: boolean; commitish?: string } = {},
  ): Promise<RepoBuilder> {
    await mkdir(dirname(path), { recursive: true });
    const args = ['worktree', 'add', '-q'];
    if (options.detach) args.push('--detach');
    if (options.newBranch) args.push('-b', options.newBranch);
    args.push(path);
    if (options.branch) args.push(options.branch);
    else if (options.commitish) args.push(options.commitish);
    await this.git(args);
    return new RepoBuilder(this.ctx, path);
  }
}
