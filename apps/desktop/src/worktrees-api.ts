/**
 * The bridge's view of the worktrees (#20): `GET /api/projects` through the contracts' client,
 * with the token from the ready line. The path check (`path-guard.ts`) resolves a renderer's
 * `worktreeId` only against this list, never against a path the renderer sent.
 */
import { createApiClient } from '@octopus-diff/contracts';
import type { WorktreeRecord } from './path-guard.js';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Every worktree the daemon lists, or null when it cannot be asked (no answer, a bad answer). */
export async function listWorktrees(
  url: string,
  token: string,
  fetchImpl: FetchLike = globalThis.fetch,
  timeoutMs = 5_000,
): Promise<WorktreeRecord[] | null> {
  const client = createApiClient({
    baseUrl: url,
    token,
    fetch: (input, init) => fetchImpl(input, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
  });
  try {
    const { projects } = await client.listProjects();
    return projects.flatMap((p) =>
      p.worktrees.map(({ worktree: w }) => ({
        id: w.id,
        path: w.path,
        missing: w.missing,
        bare: w.bare,
      })),
    );
  } catch {
    return null;
  }
}
