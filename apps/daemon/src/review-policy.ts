import type {
  EffectiveReviewPolicy,
  ResolveReviewPolicyInput,
  ReviewPolicyTarget,
  Worktree,
} from '@octopus-diff/contracts';
import { notFound } from './errors.js';

/**
 * What the core needs from the settings layer (UX round 1): the effective review policy of a
 * worktree, and cleanup hooks when a project or scan root is removed. `SettingsService`
 * implements it; the core works without one (then no `review` is attached, as older daemons).
 */
export interface ReviewPolicyProvider {
  resolve(
    input: Omit<ResolveReviewPolicyInput, 'overrides' | 'defaultEnabled'>,
  ): EffectiveReviewPolicy;
  onProjectRemoved(projectId: string): void;
  onScanRootRemoved(scanRootId: string): void;
}

/** Builds the resolver input for a worktree. Detached worktrees skip the branch level. */
export function policyInputFor(
  project: { id: string; scanRootId: string | null },
  worktree: Pick<Worktree, 'id' | 'branch' | 'detached'>,
): Omit<ResolveReviewPolicyInput, 'overrides' | 'defaultEnabled'> {
  return {
    worktreeId: worktree.id,
    projectId: project.id,
    branch: worktree.detached ? null : worktree.branch,
    scanRootId: project.scanRootId,
  };
}

/** The registry lookups needed to validate a policy target. */
export interface TargetRegistry {
  hasProject(projectId: string): boolean;
  hasScanRoot(scanRootId: string): boolean;
  /** Owning project of a known worktree, or null. */
  projectOfWorktree(worktreeId: string): string | null;
}

/**
 * COORDINATION §2.1: the target must exist (`not_found` otherwise); a `branch` target needs an
 * existing project but not an existing branch. Returns the owning project for storage.
 */
export function validateReviewPolicyTarget(
  target: ReviewPolicyTarget,
  registry: TargetRegistry,
): { projectId: string | null } {
  switch (target.kind) {
    case 'folder':
      if (!registry.hasScanRoot(target.scanRootId)) throw notFound('scan root');
      return { projectId: null };
    case 'project':
    case 'branch':
      if (!registry.hasProject(target.projectId)) throw notFound('project');
      return { projectId: target.projectId };
    case 'worktree': {
      const projectId = registry.projectOfWorktree(target.worktreeId);
      if (projectId === null) throw notFound('worktree');
      return { projectId };
    }
  }
}
