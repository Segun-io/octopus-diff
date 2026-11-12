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

/**
 * Stroke icons on a 16-unit grid: one weight (1.5), `currentColor`, never a font glyph (glyphs such
 * as ☾ ✕ ⋯ ⚠ render as emoji or in another weight depending on the platform).
 */
function Svg({
  children,
  size = 14,
  className = '',
}: {
  children: ReactNode;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

type IconProps = { size?: number; className?: string };

export function CloseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Svg>
  );
}

export function CopyIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 3.5v-.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h.5" />
    </Svg>
  );
}

export function MoreIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="3.5" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="8" r="1.1" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function SunIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5V3M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.06 1.06M11.54 11.54l1.06 1.06M3.4 12.6l1.06-1.06M11.54 4.46l1.06-1.06" />
    </Svg>
  );
}

export function MoonIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13.5 9.6A5.6 5.6 0 0 1 6.4 2.5a5.6 5.6 0 1 0 7.1 7.1z" />
    </Svg>
  );
}

export function WarningIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 2.5L14 13H2z" />
      <path d="M8 6.5v3M8 11.5h.01" />
    </Svg>
  );
}

export function ToggleButton({
  pressed,
  onClick,
  children,
  title,
  testId,
  extra,
  variant = 'button',
}: {
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
  title: string;
  testId: string;
  extra?: Record<string, string>;
  /** `chip`: the small filter chip of the sidebar (`.od-chip`, filled softly while pressed). */
  variant?: 'button' | 'chip';
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      title={title}
      data-testid={testId}
      onClick={onClick}
      className={variant === 'chip' ? 'od-chip' : 'od-btn'}
      {...extra}
    >
      {children}
    </button>
  );
}

/** Unified diff layout: one column of rows. */
export function RowsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
      <path d="M2.5 6.5h11M2.5 9.5h11" />
    </Svg>
  );
}

/** Split diff layout: two columns. */
export function ColumnsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
      <path d="M8 3v10" />
    </Svg>
  );
}

/** Whitespace: a pilcrow. */
export function PilcrowIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13 2.5H7a3 3 0 0 0 0 6h2.5M9.5 2.5v11M12.5 2.5v11" />
    </Svg>
  );
}

/** Visibility (the "show reviewed files" toggle). */
export function EyeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M1.5 8c1.8-3 4-4.5 6.5-4.5S12.7 5 14.5 8c-1.8 3-4 4.5-6.5 4.5S3.3 11 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </Svg>
  );
}

/** The files as a directory tree. */
export function TreeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2" y="2.5" width="4.5" height="3" rx="0.75" />
      <rect x="9.5" y="6.5" width="4.5" height="3" rx="0.75" />
      <rect x="9.5" y="11" width="4.5" height="3" rx="0.75" />
      <path d="M4.25 5.5v7h5.25M4.25 8h5.25" />
    </Svg>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd>{children}</kbd>;
}

export function FolderIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2 4.5a1 1 0 0 1 1-1h3.2l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
    </Svg>
  );
}

/** A repository: a commit graph with a branch. */
export function RepoIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="5" cy="3.5" r="1.5" />
      <circle cx="5" cy="12.5" r="1.5" />
      <circle cx="11" cy="6" r="1.5" />
      <path d="M5 5v6M11 7.5c0 2.5-6 1.5-6 3.5" />
    </Svg>
  );
}

export function ChevronLeftIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10 3.5 5.5 8l4.5 4.5" />
    </Svg>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 3.5 10.5 8 6 12.5" />
    </Svg>
  );
}

/** Up one folder (the `..` row). */
export function CornerLeftUpIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.5 6.5 6.5 3.5l3 3M13 13H9a2.5 2.5 0 0 1-2.5-2.5v-7" />
    </Svg>
  );
}

export function FolderPlusIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2 4.5a1 1 0 0 1 1-1h3.2l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1zM8 7.25v3.5M6.25 9h3.5" />
    </Svg>
  );
}

/** A quarter-open ring that turns while something loads (still under reduced motion). */
export function SpinnerIcon({ size, className = '' }: IconProps) {
  return (
    <Svg size={size} className={`animate-spin ${className}`}>
      <path d="M8 2a6 6 0 1 1-6 6" />
    </Svg>
  );
}
