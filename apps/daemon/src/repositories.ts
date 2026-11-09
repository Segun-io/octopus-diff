import type {
  GitCore,
  GitRepositoryInfo,
  Logger,
  ProjectListItem,
  RepositoriesResponse,
  ServerEvent,
} from '@octopus-diff/contracts';

/**
 * Local repository facts for the Overviews (`GET /api/repositories`, docs/FORGES.md "Repository
 * information"): git only, no forge. Cached 30 s per project and dropped when the watcher reports
 * a change in that project; at most 4 projects are read at once.
 */

export const REPOSITORY_INFO_TTL_MS = 30_000;
const CONCURRENCY = 4;

export interface RepositoryInfoServiceOptions {
  core: { listProjects(): Promise<ProjectListItem[]> };
  gitCore: Pick<GitCore, 'readRepositoryInfo'>;
  hub: { on(listener: (event: ServerEvent) => void): () => void };
  logger: Logger;
  ttlMs?: number;
  now?: () => Date;
}

interface Entry {
  at: number;
  /** The default branch the facts were read for. */
  defaultBranch: string | null;
  promise: Promise<GitRepositoryInfo>;
}

export class RepositoryInfoService {
  readonly #o: RepositoryInfoServiceOptions;
  readonly #cache = new Map<string, Entry>();
  readonly #unsubscribe: () => void;

  constructor(options: RepositoryInfoServiceOptions) {
    this.#o = options;
    this.#unsubscribe = options.hub.on((event) => {
      if ('projectId' in event && typeof event.projectId === 'string') {
        this.#cache.delete(event.projectId);
      }
    });
  }

  close(): void {
    this.#unsubscribe();
    this.#cache.clear();
  }

  #now(): number {
    return (this.#o.now?.() ?? new Date()).getTime();
  }

  async list(projectIds: readonly string[]): Promise<RepositoriesResponse> {
    const items = await this.#o.core.listProjects();
    const byId = new Map(items.map((i) => [i.project.id, i]));
    const read = this.#o.gitCore.readRepositoryInfo?.bind(this.#o.gitCore);
    const results: RepositoriesResponse['repositories'] = projectIds.map((projectId) => ({
      projectId,
      info: null,
      error: null,
    }));
    const queue = results.map((r, index) => ({ r, index }));
    const ttl = this.#o.ttlMs ?? REPOSITORY_INFO_TTL_MS;
    const worker = async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        const { r } = job;
        const item = byId.get(r.projectId);
        if (!item) {
          r.error = 'unknown project';
          continue;
        }
        if (!read) {
          r.error = 'this git-core cannot read repository information';
          continue;
        }
        const defaultBranch = item.project.defaultBranch;
        let entry = this.#cache.get(r.projectId);
        if (!entry || this.#now() - entry.at >= ttl || entry.defaultBranch !== defaultBranch) {
          entry = {
            at: this.#now(),
            defaultBranch,
            promise: read(
              { id: item.project.id, commonDir: item.project.commonDir },
              { defaultBranch },
            ),
          };
          this.#cache.set(r.projectId, entry);
        }
        try {
          r.info = await entry.promise;
        } catch (error) {
          if (this.#cache.get(r.projectId) === entry) this.#cache.delete(r.projectId);
          r.error = error instanceof Error ? error.message : String(error);
          this.#o.logger.debug('repository info failed', { projectId: r.projectId, error });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
    return { repositories: results, generatedAt: new Date(this.#now()).toISOString() };
  }
}
