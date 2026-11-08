import type { FileStatus } from '@octopus-diff/contracts';
import type { ReactNode } from 'react';

const STATUS_META: Record<FileStatus, { letter: string; label: string; className: string }> = {
  added: { letter: 'A', label: 'Added', className: 'text-add' },
  untracked: { letter: 'U', label: 'Untracked', className: 'text-add' },
  modified: { letter: 'M', label: 'Modified', className: 'text-mod' },
  deleted: { letter: 'D', label: 'Deleted', className: 'text-del' },
  renamed: { letter: 'R', label: 'Renamed', className: 'text-accent' },
  copied: { letter: 'C', label: 'Copied', className: 'text-accent' },
  typechange: { letter: 'T', label: 'Type changed', className: 'text-mod' },
  conflicted: { letter: '!', label: 'Conflicted', className: 'text-danger' },
};

export function statusLabel(status: FileStatus): string {
  return STATUS_META[status].label;
}

export function StatusIcon({ status }: { status: FileStatus }) {
  const meta = STATUS_META[status];
  return (
    <span
      className={`inline-flex w-4 shrink-0 justify-center font-mono text-[11px] font-semibold ${meta.className}`}
      title={meta.label}
      aria-label={meta.label}
      role="img"
    >
      {meta.letter}
    </span>
  );
}

export function LineCounts({
  additions,
  deletions,
}: {
  additions: number | null;
  deletions: number | null;
}) {
  if (additions === null && deletions === null) return null;
  return (
    <span className="shrink-0 font-mono text-[11px] tabular-nums">
      {additions !== null && additions > 0 && <span className="text-add">+{additions}</span>}
      {additions !== null && additions > 0 && deletions !== null && deletions > 0 && ' '}
      {deletions !== null && deletions > 0 && <span className="text-del">−{deletions}</span>}
    </span>
  );
}

export function CheckIcon({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" className={className}>
      <path
        d="M3 8.5l3 3 7-7"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ToggleButton({
  pressed,
  onClick,
  children,
  title,
  testId,
  extra,
}: {
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
  title: string;
  testId: string;
  extra?: Record<string, string>;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      title={title}
      data-testid={testId}
      onClick={onClick}
      className={`rounded border px-2 py-0.5 text-xs transition-colors ${
        pressed
          ? 'border-accent bg-selected text-fg'
          : 'border-line bg-surface text-muted hover:bg-hover hover:text-fg'
      }`}
      {...extra}
    >
      {children}
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd>{children}</kbd>;
}
