import type { CheckStatus, ForgeActor } from '@octopus-diff/contracts';
import { lazy, type ReactNode, Suspense, useState } from 'react';
import { hostAllowed } from '../../lib/markdown.ts';
import { CHECK_TONE, initials } from '../../lib/request.ts';
import type { MarkdownProps } from './Markdown.tsx';

/**
 * Building blocks of the Request tab, after T3 Code's pull request panel (MIT; anatomy copied,
 * colours, icons and avatars adapted to the identity): `MetaRow`, a collapsible `Section` with a
 * sticky heading, avatars as initials unless the image host is allowed, status dots.
 */

const LazyMarkdown = lazy(() => import('./Markdown.tsx').then((m) => ({ default: m.Markdown })));

/** Markdown, loaded on first use (react-markdown is its own chunk). */
export function MarkdownBlock(props: MarkdownProps) {
  return (
    <Suspense
      fallback={
        <p className="text-xs whitespace-pre-wrap text-muted">{props.text.slice(0, 400)}</p>
      }
    >
      <LazyMarkdown {...props} />
    </Suspense>
  );
}

export function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-h-6 min-w-0 grid-cols-[6rem_minmax(0,1fr)] items-start gap-2 py-0.5 text-xs">
      <span className="pt-0.5 text-muted">{label}</span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      aria-hidden="true"
      className={`shrink-0 text-faint transition-transform ${open ? 'rotate-90' : ''}`}
    >
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}

/** A collapsible section with a sticky heading (T3's `Section`). */
export function Section({
  title,
  defaultOpen = true,
  actions,
  count,
  children,
  onOpenChange,
}: {
  title: string;
  defaultOpen?: boolean;
  actions?: ReactNode;
  count?: ReactNode;
  children: ReactNode;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section aria-label={title} className="border-t border-line">
      <div className="sticky top-0 z-10 flex items-center bg-canvas pr-4">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
            onOpenChange?.(!open);
          }}
          className="flex min-w-0 flex-1 items-center gap-1.5 px-4 py-2.5 text-left text-xs font-medium text-muted hover:text-fg"
        >
          <Chevron open={open} />
          <span>{title}</span>
          {count !== undefined && <span className="font-normal text-faint">{count}</span>}
        </button>
        {actions}
      </div>
      {open && <div className="px-4 pb-4">{children}</div>}
    </section>
  );
}

export function StatusDot({ status }: { status: CheckStatus | null }) {
  if (!status) return null;
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${CHECK_TONE[status]}`}
    />
  );
}

/** Initials, or the avatar when its host is one the CSP allows (and it loads). */
export function Avatar({
  actor,
  imageHosts,
  size = 16,
}: {
  actor: ForgeActor | null;
  imageHosts: readonly string[];
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  let src: string | null = null;
  if (actor?.avatarUrl && !failed) {
    try {
      const url = new URL(actor.avatarUrl);
      if (url.protocol === 'https:' && hostAllowed(url.host, imageHosts)) src = url.href;
    } catch {
      src = null;
    }
  }
  const style = { width: size, height: size };
  if (src) {
    return (
      <img
        src={src}
        alt=""
        referrerPolicy="no-referrer"
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        style={style}
        className="inline-block shrink-0 rounded-full border border-line"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      style={{ ...style, fontSize: Math.max(8, Math.round(size * 0.45)) }}
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-raised font-medium text-muted"
    >
      {initials(actor)}
    </span>
  );
}

export function ActorName({ actor }: { actor: ForgeActor | null }) {
  if (!actor) return <span className="text-muted">deleted account</span>;
  return (
    <span className="font-medium" title={actor.name ?? undefined}>
      {actor.login}
      {actor.bot && !actor.login.endsWith('[bot]') && (
        <span className="ml-1 font-normal text-faint">bot</span>
      )}
    </span>
  );
}

export function ExternalLink({
  href,
  children,
  className = '',
}: {
  href: string | null | undefined;
  children: ReactNode;
  className?: string;
}) {
  if (!href?.startsWith('https://')) return <span className={className}>{children}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`hover:underline ${className}`}
    >
      {children}
    </a>
  );
}

export function Banner({ children }: { children: ReactNode }) {
  return (
    <p className="my-2 rounded-md border border-line bg-surface px-3 py-1.5 text-[11px] text-muted">
      {children}
    </p>
  );
}

/** Inline file-diff glyph (T3's `FileDiffIcon`, drawn in the house style). */
export function FileDiffGlyph() {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      aria-hidden="true"
      className="shrink-0 self-center"
    >
      <path d="M9.5 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5z" />
      <path d="M9.5 1.5V5H13M8 7v4M6 9h4M6 12.5h4" />
    </svg>
  );
}
