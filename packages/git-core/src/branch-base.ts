import {
  type BranchBase,
  GitCoreError,
  type ProjectLocator,
  RefNameSchema,
  type ScopeOptions,
} from '@octopus-diff/contracts';
import type { GitContext } from './context.js';
import { projectRepoFor, resolveRefName } from './discovery.js';
import { remoteTrackingOf, remoteTrackingRefOf } from './integration-base.js';
import { readRefOid, resolveRefFromFiles } from './ref-files.js';
import { parseDefaultBranch } from './scope.js';

/**
 * `GitCore.readBranchBase`: which commit a branch scope diffs against, as a cache identity.
 * Loose refs and `packed-refs` are plain files, so this normally spawns nothing: a repeat call
 * costs a few small reads. It uses the same lookup as the scope itself (`resolveRefName`: the
 * ref files first, then `for-each-ref` when they cannot tell), so the answer never disagrees
 * with `planScope`. See `ref-files.ts`.
 *
 * For the default branch (no explicit `base`) it also reports the remote-tracking ref the scope
 * pairs with it (`integration-base.ts`, #30): the file list depends on both commits, so a cache
 * key made of this answer follows a `fetch` as well as a local move.
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
  const explicit = options?.base !== undefined;
  const fromFiles = await resolveRefFromFiles(project.commonDir, name);
  if (fromFiles !== undefined) {
    if (fromFiles === null || explicit) return fromFiles;
    const remoteRef = remoteTrackingRefOf(fromFiles.ref);
    if (remoteRef === null) return fromFiles;
    const oid = await readRefOid(project.commonDir, remoteRef);
    if (oid === null) return fromFiles;
    if (oid !== undefined) {
      return {
        ...fromFiles,
        remote: { name: remoteRef.slice('refs/remotes/'.length), ref: remoteRef, oid },
      };
    }
  }
  await ctx.ensureSupported();
  const repo = await projectRepoFor(ctx, project);
  const resolved = await resolveRefName(ctx, repo, name);
  if (!resolved) return null;
  const base: BranchBase = { name: resolved.name, ref: resolved.ref, oid: resolved.oid };
  const remote = explicit ? null : await remoteTrackingOf(ctx, repo, resolved);
  return remote
    ? { ...base, remote: { name: remote.name, ref: remote.ref, oid: remote.oid } }
    : base;
}
