/** Defensive readers for CLI JSON (never trust its shape). */

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  // GitLab's GraphQL sends `iid` as a string.
  if (typeof value === 'string' && /^\d{1,15}$/.test(value)) return Number(value);
  return null;
}

export function asBool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

export function toSha(value: unknown): string | null {
  const text = asString(value);
  return text !== null && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(text) ? text : null;
}

/** ISO timestamp normalised to `toISOString()` form, or null. */
export function normaliseTimestamp(value: unknown): string | null {
  const text = asString(value);
  if (text === null) return null;
  const time = Date.parse(text);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/** Parses JSON output; null when it is not a JSON object. */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return null;
  }
}
