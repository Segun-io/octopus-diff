import { z } from 'zod';
import { CommitShaSchema, RefNameSchema } from './common.js';

export const SCOPE_KINDS = ['working', 'staged', 'unstaged', 'branch', 'commit'] as const;
export const ScopeKindSchema = z.enum(SCOPE_KINDS);
export type ScopeKind = z.infer<typeof ScopeKindSchema>;

/**
 * Which diff to show for a worktree.
 * - working:  working tree + index vs HEAD (default; untracked files appear as additions)
 * - staged:   index vs HEAD
 * - unstaged: working tree vs index
 * - branch:   HEAD vs merge-base(HEAD, base). `base` defaults to the project's default branch.
 * - commit:   a single commit (`<sha>^..<sha>`; root commits diff against the empty tree)
 */
export const DiffScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('working') }),
  z.object({ kind: z.literal('staged') }),
  z.object({ kind: z.literal('unstaged') }),
  z.object({ kind: z.literal('branch'), base: RefNameSchema.optional() }),
  z.object({ kind: z.literal('commit'), sha: CommitShaSchema }),
]);
export type DiffScope = z.infer<typeof DiffScopeSchema>;

export const DEFAULT_SCOPE: DiffScope = { kind: 'working' };

/** Stable string key for a scope, suitable for cache keys and React Query keys. */
export function scopeKey(scope: DiffScope): string {
  switch (scope.kind) {
    case 'branch':
      return scope.base ? `branch:${scope.base}` : 'branch';
    case 'commit':
      return `commit:${scope.sha.toLowerCase()}`;
    default:
      return scope.kind;
  }
}

/** Query-string fields that encode a scope: `scope=<kind>[&base=<ref>][&sha=<sha>]`. */
export const scopeQueryShape = {
  scope: ScopeKindSchema.default('working'),
  base: RefNameSchema.optional(),
  sha: CommitShaSchema.optional(),
};

export interface ScopeQueryFields {
  scope: ScopeKind;
  base?: string | undefined;
  sha?: string | undefined;
}

/** Builds a DiffScope from parsed query fields. Throws if `scope=commit` lacks `sha`. */
export function scopeFromQueryFields(fields: ScopeQueryFields): DiffScope {
  switch (fields.scope) {
    case 'branch':
      return fields.base ? { kind: 'branch', base: fields.base } : { kind: 'branch' };
    case 'commit':
      if (!fields.sha) throw new Error('sha is required when scope=commit');
      return { kind: 'commit', sha: fields.sha };
    default:
      return { kind: fields.scope };
  }
}

/** Zod refinement shared by every query schema that embeds a scope. */
export function refineScopeQuery(fields: ScopeQueryFields, ctx: z.RefinementCtx): void {
  if (fields.scope === 'commit' && !fields.sha) {
    ctx.addIssue({ code: 'custom', message: 'sha is required when scope=commit', path: ['sha'] });
  }
}

/** Writes a scope into URLSearchParams (inverse of the query schemas). */
export function appendScopeParams(params: URLSearchParams, scope: DiffScope): URLSearchParams {
  params.set('scope', scope.kind);
  if (scope.kind === 'branch' && scope.base) params.set('base', scope.base);
  if (scope.kind === 'commit') params.set('sha', scope.sha);
  return params;
}
