import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type ApiClient,
  createApiClient,
  type DaemonHandle,
  type ProjectListItem,
  type StartDaemonOptions,
  type WatchOptions,
} from '@octopus-diff/contracts';
import { startDaemon } from '@octopus-diff/daemon';
import { type FixtureManifest, registeredProjects } from '@octopus-diff/fixtures';
import { E2ePreflightError, ENV, WEB_DIST } from './env.js';

export interface TestDaemonOptions {
  manifest: FixtureManifest;
  /** `all` registers every fixture project (paths + scan roots) at startup; `none` starts empty. */
  register?: 'all' | 'none';
  webRoot?: string | null;
  watch?: WatchOptions;
}

/** Wraps `startDaemon` from `@octopus-diff/daemon` with temp state dirs and restart support. */
export class TestDaemon {
  readonly manifest: FixtureManifest;
  readonly stateDir: string;
  readonly configDir: string;
  readonly token: string;
  #handle: DaemonHandle;
  #client: ApiClient;
  #options: StartDaemonOptions;

  private constructor(
    manifest: FixtureManifest,
    handle: DaemonHandle,
    options: StartDaemonOptions & { stateDir: string; configDir: string; token: string },
  ) {
    this.manifest = manifest;
    this.#handle = handle;
    this.#options = options;
    this.stateDir = options.stateDir;
    this.configDir = options.configDir;
    this.token = options.token;
    this.#client = TestDaemon.clientFor(handle);
  }

  static clientFor(handle: DaemonHandle): ApiClient {
    return createApiClient({ baseUrl: handle.url, token: handle.token });
  }

  static async start(options: TestDaemonOptions): Promise<TestDaemon> {
    const { manifest } = options;
    const base = await mkdtemp(join(manifest.root, 'daemon-'));
    const register = options.register ?? 'all';
    const startOptions = {
      host: '127.0.0.1',
      port: 0,
      token: randomBytes(24).toString('hex'),
      stateDir: join(base, 'state'),
      configDir: join(base, 'config'),
      webRoot: options.webRoot === undefined ? WEB_DIST : options.webRoot,
      projects:
        register === 'all'
          ? registeredProjects(manifest).flatMap((p) =>
              p.registration?.kind === 'path' ? [p.registration.path] : [],
            )
          : [],
      scanRoots:
        register === 'all' ? manifest.scanRoots.map((s) => ({ path: s.path, depth: s.depth })) : [],
      git: { env: { ...manifest.git.vars } },
      ...(options.watch ? { watch: options.watch } : {}),
      version: 'e2e',
      logLevel: (process.env[ENV.daemonLog] as StartDaemonOptions['logLevel']) ?? 'warn',
    } satisfies StartDaemonOptions;
    const handle = await startDaemonOrExplain(startOptions);
    return new TestDaemon(manifest, handle, startOptions);
  }

  get handle(): DaemonHandle {
    return this.#handle;
  }
  get client(): ApiClient {
    return this.#client;
  }
  get url(): string {
    return this.#handle.url;
  }
  get authUrl(): string {
    return this.#handle.authUrl;
  }
  get port(): number {
    return this.#handle.port;
  }

  /**
   * Stops and starts the daemon on the same state dir (and, if possible, the same port).
   * Startup registration is dropped, so anything still registered afterwards came from the store.
   */
  async restart(): Promise<void> {
    const port = this.#handle.port;
    await this.#handle.close();
    const options = { ...this.#options, projects: [], scanRoots: [] };
    try {
      this.#handle = await startDaemonOrExplain({ ...options, port });
    } catch {
      this.#handle = await startDaemonOrExplain({ ...options, port: 0 });
    }
    this.#client = TestDaemon.clientFor(this.#handle);
  }

  async close(): Promise<void> {
    await this.#handle.close();
  }

  /** Waits until every expected project is listed and every checkout has a summary. */
  async waitForProjects(
    names: readonly string[] = registeredProjects(this.manifest).map((p) => p.name),
    timeoutMs = 30_000,
  ): Promise<ProjectListItem[]> {
    const deadline = Date.now() + timeoutMs;
    let last: ProjectListItem[] = [];
    let lastError: unknown = null;
    while (Date.now() < deadline) {
      try {
        last = (await this.#client.listProjects()).projects;
        const listed = new Set(last.map((p) => p.project.name));
        const settled = last.every((p) =>
          p.worktrees.every((w) => w.worktree.bare || w.summary !== null || w.error !== null),
        );
        if (names.every((n) => listed.has(n)) && settled) return last;
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const listed = last.map((p) => p.project.name);
    throw new Error(
      `daemon did not list the expected projects within ${timeoutMs} ms.\n` +
        `  expected: ${names.join(', ')}\n  listed:   ${listed.join(', ') || '(none)'}` +
        (lastError ? `\n  last error: ${String(lastError)}` : ''),
    );
  }
}

async function startDaemonOrExplain(options: StartDaemonOptions): Promise<DaemonHandle> {
  try {
    return await startDaemon(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/placeholder/i.test(message)) {
      throw new E2ePreflightError(
        '@octopus-diff/daemon is still the Phase 0 placeholder (startDaemon threw ' +
          `"${message}").\n  The e2e suite needs the WS2 daemon (and WS1 git-core, WS3 web). ` +
          'Merge the streams, run `pnpm build`, then `pnpm test:e2e`.',
      );
    }
    throw error;
  }
}
