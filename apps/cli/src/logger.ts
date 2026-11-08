import type { LogFields, Logger, LogLevel } from '@octopus-diff/contracts';

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function formatValue(value: unknown): string {
  if (typeof value === 'string') return /^[^\s"=]+$/.test(value) ? value : JSON.stringify(value);
  if (value instanceof Error) return JSON.stringify(value.message);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
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
  return `${time} ${level.toUpperCase().padEnd(5)} ${message}${extra}\n`;
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
