/**
 * Worktree source chip (COORDINATION §3.1.8): inferred from the path only, presentation only, no
 * agent integration. Tells "where this worktree came from" at a glance.
 */
export type WorktreeSource = 't3' | 'claude' | 'codex' | 'conductor' | 'cursor';

export interface SourceMeta {
  id: WorktreeSource;
  label: string;
  title: string;
}

const SOURCES: { test: RegExp; meta: SourceMeta }[] = [
  {
    test: /[\\/]\.t3[\\/]worktrees[\\/]/i,
    meta: { id: 't3', label: 't3', title: 'T3 Code worktree (~/.t3/worktrees)' },
  },
  {
    test: /[\\/]\.claude[\\/]worktrees[\\/]/i,
    meta: { id: 'claude', label: 'claude', title: 'Claude Code worktree (.claude/worktrees)' },
  },
  {
    test: /[\\/]\.codex[\\/]/i,
    meta: { id: 'codex', label: 'codex', title: 'Codex worktree (.codex)' },
  },
  {
    test: /[\\/]conductor[\\/]/i,
    meta: { id: 'conductor', label: 'conductor', title: 'Conductor workspace' },
  },
  {
    test: /[\\/]\.cursor[\\/]worktrees[\\/]/i,
    meta: { id: 'cursor', label: 'cursor', title: 'Cursor worktree (.cursor/worktrees)' },
  },
];

export function worktreeSource(path: string): SourceMeta | null {
  for (const s of SOURCES) if (s.test.test(path)) return s.meta;
  return null;
}

/** Middle ellipsis: keep the start and the end of a path. */
export function middleEllipsis(text: string, max: number): string {
  if (text.length <= max || max < 5) return text;
  const tail = Math.floor((max - 1) / 2);
  const head = max - 1 - tail;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}
