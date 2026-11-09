import { TEST_IDS } from '@octopus-diff/contracts';
import { type ComponentProps, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { safeHref, safeImageSrc, splitReferences, visibleBody } from '../../lib/markdown.ts';

/**
 * Forge markdown (descriptions, comments), rendered without raw HTML: `skipHtml` drops HTML
 * nodes, there is no rehype-raw and no `dangerouslySetInnerHTML`. Links are https/mailto/fragment
 * only (relative ones resolve against the forge repository), open in a new tab without referrer,
 * task-list boxes are disabled, images load only from the hosts the CSP allows and fall back to a
 * link. Loaded lazily (`MarkdownLazy`): only the Request tab needs it.
 */
export interface MarkdownProps {
  text: string;
  /** Forge repository web URL: relative links and `#123` / `!123` resolve against it. */
  base: string | null;
  kind: 'github' | 'gitlab';
  /** Hosts the UI's CSP allows images from (`ChangeRequestDetailResponse.imageHosts`). */
  imageHosts: readonly string[];
  className?: string;
}

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

/** remark plugin: `#123` / `!123` in plain text become links to the forge (not in code or links). */
function remarkReferences(options: { kind: 'github' | 'gitlab'; base: string | null }) {
  const walk = (node: MdNode) => {
    if (!node.children || node.type === 'link' || node.type === 'linkReference') return;
    const next: MdNode[] = [];
    for (const child of node.children) {
      if (child.type === 'text' && typeof child.value === 'string') {
        for (const part of splitReferences(child.value, options.kind, options.base)) {
          next.push(
            part.url
              ? { type: 'link', url: part.url, children: [{ type: 'text', value: part.text }] }
              : { type: 'text', value: part.text },
          );
        }
      } else {
        walk(child);
        next.push(child);
      }
    }
    node.children = next;
  };
  return (tree: MdNode) => walk(tree);
}

function Image({
  src,
  alt,
  base,
  imageHosts,
}: {
  src: string | undefined;
  alt: string | undefined;
  base: string | null;
  imageHosts: readonly string[];
}) {
  const [failed, setFailed] = useState(false);
  const allowed = safeImageSrc(src, base, imageHosts);
  const href = src ? safeHref(src, base) : '';
  const label = `image: ${alt?.trim() || 'untitled'}`;
  if (!allowed || failed) {
    return href && !href.startsWith('#') ? (
      <a href={href} target="_blank" rel="noopener noreferrer" className="od-md-link">
        {label} ↗
      </a>
    ) : (
      <span className="text-muted">{label}</span>
    );
  }
  return (
    <img
      src={allowed}
      alt={alt ?? ''}
      referrerPolicy="no-referrer"
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className="my-1 inline-block max-h-96 max-w-full rounded-sm border border-line"
    />
  );
}

export function Markdown({ text, base, kind, imageHosts, className = '' }: MarkdownProps) {
  const body = visibleBody(text);
  if (body === null) return null;
  const components: Components = {
    a: ({ href, children }: ComponentProps<'a'>) => {
      const safe = href ? safeHref(href, base) : '';
      if (!safe) return <span>{children}</span>;
      if (safe.startsWith('#')) return <a href={safe}>{children}</a>;
      return (
        <a href={safe} target="_blank" rel="noopener noreferrer" className="od-md-link">
          {children}
        </a>
      );
    },
    img: ({ src, alt }: ComponentProps<'img'>) => (
      <Image
        src={typeof src === 'string' ? src : undefined}
        alt={alt}
        base={base}
        imageHosts={imageHosts}
      />
    ),
    input: ({ type, checked }: ComponentProps<'input'>) =>
      type === 'checkbox' ? (
        <input
          type="checkbox"
          checked={checked ?? false}
          disabled
          readOnly
          className="mr-1 align-middle"
        />
      ) : null,
  };
  return (
    <div data-testid={TEST_IDS.markdown} className={`od-markdown ${className}`}>
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm, [remarkReferences, { kind, base }]]}
        // Links are vetted in the `a` component (relative URLs need the forge base); images in `img`.
        urlTransform={(url) => (/^(?:https:|mailto:|#|\/|\.|[^:]*$)/i.test(url) ? url : '')}
        components={components}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}
