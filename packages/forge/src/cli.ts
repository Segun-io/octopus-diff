import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { ForgeHostSchema, type ForgeKind } from '@octopus-diff/contracts';
import { buildGithubQuery, GITHUB_MAX_BRANCHES_PER_QUERY } from './github.js';
import { buildGitlabQuery, GITLAB_MAX_BRANCHES_PER_QUERY } from './gitlab.js';

/**
 * The only way octopus-diff runs `gh` / `glab` (docs/FORGES.md "Safety"). Mirrors git-core's
 * runner rules: argv arrays only (never a shell), an argument allowlist checked before spawning,
 * a neutral working directory (never a user repository, so the CLIs do not read untrusted repo
 * config or run git there), a hardened environment, timeouts, output caps and a concurrency limit.
 *
 * Allowed invocations, nothing else:
 *   <cli> --version
 *   <cli> auth status [--hostname <host>]        glab also: auth status --all
 *   <cli> api graphql --hostname <host> --raw-field query=<Q> --raw-field <var>=<value>...
 * where Q must be exactly one of the queries built by `buildGithubQuery` / `buildGitlabQuery`
 * (read-only `query` operations) for the number of branch variables given.
 */

export const FORGE_EXECUTABLES: Record<ForgeKind, string> = { github: 'gh', gitlab: 'glab' };

export type ForgeCliErrorCode = 'missing' | 'not_allowed' | 'timeout' | 'too_large' | 'spawn';

export class ForgeCliError extends Error {
  readonly code: ForgeCliErrorCode;
  constructor(code: ForgeCliErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ForgeCliError';
    this.code = code;
  }
}

export interface ForgeCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ForgeCliOptions {
  /** Executable per forge; default `gh` / `glab` from PATH. */
  binaries?: Partial<Record<ForgeKind, string>>;
  /** Working directory for every process; default the OS temp dir. Never a repository. */
  cwd?: string;
  /** Base environment; default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Per-invocation timeout (default 20 000 ms). */
  timeoutMs?: number;
  /** stdout cap (default 8 MiB); exceeding it kills the process. */
  maxOutputBytes?: number;
  /** Concurrent processes per CLI (default 2). */
  concurrency?: number;
}

function deny(message: string): never {
  throw new ForgeCliError('not_allowed', message);
}

const VAR_NAME = /^[A-Za-z][A-Za-z0-9]*$/;

function checkHost(host: string | undefined): string {
  if (host === undefined || !ForgeHostSchema.safeParse(host).success) {
    deny(`invalid forge host: ${String(host)}`);
  }
  return host;
}

/** Throws `not_allowed` unless `args` is one of the allowed read-only invocations. */
export function assertAllowedForgeArgs(kind: ForgeKind, args: readonly string[]): void {
  for (const arg of args) {
    if (arg.includes('\u0000')) deny('arguments must not contain NUL');
  }
  if (args.length === 1 && args[0] === '--version') return;
  if (args[0] === 'auth' && args[1] === 'status') {
    if (args.length === 2) return;
    if (args.length === 3 && args[2] === '--all' && kind === 'gitlab') return;
    if (args.length === 4 && args[2] === '--hostname') {
      checkHost(args[3]);
      return;
    }
    deny(`auth status arguments not allowed: ${args.slice(2).join(' ')}`);
  }
  if (args[0] === 'api' && args[1] === 'graphql') {
    if (args[2] !== '--hostname') deny('api graphql requires --hostname first');
    checkHost(args[3]);
    const fields = new Map<string, string>();
    for (let i = 4; i < args.length; i += 2) {
      if (args[i] !== '--raw-field') deny(`api option not allowed: ${args[i]}`);
      const field = args[i + 1];
      if (field === undefined) deny('--raw-field needs a value');
      const eq = field.indexOf('=');
      const name = eq > 0 ? field.slice(0, eq) : '';
      if (!VAR_NAME.test(name)) deny(`invalid field name: ${name}`);
      if (fields.has(name)) deny(`duplicate field: ${name}`);
      fields.set(name, field.slice(eq + 1));
    }
    const query = fields.get('query');
    if (query === undefined) deny('api graphql requires a query');
    fields.delete('query');
    const branchVars = [...fields.keys()].filter((k) => /^b\d+$/.test(k));
    const count = branchVars.length;
    for (let i = 0; i < count; i++) {
      if (!fields.has(`b${i}`)) deny('branch variables must be b0..bN');
    }
    const fixed = kind === 'github' ? ['owner', 'name'] : ['fullPath'];
    for (const name of fields.keys()) {
      if (!/^b\d+$/.test(name) && !fixed.includes(name)) deny(`field not allowed: ${name}`);
    }
    for (const name of fixed) if (!fields.has(name)) deny(`missing field: ${name}`);
    for (const value of fields.values()) {
      if (value.length === 0 || value.length > 1024 || /[\r\n]/.test(value)) {
        deny('invalid field value');
      }
    }
    const max = kind === 'github' ? GITHUB_MAX_BRANCHES_PER_QUERY : GITLAB_MAX_BRANCHES_PER_QUERY;
    if (count < 1 || count > max) deny(`branch count out of range: ${count}`);
    const allowed =
      kind === 'github'
        ? [buildGithubQuery(count)]
        : [buildGitlabQuery(count, 'full'), buildGitlabQuery(count, 'basic')];
    if (!allowed.includes(query)) deny('query is not one of the built-in read-only queries');
    return;
  }
  deny(`${FORGE_EXECUTABLES[kind]} invocation not allowed: ${args.slice(0, 2).join(' ')}`);
}

function isGithubDotCom(host: string): boolean {
  return host === 'github.com' || host.endsWith('.ghe.com');
}

function hostOfUrl(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  try {
    return new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).host;
  } catch {
    return null;
  }
}

/** Variables never passed through: they change targets, enable debug output or open UIs. */
const DROPPED = [
  'GH_REPO',
  'GH_DEBUG',
  'GH_BROWSER',
  'GH_EDITOR',
  'GITLAB_REPO',
  'GLAB_DEBUG_HTTP',
  'DEBUG',
  'BROWSER',
  'EDITOR',
  'VISUAL',
];

/**
 * Environment for one CLI process. Token variables are dropped unless they belong to `host`:
 * `gh` sends `GH_ENTERPRISE_TOKEN` to any non-github.com host and `glab` sends `GITLAB_TOKEN`
 * to whatever host it is asked about, so a crafted remote URL could otherwise receive them.
 */
export function forgeEnv(
  kind: ForgeKind,
  host: string | null,
  base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of DROPPED) delete env[name];
  if (kind === 'github') {
    const userHost = hostOfUrl(base.GH_HOST);
    if (host === null || !isGithubDotCom(host)) {
      delete env.GH_TOKEN;
      delete env.GITHUB_TOKEN;
    }
    if (host === null || isGithubDotCom(host) || userHost !== host) {
      delete env.GH_ENTERPRISE_TOKEN;
      delete env.GITHUB_ENTERPRISE_TOKEN;
    }
    delete env.GH_HOST;
    Object.assign(env, {
      GH_PROMPT_DISABLED: '1',
      GH_NO_UPDATE_NOTIFIER: '1',
      GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
      GH_SPINNER_DISABLED: '1',
      GH_PAGER: 'cat',
    });
  } else {
    const userHost = hostOfUrl(base.GITLAB_HOST ?? base.GITLAB_URI ?? base.GL_HOST) ?? 'gitlab.com';
    if (host === null || userHost !== host) {
      delete env.GITLAB_TOKEN;
      delete env.GITLAB_ACCESS_TOKEN;
      delete env.OAUTH_TOKEN;
    }
    delete env.GITLAB_URI;
    delete env.GL_HOST;
    if (host === null) delete env.GITLAB_HOST;
    else env.GITLAB_HOST = host;
    Object.assign(env, { GLAB_NO_PROMPT: '1', GLAB_PAGER: 'cat' });
  }
  Object.assign(env, {
    NO_COLOR: '1',
    CLICOLOR: '0',
    PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  });
  return env;
}

class Semaphore {
  #active = 0;
  readonly #queue: Array<() => void> = [];
  constructor(readonly limit: number) {}
  async acquire(): Promise<() => void> {
    if (this.#active >= this.limit) {
      await new Promise<void>((resolve) => this.#queue.push(resolve));
    }
    this.#active += 1;
    return () => {
      this.#active -= 1;
      this.#queue.shift()?.();
    };
  }
}

const STDERR_CAP = 64 * 1024;

export class ForgeCli {
  readonly #options: Required<Omit<ForgeCliOptions, 'binaries'>> & {
    binaries: Record<ForgeKind, string>;
  };
  readonly #limits: Record<ForgeKind, Semaphore>;

  constructor(options: ForgeCliOptions = {}) {
    this.#options = {
      binaries: { ...FORGE_EXECUTABLES, ...options.binaries },
      cwd: options.cwd ?? tmpdir(),
      env: options.env ?? process.env,
      timeoutMs: options.timeoutMs ?? 20_000,
      maxOutputBytes: options.maxOutputBytes ?? 8 * 1024 * 1024,
      concurrency: options.concurrency ?? 2,
    };
    this.#limits = {
      github: new Semaphore(this.#options.concurrency),
      gitlab: new Semaphore(this.#options.concurrency),
    };
  }

  /**
   * Runs an allowed invocation. Resolves with the exit code (non-zero is not an error here:
   * `auth status` exits 1 when signed out); rejects with `ForgeCliError` for a missing CLI,
   * disallowed arguments, timeouts and oversized output.
   */
  async run(
    kind: ForgeKind,
    args: readonly string[],
    options: { host?: string | null; timeoutMs?: number } = {},
  ): Promise<ForgeCliResult> {
    assertAllowedForgeArgs(kind, args);
    const host = options.host ?? null;
    if (host !== null) checkHost(host);
    const release = await this.#limits[kind].acquire();
    try {
      return await this.#spawn(kind, args, host, options.timeoutMs ?? this.#options.timeoutMs);
    } finally {
      release();
    }
  }

  #spawn(
    kind: ForgeKind,
    args: readonly string[],
    host: string | null,
    timeoutMs: number,
  ): Promise<ForgeCliResult> {
    const executable = this.#options.binaries[kind];
    return new Promise((resolve, reject) => {
      const child = spawn(executable, [...args], {
        cwd: this.#options.cwd,
        env: forgeEnv(kind, host, this.#options.env),
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      let failure: ForgeCliError | null = null;
      const fail = (error: ForgeCliError) => {
        if (failure) return;
        failure = error;
        child.kill('SIGKILL');
      };
      const timer = setTimeout(
        () => fail(new ForgeCliError('timeout', `${executable} timed out after ${timeoutMs} ms`)),
        timeoutMs,
      );
      child.stdout.on('data', (chunk: Buffer) => {
        outBytes += chunk.length;
        if (outBytes > this.#options.maxOutputBytes) {
          fail(new ForgeCliError('too_large', `${executable} output exceeded the cap`));
          return;
        }
        out.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (errBytes >= STDERR_CAP) return;
        errBytes += chunk.length;
        err.push(chunk);
      });
      child.on('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (failure) return;
        failure =
          error.code === 'ENOENT'
            ? new ForgeCliError('missing', `${executable} is not installed (not on PATH)`, {
                cause: error,
              })
            : new ForgeCliError('spawn', `could not run ${executable}: ${error.message}`, {
                cause: error,
              });
        reject(failure);
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (failure) {
          reject(failure);
          return;
        }
        resolve({
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
          exitCode: code ?? (signal ? 128 : 1),
        });
      });
    });
  }
}
