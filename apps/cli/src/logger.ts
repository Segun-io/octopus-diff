import type { LogFields, Logger, LogLevel } from '@octopus-diff/contracts';
import { oneLine } from './terminal.js';

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/**
 * Raw only for printable ASCII without `"` and `=`; anything else is JSON-quoted, and the C1
 * and bidi characters `JSON.stringify` leaves alone are escaped too (SEC-09: values may come
 * from repository content).
 */
function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    return /^[\x21-\x7e]+$/.test(value) && !/["=]/.test(value)
      ? value
      : oneLine(JSON.stringify(value));
  }
  if (value instanceof Error) return oneLine(JSON.stringify(value.message));
  try {
    return oneLine(JSON.stringify(value) ?? String(value));
  } catch {
    return oneLine(String(value));
  }
}

export function formatLogLine(
  level: Exclude<LogLevel, 'silent'>,
  message: string,
  fields: LogFields | undefined,
  now: Date,
): string {
  const time = now.toISOString().slice(11, 23);
  const extra = fields
    ? Object.entries(fields)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => ` ${k}=${formatValue(v)}`)
        .join('')
    : '';
  return `${time} ${level.toUpperCase().padEnd(5)} ${oneLine(message)}${extra}\n`;
}

/** Human-readable logfmt-ish logger writing to `write` (stderr by default in the CLI). */
export function createLogger(
  level: LogLevel,
  write: (line: string) => void,
  now: () => Date = () => new Date(),
): Logger {
  const threshold = RANK[level];
  const emit =
    (lvl: Exclude<LogLevel, 'silent'>) =>
    (message: string, fields?: LogFields): void => {
      if (RANK[lvl] >= threshold) write(formatLogLine(lvl, message, fields, now()));
    };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}
