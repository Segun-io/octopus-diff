import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isSameOrInside } from './paths.js';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

export interface StaticFile {
  body: Uint8Array<ArrayBuffer> | null;
  contentType: string;
  cacheControl: string;
  isHtml: boolean;
}

export type StaticLookup =
  | { kind: 'file'; file: StaticFile }
  | { kind: 'not_found' }
  | { kind: 'bad_request' };

/**
 * Serves the built web UI from `root` with an SPA fallback to `index.html`. Paths are decoded
 * per segment, `.`/`..`/NUL/backslash segments are refused, and the realpath of every file must
 * stay inside the realpath of `root` (no traversal, no symlink escape).
 */
export class StaticFiles {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  /** Returns null (API-only mode) when `root` does not exist or has no index.html. */
  static async create(root: string): Promise<StaticFiles | null> {
    try {
      const real = await realpath(root);
      const index = await stat(path.join(real, 'index.html'));
      if (!index.isFile()) return null;
      return new StaticFiles(real);
    } catch {
      return null;
    }
  }

  async lookup(
    pathname: string,
    options: { head: boolean; acceptsHtml: boolean },
  ): Promise<StaticLookup> {
    let segments: string[];
    try {
      segments = pathname
        .split('/')
        .filter((s) => s.length > 0)
        .map((s) => decodeURIComponent(s));
    } catch {
      return { kind: 'bad_request' };
    }
    for (const s of segments) {
      if (s === '.' || s === '..' || s.includes('\u0000') || s.includes('/') || s.includes('\\')) {
        return { kind: 'bad_request' };
      }
    }
    const direct = await this.#resolve(path.join(this.root, ...segments));
    if (direct) return { kind: 'file', file: await this.#read(direct, segments, options.head) };
    const last = segments.at(-1) ?? '';
    const looksLikeRoute = !last.includes('.') || options.acceptsHtml;
    if (!looksLikeRoute || segments[0] === 'assets') return { kind: 'not_found' };
    const index = await this.#resolve(path.join(this.root, 'index.html'));
    if (!index) return { kind: 'not_found' };
    return { kind: 'file', file: await this.#read(index, ['index.html'], options.head) };
  }

  async #resolve(candidate: string): Promise<string | null> {
    try {
      let real = await realpath(candidate);
      if (!isSameOrInside(this.root, real)) return null;
      let info = await stat(real);
      if (info.isDirectory()) {
        real = await realpath(path.join(real, 'index.html'));
        if (!isSameOrInside(this.root, real)) return null;
        info = await stat(real);
      }
      return info.isFile() ? real : null;
    } catch {
      return null;
    }
  }

  async #read(file: string, segments: string[], head: boolean): Promise<StaticFile> {
    const ext = path.extname(file).toLowerCase();
    const contentType = CONTENT_TYPES[ext] ?? 'application/octet-stream';
    const isHtml = ext === '.html';
    // Vite emits content-hashed files under assets/; everything else must revalidate.
    const cacheControl =
      segments[0] === 'assets' && !isHtml ? 'private, max-age=31536000, immutable' : 'no-cache';
    const body = head ? null : new Uint8Array(await readFile(file));
    return { body, contentType, cacheControl, isHtml };
  }
}
