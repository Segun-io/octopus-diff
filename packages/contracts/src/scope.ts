import { z } from 'zod';
import { CommitShaSchema, RefNameSchema } from './common.js';

export const SCOPE_KINDS = ['working', 'staged', 'unstaged', 'branch', 'commit', 'review'] as const;
export const ScopeKindSchema = z.enum(SCOPE_KINDS);
export type ScopeKind = z.infer<typeof ScopeKindSchema>;

/**
 * Which diff to show for a worktree.
 * - working:  working tree + index vs HEAD (default; untracked files appear as additions)
 * - staged:   index vs HEAD
 * - unstaged: working tree vs index
 * - branch:   HEAD vs merge-base(HEAD, base). `base` defaults to the project's default branch.
 * - commit:   a single commit (`<sha>^..<sha>`; root commits diff against the empty tree)
 * - review:   "To review" (docs/STATUS-FLOW.md §2.3): the working tree (index and untracked files
 *             included) vs the commit `base`, i.e. the commits after the branch's review bookmark
 *             plus the uncommitted changes, one patch per file. The web sends it without `base`;
 *             the daemon fills in the worktree's bookmark. git-core without `base` uses HEAD
 *             (then it equals `working`).
 * `branch` with `includeWorking` ("All on branch") diffs the working tree (index and untracked
 * files included) against the merge-base instead of HEAD.
 */
export const DiffScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('working') }),
  z.object({ kind: z.literal('staged') }),
  z.object({ kind: z.literal('unstaged') }),
  z.object({
    kind: z.literal('branch'),
    base: RefNameSchema.optional(),
    includeWorking: z.boolean().optional(),
  }),
  z.object({ kind: z.literal('commit'), sha: CommitShaSchema }),
  z.object({ kind: z.literal('review'), base: CommitShaSchema.optional() }),
]);
export type DiffScope = z.infer<typeof DiffScopeSchema>;

export const DEFAULT_SCOPE: DiffScope = { kind: 'working' };

/** Stable string key for a scope, suitable for cache keys and React Query keys. */
export function scopeKey(scope: DiffScope): string {
  switch (scope.kind) {
    case 'branch': {
      // `~` cannot appear in a ref name, so `:~w` never collides with a base.
      const key = scope.base ? `branch:${scope.base}` : 'branch';
      return scope.includeWorking ? `${key}:~w` : key;
    }
    case 'commit':
      return `commit:${scope.sha.toLowerCase()}`;
    case 'review':
      return scope.base ? `review:${scope.base.toLowerCase()}` : 'review';
    default:
      return scope.kind;
  }
}

/**
 * Query-string fields that encode a scope: `scope=<kind>[&base=<ref>][&sha=<sha>][&working=1]`.
 * For `scope=review`, `base` must be a full commit id.
 */
export const scopeQueryShape = {
  scope: ScopeKindSchema.default('working'),
  base: RefNameSchema.optional(),
  sha: CommitShaSchema.optional(),
  /** `branch` only: include the working tree ("All on branch"). */
  working: z.enum(['0', '1']).optional(),
};

export interface ScopeQueryFields {
  scope: ScopeKind;
  base?: string | undefined;
  sha?: string | undefined;
  working?: '0' | '1' | undefined;
}

/** Builds a DiffScope from parsed query fields. Throws if `scope=commit` lacks `sha`. */
export function scopeFromQueryFields(fields: ScopeQueryFields): DiffScope {
  switch (fields.scope) {
    case 'branch': {
      const scope: DiffScope = fields.base
        ? { kind: 'branch', base: fields.base }
        : { kind: 'branch' };
      return fields.working === '1' ? { ...scope, includeWorking: true } : scope;
    }
    case 'commit':
      if (!fields.sha) throw new Error('sha is required when scope=commit');
      return { kind: 'commit', sha: fields.sha };
    case 'review':
      if (fields.base !== undefined && !CommitShaSchema.safeParse(fields.base).success) {
        throw new Error('base must be a commit id when scope=review');
      }
      return fields.base ? { kind: 'review', base: fields.base } : { kind: 'review' };
    default:
      return { kind: fields.scope };
  }
}

/** Zod refinement shared by every query schema that embeds a scope. */
export function refineScopeQuery(fields: ScopeQueryFields, ctx: z.RefinementCtx): void {
  if (fields.scope === 'commit' && !fields.sha) {
    ctx.addIssue({ code: 'custom', message: 'sha is required when scope=commit', path: ['sha'] });
  }
  if (
    fields.scope === 'review' &&
    fields.base !== undefined &&
    !CommitShaSchema.safeParse(fields.base).success
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'base must be a commit id when scope=review',
      path: ['base'],
    });
  }
}

/** Writes a scope into URLSearchParams (inverse of the query schemas). */
export function appendScopeParams(params: URLSearchParams, scope: DiffScope): URLSearchParams {
  params.set('scope', scope.kind);
  if ((scope.kind === 'branch' || scope.kind === 'review') && scope.base) {
    params.set('base', scope.base);
  }
  if (scope.kind === 'branch' && scope.includeWorking) params.set('working', '1');
  if (scope.kind === 'commit') params.set('sha', scope.sha);
  return params;
}
