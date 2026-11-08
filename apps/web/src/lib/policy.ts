/**
 * Review policy helpers for the UI (COORDINATION §2.1). Absent `review` (older daemons) means
 * enabled by default.
 */
import type {
  EffectiveReviewPolicy,
  Project,
  ReviewPolicySource,
  ReviewPolicyTarget,
  ScanRoot,
  Worktree,
} from '@octopus-diff/contracts';

export const DEFAULT_POLICY: EffectiveReviewPolicy = { enabled: true, source: 'default' };

export function effectivePolicy(
  review: EffectiveReviewPolicy | undefined | null,
): EffectiveReviewPolicy {
  return review ?? DEFAULT_POLICY;
}

export const SOURCE_LABELS: Record<ReviewPolicySource, string> = {
  worktree: 'this worktree',
  branch: 'this branch',
  project: 'this project',
  folder: 'this folder',
  default: 'the default',
};

/** `Review on (default)`, `Review off (branch)` */
export function policyLabel(policy: EffectiveReviewPolicy): string {
  return `Review ${policy.enabled ? 'on' : 'off'} · from ${SOURCE_LABELS[policy.source]}`;
}

export interface TargetContext {
  projects: readonly Pick<Project, 'id' | 'name'>[];
  worktrees: readonly Pick<Worktree, 'id' | 'projectId' | 'branch' | 'path'>[];
  scanRoots: readonly Pick<ScanRoot, 'id' | 'path'>[];
}

export interface TargetDescription {
  kind: ReviewPolicyTarget['kind'];
  /** e.g. `octopus-api`, `octopus-api · feat/auth`, `~/code` */
  label: string;
  detail: string;
  /** False when the target no longer exists (stale override). */
  exists: boolean;
}

function shortenHome(path: string): string {
  return path.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, '~');
}

export function describeTarget(target: ReviewPolicyTarget, ctx: TargetContext): TargetDescription {
  switch (target.kind) {
    case 'folder': {
      const root = ctx.scanRoots.find((s) => s.id === target.scanRootId);
      return {
        kind: 'folder',
        label: root ? shortenHome(root.path) : target.scanRootId,
        detail: 'folder',
        exists: root !== undefined,
      };
    }
    case 'project': {
      const project = ctx.projects.find((p) => p.id === target.projectId);
      return {
        kind: 'project',
        label: project?.name ?? target.projectId,
        detail: 'project',
        exists: project !== undefined,
      };
    }
    case 'branch': {
      const project = ctx.projects.find((p) => p.id === target.projectId);
      return {
        kind: 'branch',
        label: `${project?.name ?? target.projectId} · ${target.branch}`,
        detail: 'branch',
        exists: project !== undefined,
      };
    }
    case 'worktree': {
      const wt = ctx.worktrees.find((w) => w.id === target.worktreeId);
      const project = wt ? ctx.projects.find((p) => p.id === wt.projectId) : undefined;
      return {
        kind: 'worktree',
        label: wt
          ? `${project?.name ?? '?'} · ${wt.branch ?? 'detached'} (${shortenHome(wt.path)})`
          : target.worktreeId,
        detail: 'worktree',
        exists: wt !== undefined,
      };
    }
  }
}

export { shortenHome };
