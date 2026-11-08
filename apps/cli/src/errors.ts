/** Exit codes used by every command. */
export const EXIT_OK = 0;
/** Runtime failure (daemon not running, port in use, doctor found problems, …). */
export const EXIT_FAILURE = 1;
/** Bad command line or invalid config file. */
export const EXIT_USAGE = 2;

/** A problem with the command line or config file; printed without a stack trace. */
export class UsageError extends Error {
  override readonly name = 'UsageError';
}

/** A failure the user can act on; printed without a stack trace. */
export class CliError extends Error {
  override readonly name = 'CliError';
  readonly exitCode: number;

  constructor(message: string, exitCode = EXIT_FAILURE) {
    super(message);
    this.exitCode = exitCode;
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/** True if `error` (or anything in its `cause` chain) carries the errno `code`, e.g. EADDRINUSE. */
export function hasErrorCode(error: unknown, code: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current !== undefined && current !== null; depth++) {
    if (errorCode(current) === code) return true;
    if (current instanceof Error && current.message.includes(code)) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
