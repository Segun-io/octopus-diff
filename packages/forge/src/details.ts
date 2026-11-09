import {
  CHANGE_REQUEST_LIMITS,
  type ChangeRequestCheck,
  type ChangeRequestComment,
  type CheckStatus,
  type ChecksState,
  type ForgeActor,
  type ReviewerState,
} from '@octopus-diff/contracts';
import { asArray, asBool, asRecord, asString, normaliseTimestamp } from './json.js';

/**
 * Shared helpers for the detail, conversation and repository normalisers (GitHub and GitLab).
 * Everything here treats CLI output as untrusted: unknown shapes become null or are dropped.
 */

/** Cuts `text` to at most `maxBytes` UTF-8 bytes without splitting a character. */
export function capBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false };
  let cut = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
  // A split multi-byte sequence decodes to U+FFFD at the end: drop it.
  while (cut.endsWith('�')) cut = cut.slice(0, -1);
  return { text: cut, truncated: true };
}

/** An https URL (absolute, or a path resolved against `https://<host>`), else null. */
export function httpsUrl(value: unknown, host?: string): string | null {
  const text = asString(value);
  if (text === null || text.length > 4096) return null;
  try {
    const url =
      text.startsWith('/') && !text.startsWith('//') && host
        ? new URL(text, `https://${host}`)
        : new URL(text);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/** GitHub `Actor` / GitLab `User` -> `ForgeActor`; null when there is no login. */
export function toActor(raw: unknown, host?: string): ForgeActor | null {
  const actor = asRecord(raw);
  const login = asString(actor?.login) ?? asString(actor?.username) ?? asString(actor?.slug);
  if (!actor || login === null) return null;
  const typename = asString(actor.__typename);
  return {
    login: login.slice(0, 256),
    name: asString(actor.name)?.slice(0, 256) ?? null,
    avatarUrl: httpsUrl(actor.avatarUrl, host),
    bot: asBool(actor.bot) ?? (typename === 'Bot' || login.endsWith('[bot]')),
  };
}

/** Label colour as six lower-case hex digits (GitHub sends `d73a4a`, GitLab `#D73A4A`). */
export function labelColor(value: unknown): string | null {
  const text = asString(value)?.replace(/^#/, '').toLowerCase() ?? null;
  return text !== null && /^[0-9a-f]{6}$/.test(text) ? text : null;
}

export function reviewerState(value: unknown): ReviewerState | null {
  switch (asString(value)?.toUpperCase()) {
    case 'APPROVED':
      return 'approved';
    case 'CHANGES_REQUESTED':
    case 'REQUESTED_CHANGES':
      return 'changes_requested';
    case 'COMMENTED':
    case 'REVIEWED':
      return 'commented';
    case 'DISMISSED':
      return 'dismissed';
    case 'PENDING':
    case 'UNREVIEWED':
    case 'REVIEW_STARTED':
    case 'UNAPPROVED':
      return 'pending';
    default:
      return null;
  }
}

/**
 * GitHub check run / status context -> `CheckStatus` (T3 Code's `toCheckStatus`, MIT, adapted):
 * anything not COMPLETED is pending; otherwise `conclusion ?? state`.
 */
export function githubCheckStatus(status: unknown, conclusion: unknown): CheckStatus {
  const s = asString(status)?.toUpperCase();
  if (s !== undefined && s !== 'COMPLETED') return 'pending';
  switch (asString(conclusion)?.toUpperCase()) {
    case 'SUCCESS':
      return 'success';
    case 'ACTION_REQUIRED':
      return 'action_required';
    case 'FAILURE':
    case 'ERROR':
    case 'TIMED_OUT':
    case 'STARTUP_FAILURE':
      return 'failure';
    case 'CANCELLED':
      return 'cancelled';
    case 'SKIPPED':
      return 'skipped';
    case 'PENDING':
    case 'EXPECTED':
      return 'pending';
    default:
      return 'neutral';
  }
}

/** GitLab job status -> `CheckStatus`. */
export function gitlabJobStatus(status: unknown): CheckStatus {
  switch (asString(status)?.toUpperCase()) {
    case 'SUCCESS':
      return 'success';
    case 'FAILED':
      return 'failure';
    case 'CANCELED':
    case 'CANCELING':
      return 'cancelled';
    case 'SKIPPED':
      return 'skipped';
    case 'MANUAL':
      return 'neutral';
    case undefined:
      return 'neutral';
    default:
      // CREATED, PENDING, RUNNING, PREPARING, SCHEDULED, WAITING_FOR_RESOURCE, ...
      return 'pending';
  }
}

/** Unfinished runs outrank finished runs of the same check (re-runs, push + PR workflows). */
export function dedupeChecks(checks: readonly ChangeRequestCheck[]): ChangeRequestCheck[] {
  const byKey = new Map<string, ChangeRequestCheck>();
  for (const check of checks) {
    const key = `${check.group ?? ''}\u0000${check.name}`;
    const seen = byKey.get(key);
    if (!seen || (check.status === 'pending' && seen.status !== 'pending')) byKey.set(key, check);
  }
  return [...byKey.values()];
}

/** Combined state of a check list, like the forges' rollups. */
export function checksStateOf(checks: readonly ChangeRequestCheck[]): ChecksState | null {
  if (checks.length === 0) return null;
  const statuses = new Set(checks.map((c) => c.status));
  if (statuses.has('failure') || statuses.has('cancelled')) return 'failure';
  if (statuses.has('pending') || statuses.has('action_required')) return 'pending';
  return statuses.has('success') ? 'success' : 'neutral';
}

/** One comment-like node -> `ChangeRequestComment` (body capped); null without an id. */
export function toComment(raw: unknown, host?: string): ChangeRequestComment | null {
  const node = asRecord(raw);
  const id = asString(node?.id);
  if (!node || id === null || id.length > 256) return null;
  const body = capBytes(
    typeof node.body === 'string' ? node.body : '',
    CHANGE_REQUEST_LIMITS.commentBodyBytes,
  );
  const createdAt = normaliseTimestamp(node.createdAt) ?? normaliseTimestamp(node.submittedAt);
  const edited = normaliseTimestamp(node.lastEditedAt);
  return {
    id,
    author: toActor(node.author, host),
    body: body.text,
    bodyTruncated: body.truncated,
    createdAt,
    editedAt: edited !== null && edited !== createdAt ? edited : null,
    url: httpsUrl(node.url, host),
  };
}

export function nodesOf(connection: unknown): unknown[] {
  return asArray(asRecord(connection)?.nodes);
}
