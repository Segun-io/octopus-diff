import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Git process isolation for fixtures (AGENTS.md "Tests that create git repositories").
 *
 * The dev machine's global config sets `core.autocrlf=input`, `core.pager=delta` and more, and
 * the global excludes / attributes files (`~/.config/git/{ignore,attributes}`) are read even when
 * `GIT_CONFIG_GLOBAL` is set. Every git process that creates or inspects fixtures therefore gets
 * a private global config inside the fixture root that pins the relevant options, and empty
 * excludes / attributes files.
 */
export interface IsolatedGitEnv {
  /** Path of the private global config (`GIT_CONFIG_GLOBAL`). */
  readonly configPath: string;
  /** Variables to pass to every git process (also to the daemon via `GitCoreOptions.env`). */
  readonly vars: Readonly<Record<string, string>>;
}

export const FIXTURE_USER_NAME = 'Octopus Fixture';
export const FIXTURE_USER_EMAIL = 'fixtures@octopus-diff.invalid';

/**
 * A path as a git config value. A Windows path has backslashes, which git config reads as escape
 * sequences (`C:\Users` is a "bad config line"); git accepts forward slashes there.
 */
export function configPathValue(p: string): string {
  return p.replaceAll('\\', '/');
}

/** Writes the isolated config files into `dir` and returns the env to use with them. */
export async function createIsolatedGitEnv(dir: string): Promise<IsolatedGitEnv> {
  const configPath = join(dir, '.gitconfig-isolated');
  const excludesPath = join(dir, '.gitignore-isolated');
  const attributesPath = join(dir, '.gitattributes-isolated');
  await writeFile(excludesPath, '');
  await writeFile(attributesPath, '');
  const config = [
    '[user]',
    `\tname = ${FIXTURE_USER_NAME}`,
    `\temail = ${FIXTURE_USER_EMAIL}`,
    '[init]',
    '\tdefaultBranch = main',
    '[commit]',
    '\tgpgsign = false',
    '[tag]',
    '\tgpgsign = false',
    '[core]',
    '\tautocrlf = false',
    '\tsafecrlf = false',
    '\tpager = cat',
    '\tfsmonitor = false',
    `\texcludesFile = ${configPathValue(excludesPath)}`,
    `\tattributesFile = ${configPathValue(attributesPath)}`,
    '[gc]',
    '\tauto = 0',
    '[maintenance]',
    '\tauto = false',
    '[advice]',
    '\tdetachedHead = false',
    '\tdefaultBranchName = false',
    '[merge]',
    '\tconflictStyle = merge',
    '[pull]',
    '\trebase = false',
    // Local `submodule add <path>` needs the file transport (blocked by default since 2.38.1).
    '[protocol "file"]',
    '\tallow = always',
    '',
  ].join('\n');
  await writeFile(configPath, config);
  return {
    configPath,
    vars: {
      GIT_CONFIG_GLOBAL: configPath,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_ATTR_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_PAGER: 'cat',
      GIT_EDITOR: 'true',
      GIT_MERGE_AUTOEDIT: 'no',
      LC_ALL: 'C',
    },
  };
}

/**
 * `process.env` without any inherited `GIT_*` variable (a test run from inside a git hook would
 * otherwise inherit `GIT_DIR` / `GIT_INDEX_FILE` and operate on the wrong repository), plus `vars`.
 */
export function cleanGitEnv(vars: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  return { ...env, ...vars };
}

export interface GitResult {
  stdout: Buffer;
  stderr: string;
  code: number;
}

export interface RunGitOptions {
  cwd: string;
  env: IsolatedGitEnv;
  /** Extra variables for this call (e.g. fixed commit dates). */
  extraEnv?: Record<string, string>;
  /** Resolve instead of rejecting on a non-zero exit code. */
  allowFailure?: boolean;
  timeoutMs?: number;
}

export class FixtureGitError extends Error {
  readonly args: string[];
  readonly code: number;
  readonly stderr: string;

  constructor(args: string[], cwd: string, code: number, stderr: string) {
    super(`git ${args.join(' ')} failed in ${cwd} (exit ${code}): ${stderr.trim()}`);
    this.name = 'FixtureGitError';
    this.args = args;
    this.code = code;
    this.stderr = stderr;
  }
}

/** Runs git with an argv array (never a shell) under the isolated environment. */
export function runGit(args: string[], options: RunGitOptions): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd: options.cwd,
        env: cleanGitEnv({ ...options.env.vars, ...options.extraEnv }),
        encoding: 'buffer',
        maxBuffer: 512 * 1024 * 1024,
        timeout: options.timeoutMs ?? 60_000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as NodeJS.ErrnoException).code === 'number'
            ? ((error as NodeJS.ErrnoException).code as unknown as number)
            : error
              ? 1
              : 0;
        const result: GitResult = { stdout, stderr: stderr.toString('utf8'), code };
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new Error('git executable not found on PATH'));
          return;
        }
        if (code !== 0 && !options.allowFailure) {
          reject(new FixtureGitError(args, options.cwd, code, result.stderr));
          return;
        }
        resolve(result);
      },
    );
  });
}

/** Like `runGit` but returns stdout as UTF-8 text with the trailing newline trimmed. */
export async function gitText(args: string[], options: RunGitOptions): Promise<string> {
  const { stdout } = await runGit(args, options);
  return stdout.toString('utf8').replace(/\n$/, '');
}

/** Read-only flags every inspection command in this package uses (PLAN §5.5). */
export const READ_ONLY_GIT_ARGS = ['--no-optional-locks', '-c', 'core.fsmonitor=false'] as const;

export const EMPTY_TREE_SHA1 = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
