import type {
  ChangeRequest,
  ForgeCliStatus,
  ForgeKind,
  ProjectForge,
} from '@octopus-diff/contracts';
import { firstSafeLine, parseAuthStatus, stripControl } from './auth.js';
import { FORGE_EXECUTABLES, type ForgeCli, ForgeCliError } from './cli.js';
import {
  buildGithubQuery,
  GITHUB_MAX_BRANCHES_PER_QUERY,
  type GithubQueryVariant,
  type GraphqlBatchResult,
  parseGithubResponse,
} from './github.js';
import {
  buildGitlabQuery,
  GITLAB_MAX_BRANCHES_PER_QUERY,
  type GitlabQueryVariant,
  isUnknownFieldError,
  parseGitlabResponse,
} from './gitlab.js';
import { asNumber, asRecord, parseJsonObject } from './json.js';

const HINTS: Record<ForgeKind, { install: string; login: string }> = {
  github: {
    install:
      'Install the GitHub CLI (`gh`) from https://cli.github.com/, then run `gh auth login`.',
    login: 'Run `gh auth login` (add `--hostname <host>` for GitHub Enterprise).',
  },
  gitlab: {
    install:
      'Install the GitLab CLI (`glab`) from https://gitlab.com/gitlab-org/cli, then run `glab auth login`.',
    login: 'Run `glab auth login` (add `--hostname <host>` for a self-managed GitLab).',
  },
};

export function loginHint(kind: ForgeKind, host: string): string {
  return kind === 'github'
    ? `Run \`gh auth login --hostname ${host}\` so octopus-diff can read pull requests.`
    : `Run \`glab auth login --hostname ${host}\` so octopus-diff can read merge requests.`;
}

/** A failed fetch, with a short message that is safe to show (no tokens, no control chars). */
export class ForgeFetchError extends Error {
  readonly notFound: boolean;
  constructor(message: string, options?: { cause?: unknown; notFound?: boolean }) {
    super(message, options);
    this.name = 'ForgeFetchError';
    this.notFound = options?.notFound ?? false;
  }
}

function shortMessage(text: string): string {
  const line = firstSafeLine(text) ?? 'no output';
  return line.replace(/^(gh|glab):\s*/, '');
}

/** GitHub's `rateLimit { cost remaining }` of one query (every GitHub query asks for it). */
export interface ForgeQueryCost {
  kind: ForgeKind;
  host: string;
  /** Query operation name, e.g. `OctopusDiffPullRequests`. */
  operation: string;
  cost: number;
  remaining: number | null;
}

export interface ForgeClientOptions {
  now?: () => Date;
  /** Called after each query that reported its rate-limit cost (logging, live tests). */
  onCost?: (cost: ForgeQueryCost) => void;
}

export class ForgeClient {
  readonly #cli: ForgeCli;
  readonly #now: () => Date;
  readonly #onCost: ((cost: ForgeQueryCost) => void) | undefined;

  constructor(cli: ForgeCli, options: ForgeClientOptions = {}) {
    this.#cli = cli;
    this.#now = options.now ?? (() => new Date());
    this.#onCost = options.onCost;
  }

  /** `--version` and `auth status` (both always run; neither prints a token). */
  async probe(kind: ForgeKind): Promise<ForgeCliStatus> {
    const executable = FORGE_EXECUTABLES[kind];
    const base = {
      kind,
      executable,
      checkedAt: this.#now().toISOString(),
    };
    let version: string | null;
    try {
      const result = await this.#cli.run(kind, ['--version'], { timeoutMs: 5_000 });
      version = firstSafeLine(result.stdout) ?? firstSafeLine(result.stderr);
    } catch (error) {
      const missing = error instanceof ForgeCliError && error.code === 'missing';
      return {
        ...base,
        available: false,
        version: null,
        auth: 'unknown',
        accounts: [],
        hint: HINTS[kind].install,
        detail: missing ? `${executable} was not found on the daemon's PATH.` : String(error),
      };
    }
    try {
      let result = await this.#cli.run(
        kind,
        kind === 'gitlab' ? ['auth', 'status', '--all'] : ['auth', 'status'],
        { timeoutMs: 10_000 },
      );
      let text = `${result.stdout}\n${result.stderr}`;
      // glab before 1.79 lists every host already and rejects `--all`.
      if (kind === 'gitlab' && /unknown flag:? --all/i.test(text)) {
        result = await this.#cli.run(kind, ['auth', 'status'], { timeoutMs: 10_000 });
        text = `${result.stdout}\n${result.stderr}`;
      }
      const accounts = parseAuthStatus(text);
      return {
        ...base,
        available: true,
        version,
        auth:
          accounts.length > 0
            ? 'authenticated'
            : result.exitCode !== 0
              ? 'unauthenticated'
              : 'unknown',
        accounts,
        hint: HINTS[kind].login,
        detail: accounts.length > 0 ? null : firstSafeLine(text),
      };
    } catch (error) {
      return {
        ...base,
        available: true,
        version,
        auth: 'unknown',
        accounts: [],
        hint: HINTS[kind].login,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Requests whose head/source branch is one of `branches`, per branch (up to 5 each, newest
   * first). Batches of 20 branches per GraphQL query. Rejects with `ForgeFetchError`.
   */
  async fetchChangeRequests(
    forge: Pick<ProjectForge, 'kind' | 'host' | 'repository'>,
    branches: readonly string[],
  ): Promise<Map<string, ChangeRequest[]>> {
    const unique = [...new Set(branches)];
    const result = new Map<string, ChangeRequest[]>();
    const max =
      forge.kind === 'github' ? GITHUB_MAX_BRANCHES_PER_QUERY : GITLAB_MAX_BRANCHES_PER_QUERY;
    for (let i = 0; i < unique.length; i += max) {
      const batch = unique.slice(i, i + max);
      const parsed =
        forge.kind === 'github'
          ? await this.#githubBatch(forge, batch, 'full')
          : await this.#gitlabBatch(forge, batch, 'full');
      for (const [branch, list] of parsed.byBranch) result.set(branch, list);
    }
    return result;
  }

  async #query(
    kind: ForgeKind,
    host: string,
    query: string,
    fields: Array<[string, string]>,
  ): Promise<{ json: Record<string, unknown> | null; stderr: string; exitCode: number }> {
    const args = ['api', 'graphql', '--hostname', host, '--raw-field', `query=${query}`];
    for (const [name, value] of fields) args.push('--raw-field', `${name}=${value}`);
    let result: Awaited<ReturnType<ForgeCli['run']>>;
    try {
      result = await this.#cli.run(kind, args, { host });
    } catch (error) {
      throw new ForgeFetchError(error instanceof Error ? error.message : String(error), {
        cause: error,
      });
    }
    const json = parseJsonObject(result.stdout);
    const rate = asRecord(asRecord(json?.data)?.rateLimit);
    const cost = asNumber(rate?.cost);
    if (cost !== null && this.#onCost) {
      this.#onCost({
        kind,
        host,
        operation: /^query (\w+)/.exec(query)?.[1] ?? 'query',
        cost,
        remaining: asNumber(rate?.remaining),
      });
    }
    return { json, stderr: stripControl(result.stderr), exitCode: result.exitCode };
  }

  #check(
    parsed: GraphqlBatchResult,
    raw: { json: unknown; stderr: string; exitCode: number },
    what: string,
  ) {
    if (parsed.notFound) {
      throw new ForgeFetchError(`${what} was not found, or the signed-in account cannot see it.`, {
        notFound: true,
      });
    }
    if (raw.json === null) {
      throw new ForgeFetchError(shortMessage(raw.stderr || `exit code ${raw.exitCode}`));
    }
    if (parsed.errors.length > 0 && [...parsed.byBranch.values()].every((l) => l.length === 0)) {
      throw new ForgeFetchError(parsed.errors[0] ?? 'GraphQL error');
    }
  }

  async #githubBatch(
    forge: Pick<ProjectForge, 'host' | 'repository'>,
    branches: readonly string[],
    variant: GithubQueryVariant,
  ): Promise<GraphqlBatchResult> {
    const [owner = '', name = ''] = forge.repository.split('/');
    const query = buildGithubQuery(branches.length, variant);
    const raw = await this.#query('github', forge.host, query, [
      ['owner', owner],
      ['name', name],
      ...branches.map((b, i): [string, string] => [`b${i}`, b]),
    ]);
    const parsed = parseGithubResponse(raw.json, branches);
    if (variant === 'full' && isUnknownFieldError(parsed.errors)) {
      return this.#githubBatch(forge, branches, 'basic');
    }
    this.#check(parsed, raw, `GitHub repository ${forge.repository}`);
    return parsed;
  }

  async #gitlabBatch(
    forge: Pick<ProjectForge, 'host' | 'repository'>,
    branches: readonly string[],
    variant: GitlabQueryVariant,
  ): Promise<GraphqlBatchResult> {
    const raw = await this.#query(
      'gitlab',
      forge.host,
      buildGitlabQuery(branches.length, variant),
      [['fullPath', forge.repository], ...branches.map((b, i): [string, string] => [`b${i}`, b])],
    );
    const parsed = parseGitlabResponse(raw.json, branches);
    if (variant === 'full' && isUnknownFieldError(parsed.errors)) {
      return this.#gitlabBatch(forge, branches, 'basic');
    }
    this.#check(parsed, raw, `GitLab project ${forge.repository}`);
    return parsed;
  }
}
