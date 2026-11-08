import { z } from 'zod';

/** Bumped only on breaking API changes. Additive changes keep the same version. */
export const API_VERSION = 1;

export const APP_NAME = 'octopus-diff';
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 7428;

/** Auth: the token may arrive as `Authorization: Bearer <token>`, as this cookie, or once as `?token=`. */
export const AUTH_COOKIE_NAME = 'octopus_diff_token';
export const AUTH_QUERY_PARAM = 'token';
export const AUTH_HEADER = 'authorization';

/**
 * Stable identifier: the first 16 lowercase hex chars of SHA-256 over a UTF-8 realpath.
 * - ProjectId  = hash of the realpath of the project's common git dir.
 * - WorktreeId = hash of the realpath of the worktree root (for a bare repo: its git dir).
 * - ScanRootId = hash of the realpath of the scan root directory.
 * git-core computes project/worktree ids; the daemon computes scan root ids the same way.
 */
export const IdSchema = z.string().regex(/^[0-9a-f]{16}$/, 'expected a 16-char lowercase hex id');
export type Id = z.infer<typeof IdSchema>;
export type ProjectId = Id;
export type WorktreeId = Id;
export type ScanRootId = Id;

/** ISO-8601 timestamp in UTC, as produced by `Date.prototype.toISOString()`. */
export const TimestampSchema = z.iso.datetime();
export type Timestamp = z.infer<typeof TimestampSchema>;

function hasNul(value: string): boolean {
  return value.includes('\u0000');
}

/** An absolute filesystem path as reported by the daemon (POSIX, or a Windows drive path). */
export const AbsolutePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((v) => !hasNul(v), 'path must not contain NUL')
  .refine((v) => v.startsWith('/') || /^[A-Za-z]:[\\/]/.test(v), 'expected an absolute path');

/**
 * A user-supplied filesystem path (request bodies). May be relative to the daemon's cwd or start
 * with `~`; the daemon expands and resolves it before use.
 */
export const InputPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine((v) => !hasNul(v), 'path must not contain NUL');

/**
 * A repo-relative path using `/` separators, as git prints it. Never absolute, never contains
 * `.` or `..` segments (git does not allow those in the index), never contains NUL. This is the
 * first line of defense against path traversal; git-core still treats paths as literal pathspecs.
 */
export const RepoPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((v) => !hasNul(v), 'path must not contain NUL')
  .refine((v) => !v.startsWith('/'), 'path must be repo-relative')
  .refine(
    (v) => v.split('/').every((segment) => segment !== '..' && segment !== '.'),
    'path must not contain "." or ".." segments',
  );

/** Base64 of raw path bytes; only present when the path is not valid UTF-8. */
export const RawPathSchema = z.base64().max(8192);

/** Git file mode as six octal digits, e.g. 100644, 100755, 120000 (symlink), 160000 (gitlink). */
export const FileModeSchema = z.string().regex(/^[0-7]{6}$/, 'expected a 6-digit octal file mode');

export const CommitShaSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{4,64}$/, 'expected a hex commit id (4-64 chars)');

function isValidRefName(value: string): boolean {
  if (value.length === 0 || value.length > 255) return false;
  if (value === '@' || value.startsWith('-') || value.startsWith('/')) return false;
  if (value.endsWith('/') || value.endsWith('.') || value.endsWith('.lock')) return false;
  if (value.includes('..') || value.includes('@{') || value.includes('//')) return false;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) return false;
    if ('~^:?*[\\'.includes(char)) return false;
  }
  return true;
}

/**
 * A git ref name such as `main`, `origin/main`, or `refs/heads/feature/x`. Stricter than
 * `git check-ref-format`: no leading `-` (prevents option injection) and no revision syntax.
 */
export const RefNameSchema = z.string().refine(isValidRefName, 'invalid git ref name');

export const ApiErrorCodeSchema = z.enum([
  'bad_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'not_a_repository',
  'git_error',
  'timeout',
  'too_large',
  'internal',
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

/** Every non-2xx JSON response from the daemon has this shape. */
export const ApiErrorBodySchema = z.object({
  error: z.object({
    code: ApiErrorCodeSchema,
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;

export const OkResponseSchema = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof OkResponseSchema>;

export type LogFields = Record<string, unknown>;

/** Minimal structured logger shared by git-core and the daemon. */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
