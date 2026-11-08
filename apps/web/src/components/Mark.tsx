import { useId } from 'react';

/**
 * The octopus-diff mark (docs/design/IDENTITY.md): one colour (`currentColor`), eyes cut out so
 * it works on any background. Geometry is identical to `public/favicon.svg`.
 */
export function Mark({
  size = 16,
  className = '',
  title,
}: {
  size?: number;
  className?: string;
  title?: string;
}) {
  const maskId = useId();
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      className={className}
      aria-hidden={title ? undefined : 'true'}
      role={title ? 'img' : undefined}
      focusable="false"
    >
      {title && <title>{title}</title>}
      <defs>
        <mask id={maskId}>
          <rect width="32" height="32" fill="#fff" />
          <rect x="10.3" y="12" width="4.4" height="1.8" rx="0.9" fill="#000" />
          <rect x="17.3" y="12" width="4.4" height="1.8" rx="0.9" fill="#000" />
        </mask>
      </defs>
      <g
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        mask={`url(#${maskId})`}
      >
        <path
          d="M16 3 C22 3 26 7.5 26 13.5 C26 16.5 24.5 18.5 22.5 19.5 L9.5 19.5 C7.5 18.5 6 16.5 6 13.5 C6 7.5 10 3 16 3 Z"
          stroke="none"
        />
        <path d="M9.5 19.5 C9.5 23 6 24 3 24.5" fill="none" />
        <path d="M13 19.5 C13 24 10 27 8 29" fill="none" />
        <path d="M16 19.5 L16 29" fill="none" />
        <path d="M19 19.5 C19 24 22 27 24 29" fill="none" />
        <path d="M22.5 19.5 C22.5 23 26 24 29 24.5" fill="none" />
      </g>
    </svg>
  );
}

/** The wordmark: mark + `octopus-diff`, lower case, `-diff` in the mono face (it is a CLI). */
export function Wordmark({ size = 16, className = '' }: { size?: number; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <Mark size={size} className="text-accent" />
      <span className="font-semibold tracking-tight text-fg" style={{ fontSize: size * 0.85 }}>
        octopus
        <span className="font-mono font-normal text-muted">-diff</span>
      </span>
    </span>
  );
}
