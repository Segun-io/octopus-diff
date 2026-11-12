import {
  type BranchBase,
  GitCoreError,
  type ProjectLocator,
  RefNameSchema,
  type ScopeOptions,
} from '@octopus-diff/contracts';
import type { GitContext } from './context.js';
import { projectRepoFor, resolveRefName } from './discovery.js';
import { resolveRefFromFiles } from './ref-files.js';
import { parseDefaultBranch } from './scope.js';

/**
 * `GitCore.readBranchBase`: which commit a branch scope diffs against, as a cache identity.
 * Loose refs and `packed-refs` are plain files, so this normally spawns nothing: a repeat call
 * costs a few small reads. It uses the same lookup as the scope itself (`resolveRefName`: the
 * ref files first, then `for-each-ref` when they cannot tell), so the answer never disagrees
 * with `planScope`. See `ref-files.ts`.
 */
export async function readBranchBase(
  ctx: GitContext,
  project: ProjectLocator,
  options: (ScopeOptions & { base?: string }) | undefined,
): Promise<BranchBase | null> {
  const name = options?.base ?? parseDefaultBranch(options);
  if (name === null) return null;
  if (!RefNameSchema.safeParse(name).success) {
    throw new GitCoreError('invalid_argument', `invalid ref name: ${name}`);
  }
  const fromFiles = await resolveRefFromFiles(project.commonDir, name);
  if (fromFiles !== undefined) return fromFiles;
  await ctx.ensureSupported();
  const repo = await projectRepoFor(ctx, project);
  const resolved = await resolveRefName(ctx, repo, name);
  return resolved ? { name: resolved.name, ref: resolved.ref, oid: resolved.oid } : null;
}
