import type { LogFields, Logger, LogLevel } from '@octopus-diff/contracts';

const LEVELS: Record<Exclude<LogLevel, 'silent'>, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

type Level = keyof typeof LEVELS;

const SENSITIVE_KEY = /token|authorization|cookie|password|secret/i;
const REDACTED = '[redacted]';

export interface LoggerOptions {
  level?: LogLevel;
  /** Delegate logger (e.g. from the CLI). Default: JSON lines on stderr. */
  logger?: Logger;
  /** Values that must never appear in logs (the auth token). */
  secrets?: () => readonly string[];
  /** Line sink for the default JSON logger (tests). */
  write?: (line: string) => void;
  now?: () => Date;
}

function redactString(value: string, secrets: readonly string[]): string {
  let out = value;
  for (const secret of secrets) {
    if (secret.length > 0 && out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  return out;
}

function sanitize(value: unknown, secrets: readonly string[], depth: number): unknown {
  if (typeof value === 'string') return redactString(value, secrets);
  if (value === null || typeof value !== 'object') return value;
  if (depth > 4) return '[…]';
  if (value instanceof Error) {
    const out: Record<string, unknown> = {
      name: value.name,
      message: redactString(value.message, secrets),
    };
    const code = (value as { code?: unknown }).code;
    if (code !== undefined) out.code = code;
    return out;
  }
  if (Array.isArray(value)) return value.map((item) => sanitize(item, secrets, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : sanitize(item, secrets, depth + 1);
  }
  return out;
}

/**
 * Structured logger: JSON lines on stderr by default (`{"time","level","msg",...fields}`).
 * Filters by level and redacts the auth token and sensitive-looking keys in every case,
 * including when a delegate logger is supplied.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold =
    options.level === 'silent' ? Number.POSITIVE_INFINITY : LEVELS[options.level ?? 'info'];
  const secrets = options.secrets ?? (() => []);
  const now = options.now ?? (() => new Date());
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const delegate = options.logger;

  const emit = (level: Level, message: string, fields?: LogFields) => {
    if (LEVELS[level] < threshold) return;
    const s = secrets();
    const msg = redactString(message, s);
    const clean = fields ? (sanitize(fields, s, 0) as LogFields) : undefined;
    if (delegate) {
      delegate[level](msg, clean);
      return;
    }
    let line: string;
    try {
      line = JSON.stringify({ time: now().toISOString(), level, msg, ...clean });
    } catch {
      line = JSON.stringify({ time: now().toISOString(), level, msg });
    }
    write(line);
  };

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}
