import type {
  ChangeRequest,
  ChangeRequestConversation,
  ChangeRequestDetail,
  ForgeCliStatus,
  ForgeKind,
  ForgeRepositoryInfo,
  ProjectForge,
} from '@octopus-diff/contracts';
import { firstSafeLine, parseAuthStatus, stripControl } from './auth.js';
import { FORGE_EXECUTABLES, type ForgeCli, ForgeCliError } from './cli.js';
import {
  buildGithubQuery,
  GITHUB_MAX_BRANCHES_PER_QUERY,
  type GithubQueryVariant,
  type GraphqlBatchResult,
  graphqlErrors,
  parseGithubResponse,
} from './github.js';
import {
  buildGithubConversationQuery,
  buildGithubDetailQuery,
  buildGithubRepositoryQuery,
  normaliseGithubConversation,
  normaliseGithubDetail,
  normaliseGithubRepository,
} from './github-details.js';
import {
  buildGitlabQuery,
  GITLAB_MAX_BRANCHES_PER_QUERY,
  type GitlabQueryVariant,
  isUnknownFieldError,
  parseGitlabResponse,
} from './gitlab.js';
import {
  buildGitlabConversationQuery,
  buildGitlabDetailQuery,
  buildGitlabRepositoryQuery,
  normaliseGitlabConversation,
  normaliseGitlabDetail,
  normaliseGitlabRepository,
} from './gitlab-details.js';
import { asNumber, asRecord, asString, parseJsonObject } from './json.js';

/** The forge repository a single-object query is about. */
export type ForgeTarget = Pick<ProjectForge, 'kind' | 'host' | 'repository' | 'webUrl'>;

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
  /**
   * The forge refused because a rate limit is used up (GitHub primary or secondary limit, GitLab
   * HTTP 429). The CLIs expose no response headers within the read-only allowlist, so this is
   * recognised from the message (`gh: API rate limit exceeded ... (HTTP 403)`, a GraphQL
   * `RATE_LIMITED` error, `HTTP 429`).
   */
  readonly rateLimited: boolean;
  constructor(
    message: string,
    options?: { cause?: unknown; notFound?: boolean; rateLimited?: boolean },
  ) {
    super(message, options);
    this.name = 'ForgeFetchError';
    this.notFound = options?.notFound ?? false;
    this.rateLimited = options?.rateLimited ?? isRateLimitMessage(message);
  }
}

/** A forge's own words for "slow down": the primary or secondary limit, or a 429. */
export function isRateLimitMessage(text: string): boolean {
  return /rate limit|RATE_LIMITED|abuse detection|too many requests|HTTP 429/i.test(text);
}

function shortMessage(text: string): string {
  const line = firstSafeLine(text) ?? 'no output';
  return line.replace(/^(gh|glab):\s*/, '');
}

/** GitHub's `rateLimit { cost remaining resetAt }` of one query (every GitHub query asks for it). */
export interface ForgeQueryCost {
  kind: ForgeKind;
  host: string;
  /** Query operation name, e.g. `OctopusDiffPullRequests`. */
  operation: string;
  cost: number;
  remaining: number | null;
  /** When the hourly window resets (ISO time), when the response said. */
  resetAt: string | null;
}

export interface ForgeClientOptions {
  now?: () => Date;
  /** Called after each query that reported its rate-limit cost (logging, live tests). */
  onCost?: (cost: ForgeQueryCost) => void;
}

/** How long a host that rejected the full queries is asked with the basic ones straight away. */
const BASIC_MEMO_MS = 60 * 60_000;

export class ForgeClient {
  readonly #cli: ForgeCli;
  readonly #now: () => Date;
  readonly #onCost: ((cost: ForgeQueryCost) => void) | undefined;
  /** `kind host query` -> time until which the basic variant is used (the full one was rejected). */
  readonly #basicUntil = new Map<string, number>();

  constructor(cli: ForgeCli, options: ForgeClientOptions = {}) {
    this.#cli = cli;
    this.#now = options.now ?? (() => new Date());
    this.#onCost = options.onCost;
  }

  /**
   * The query variant to start with for a host. A GitHub Enterprise Server or self-managed GitLab
   * that rejected the full fields would otherwise be asked twice on every refresh (the rejected
   * query, then the basic one): a process spawn and a round trip wasted each time.
   */
  #variant<V extends 'full' | 'basic'>(kind: ForgeKind, host: string, query: string): V {
    const until = this.#basicUntil.get(`${kind} ${host} ${query}`);
    return (until !== undefined && this.#now().getTime() < until ? 'basic' : 'full') as V;
  }

  #rememberBasic(kind: ForgeKind, host: string, query: string): void {
    this.#basicUntil.set(`${kind} ${host} ${query}`, this.#now().getTime() + BASIC_MEMO_MS);
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
          ? await this.#githubBatch(forge, batch, this.#variant(forge.kind, forge.host, 'batch'))
          : await this.#gitlabBatch(forge, batch, this.#variant(forge.kind, forge.host, 'batch'));
      for (const [branch, list] of parsed.byBranch) result.set(branch, list);
    }
    return result;
  }

  /**
   * Forge facts about a repository (Overview): description, visibility, default-branch CI, open
   * request count and the newest open requests. One query (1 GitHub point).
   */
  async fetchRepository(forge: ForgeTarget): Promise<ForgeRepositoryInfo> {
    const what = this.#what(forge);
    if (forge.kind === 'github') {
      const raw = await this.#query('github', forge.host, buildGithubRepositoryQuery(), [
        ...this.#ownerName(forge),
      ]);
      const repo = asRecord(asRecord(raw.json?.data)?.repository);
      this.#checkSingle(raw, repo, what, false);
      const info = normaliseGithubRepository(repo, forge);
      if (!info) throw new ForgeFetchError(`${what} returned no usable data.`);
      return info;
    }
    return this.#gitlabSingle(
      forge,
      (v) => buildGitlabRepositoryQuery(v),
      [['fullPath', forge.repository]],
      (data) => asRecord(data?.project),
      (node) => normaliseGitlabRepository(node, forge),
      what,
    );
  }

  /** One request in detail (Request tab: summary, checks, commits, files). Null: not found. */
  async fetchDetail(forge: ForgeTarget, number: number): Promise<ChangeRequestDetail | null> {
    const what = `${forge.kind === 'github' ? 'Pull request #' : 'Merge request !'}${number}`;
    if (forge.kind === 'github') {
      const run = async (variant: GithubQueryVariant): Promise<ChangeRequestDetail | null> => {
        const raw = await this.#query(
          'github',
          forge.host,
          buildGithubDetailQuery(number, variant),
          this.#ownerName(forge),
        );
        const errors = graphqlErrors(raw.json);
        if (variant === 'full' && isUnknownFieldError(errors)) {
          this.#rememberBasic('github', forge.host, 'detail');
          return run('basic');
        }
        const pr = asRecord(asRecord(asRecord(raw.json?.data)?.repository)?.pullRequest);
        if (this.#checkSingle(raw, pr, what, true)) return null;
        return normaliseGithubDetail(pr);
      };
      return run(this.#variant('github', forge.host, 'detail'));
    }
    return this.#gitlabSingle(
      forge,
      (v) => buildGitlabDetailQuery(v),
      [
        ['fullPath', forge.repository],
        ['iid', String(number)],
      ],
      (data) => asRecord(asRecord(data?.project)?.mergeRequest),
      (node) => normaliseGitlabDetail(node, forge.host),
      what,
      true,
    );
  }

  /** The request's comments, reviews and review threads (first page). Null: not found. */
  async fetchConversation(
    forge: ForgeTarget,
    number: number,
  ): Promise<ChangeRequestConversation | null> {
    const what = `${forge.kind === 'github' ? 'Pull request #' : 'Merge request !'}${number}`;
    if (forge.kind === 'github') {
      const raw = await this.#query(
        'github',
        forge.host,
        buildGithubConversationQuery(number),
        this.#ownerName(forge),
      );
      const pr = asRecord(asRecord(asRecord(raw.json?.data)?.repository)?.pullRequest);
      if (this.#checkSingle(raw, pr, what, true)) return null;
      return normaliseGithubConversation(pr);
    }
    return this.#gitlabSingle(
      forge,
      (v) => buildGitlabConversationQuery(v),
      [
        ['fullPath', forge.repository],
        ['iid', String(number)],
      ],
      (data) => asRecord(asRecord(data?.project)?.mergeRequest),
      (node) => normaliseGitlabConversation(node, forge.host),
      what,
      true,
    );
  }

  #what(forge: Pick<ProjectForge, 'kind' | 'repository'>): string {
    return `${forge.kind === 'github' ? 'GitHub repository' : 'GitLab project'} ${forge.repository}`;
  }

  #ownerName(forge: Pick<ProjectForge, 'repository'>): Array<[string, string]> {
    const [owner = '', name = ''] = forge.repository.split('/');
    return [
      ['owner', owner],
      ['name', name],
    ];
  }

  /**
   * Validates a single-object response. Returns true when the object is missing and `nullable`
   * (a request that no longer exists); throws `ForgeFetchError` for every other failure.
   */
  #checkSingle(
    raw: { json: Record<string, unknown> | null; stderr: string; exitCode: number },
    node: Record<string, unknown> | null,
    what: string,
    nullable: boolean,
  ): boolean {
    if (raw.json === null) {
      throw new ForgeFetchError(shortMessage(raw.stderr || `exit code ${raw.exitCode}`));
    }
    const errors = graphqlErrors(raw.json);
    if (node !== null) return false;
    const notFound =
      asRecord(raw.json.data) !== null &&
      (errors.length === 0 ||
        (Array.isArray(raw.json.errors) &&
          raw.json.errors.some((e) => asRecord(e)?.type === 'NOT_FOUND')));
    if (notFound && nullable) return true;
    if (notFound) {
      throw new ForgeFetchError(`${what} was not found, or the signed-in account cannot see it.`, {
        notFound: true,
      });
    }
    throw new ForgeFetchError(errors[0] ?? `${what}: no data`);
  }

  async #gitlabSingle<T>(
    forge: ForgeTarget,
    build: (variant: GitlabQueryVariant) => string,
    fields: Array<[string, string]>,
    pick: (data: Record<string, unknown> | null) => Record<string, unknown> | null,
    normalise: (node: Record<string, unknown>) => T | null,
    what: string,
    nullable = false,
  ): Promise<T> {
    const query = /^query (\w+)/.exec(build('full'))?.[1] ?? 'single';
    const run = async (variant: GitlabQueryVariant): Promise<T> => {
      const raw = await this.#query('gitlab', forge.host, build(variant), fields);
      const errors = graphqlErrors(raw.json);
      if (variant === 'full' && isUnknownFieldError(errors)) {
        this.#rememberBasic('gitlab', forge.host, query);
        return run('basic');
      }
      const node = pick(asRecord(raw.json?.data));
      if (this.#checkSingle(raw, node, what, nullable)) return null as T;
      const result = node === null ? null : normalise(node);
      if (result === null) throw new ForgeFetchError(`${what} returned no usable data.`);
      return result;
    };
    return run(this.#variant('gitlab', forge.host, query));
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
        resetAt: asString(rate?.resetAt),
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
      this.#rememberBasic('github', forge.host, 'batch');
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
      this.#rememberBasic('gitlab', forge.host, 'batch');
      return this.#gitlabBatch(forge, branches, 'basic');
    }
    this.#check(parsed, raw, `GitLab project ${forge.repository}`);
    return parsed;
  }
}
