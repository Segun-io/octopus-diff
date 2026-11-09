/**
 * Safety rules for forge markdown (docs/FORGES.md "Safety", DECISIONS #74, #77). Pure functions,
 * so they are tested without React: which URLs may become links, which images may load, and the
 * text clean-up before rendering. Raw HTML is never rendered (react-markdown `skipHtml`, no
 * rehype-raw, no `dangerouslySetInnerHTML`).
 */

/** Drops HTML comments (bot markers) and trims; null when nothing visible remains (T3's `visibleBody`). */
export function visibleBody(body: string): string | null {
  const text = body.replace(/<!--[\s\S]*?-->/g, '').trim();
  return text.length === 0 ? null : text;
}

/**
 * The href a markdown link may have: `https:` and `mailto:` URLs, `#fragment`s, and relative
 * URLs resolved against the forge's https `base`. Everything else (javascript:, data:, http:,
 * protocol-relative to another host, ...) is refused with an empty string, and the link renders
 * as plain text.
 */
export function safeHref(url: string, base: string | null): string {
  const value = url.trim();
  if (value === '') return '';
  if (value.startsWith('#')) return value;
  if (/^mailto:/i.test(value)) return /^mailto:[^\s<>"']+$/i.test(value) ? value : '';
  try {
    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(value);
    if (!hasScheme && (!base || value.startsWith('//'))) return '';
    const resolved = hasScheme ? new URL(value) : new URL(value, `${base?.replace(/\/?$/, '/')}`);
    if (resolved.protocol !== 'https:' || resolved.username || resolved.password) return '';
    return resolved.href;
  } catch {
    return '';
  }
}

/** True when `host` matches one of the patterns (`github.com`, `*.githubusercontent.com`). */
export function hostAllowed(host: string, patterns: readonly string[]): boolean {
  const h = host.toLowerCase();
  return patterns.some((p) =>
    p.startsWith('*.') ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p,
  );
}

/**
 * The src an `<img>` may load: an https URL (relative ones resolved against `base`) whose host
 * is in `imageHosts` (the hosts the CSP allows). Null means: render a plain link instead.
 */
export function safeImageSrc(
  src: string | undefined,
  base: string | null,
  imageHosts: readonly string[],
): string | null {
  if (!src) return null;
  const href = safeHref(src, base);
  if (!href || href.startsWith('#') || href.startsWith('mailto:')) return null;
  try {
    return hostAllowed(new URL(href).host, imageHosts) ? href : null;
  } catch {
    return null;
  }
}

export interface RefLink {
  sigil: '#' | '!';
  /** URL path segment on the forge: `pull`/`issues` (GitHub) or `-/merge_requests`/`-/issues`. */
  path: string;
}

/**
 * `#123` and `!123` references to links on the forge: GitHub `#n` opens `/issues/n` (GitHub
 * redirects to the pull request when it is one); GitLab `!n` is a merge request, `#n` an issue.
 */
export function referenceLinks(kind: 'github' | 'gitlab'): RefLink[] {
  return kind === 'github'
    ? [{ sigil: '#', path: 'issues' }]
    : [
        { sigil: '!', path: '-/merge_requests' },
        { sigil: '#', path: '-/issues' },
      ];
}

/** Splits text into plain parts and references (`#12`, `!7`), with their forge URLs. */
export function splitReferences(
  text: string,
  kind: 'github' | 'gitlab',
  base: string | null,
): Array<{ text: string; url?: string }> {
  if (!base?.startsWith('https://')) return [{ text }];
  const links = referenceLinks(kind);
  const sigils = links.map((l) => (l.sigil === '#' ? '#' : '!')).join('');
  const pattern = new RegExp(`(^|[^\\w&/#!])([${sigils}])(\\d{1,9})\\b`, 'g');
  const out: Array<{ text: string; url?: string }> = [];
  let last = 0;
  for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
    const start = m.index + (m[1]?.length ?? 0);
    const link = links.find((l) => l.sigil === m?.[2]);
    if (!link) continue;
    if (start > last) out.push({ text: text.slice(last, start) });
    const ref = `${m[2]}${m[3]}`;
    out.push({ text: ref, url: `${base.replace(/\/$/, '')}/${link.path}/${m[3]}` });
    last = start + ref.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}
