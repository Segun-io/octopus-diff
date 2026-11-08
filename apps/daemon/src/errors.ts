import {
  type ApiErrorBody,
  type ApiErrorCode,
  type GitCoreErrorCode,
  isGitCoreError,
} from '@octopus-diff/contracts';

export type ApiErrorInfo = ApiErrorBody['error'];

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  not_a_repository: 422,
  git_error: 500,
  timeout: 504,
  too_large: 413,
  internal: 500,
};

/** An error that maps directly to an `ApiErrorBody` response. */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(
    code: ApiErrorCode,
    message: string,
    options: { status?: number; details?: unknown; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'ApiError';
    this.code = code;
    this.status = options.status ?? STATUS_BY_CODE[code];
    this.details = options.details;
  }

  toBody(): ApiErrorBody {
    const error: ApiErrorInfo = { code: this.code, message: this.message };
    if (this.details !== undefined) error.details = this.details;
    return { error };
  }
}

const GIT_CODE_MAP: Record<GitCoreErrorCode, { code: ApiErrorCode; status: number }> = {
  not_a_repository: { code: 'not_a_repository', status: 422 },
  not_found: { code: 'not_found', status: 404 },
  invalid_argument: { code: 'bad_request', status: 400 },
  command_not_allowed: { code: 'internal', status: 500 },
  git_not_found: { code: 'git_error', status: 500 },
  git_unsupported: { code: 'git_error', status: 500 },
  git_failed: { code: 'git_error', status: 500 },
  timeout: { code: 'timeout', status: 504 },
  output_too_large: { code: 'too_large', status: 413 },
  aborted: { code: 'internal', status: 503 },
  disposed: { code: 'internal', status: 503 },
  not_implemented: { code: 'internal', status: 501 },
};

const STDERR_MAX = 2000;

/** Converts anything thrown into an `ApiError` (GitCoreError codes are mapped, PLAN §5.4). */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (isGitCoreError(error)) {
    const mapped = GIT_CODE_MAP[error.code] ?? { code: 'internal', status: 500 };
    const details: Record<string, unknown> = { gitCode: error.code };
    if (error.details.exitCode !== undefined) details.exitCode = error.details.exitCode;
    if (typeof error.details.stderr === 'string' && error.details.stderr.length > 0) {
      details.stderr = error.details.stderr.slice(0, STDERR_MAX);
    }
    return new ApiError(mapped.code, error.message, {
      status: mapped.status,
      details,
      cause: error,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ApiError('internal', message || 'internal error', { cause: error });
}

export function notFound(what: string): ApiError {
  return new ApiError('not_found', `${what} not found`);
}

/** True for errors that only mean "we are shutting down". */
export function isShutdownError(error: unknown): boolean {
  return isGitCoreError(error, 'disposed') || isGitCoreError(error, 'aborted');
}
