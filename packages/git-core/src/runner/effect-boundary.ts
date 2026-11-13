/**
 * The boundary between the Promise world (Hono handlers, the CLI, `GitCore`'s methods, tests) and
 * Effect code (#46, DECISIONS #396). Three small pieces, so the migration of #47-#49 can move
 * code behind Effect one piece at a time without changing any public API:
 *
 * - `runGit`: a runner call as an Effect. Interrupting the fiber aborts the call's AbortSignal,
 *   so the git process is cancelled exactly as an aborted signal cancels it today (queued: never
 *   starts; running: SIGTERM to its group, SIGKILL after `ABORT_GRACE_MS`), and the interruption
 *   completes only once the run has settled, i.e. its process has exited and its slot is free.
 * - `runAtBoundary`: runs an Effect for a Promise caller. An AbortSignal interrupts it; a typed
 *   failure rejects with the error itself (a `GitCoreError` stays one, so the daemon maps it to
 *   an `ApiErrorBody` as before); an interruption rejects with `GitCoreError('aborted')`; a defect
 *   rejects with the defect.
 * - `decodeUnknown`: validates input with any Standard Schema (the zod schemas of
 *   `@octopus-diff/contracts` are one), failing with `GitCoreError('invalid_argument')`.
 */
import { GitCoreError, isGitCoreError } from '@octopus-diff/contracts';
import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import type * as ManagedRuntime from 'effect/ManagedRuntime';
import { abortedError } from './call-context.js';
import type { GitRunner, GitRunOptions, GitRunResult } from './runner.js';

const settled = (): void => {};

/**
 * `runner.run(args, options)` as an Effect that fails with `GitCoreError` (anything else the runner
 * throws is a defect). `options.signal`, if any, still cancels it too.
 */
export const runGit = (
  runner: GitRunner,
  args: readonly string[],
  options: GitRunOptions,
): Effect.Effect<GitRunResult, GitCoreError> =>
  Effect.callback<GitRunResult, GitCoreError>((resume, signal) => {
    const run = runner.run(args, {
      ...options,
      signal: options.signal ? AbortSignal.any([options.signal, signal]) : signal,
    });
    run.then(
      (result) => resume(Effect.succeed(result)),
      (error: unknown) => resume(isGitCoreError(error) ? Effect.fail(error) : Effect.die(error)),
    );
    // Interruption has aborted `signal`; it completes when the run has settled (process gone).
    return Effect.promise(() => run.then(settled, settled));
  });

/** What `runAtBoundary` accepts: a ManagedRuntime, or nothing (no services needed). */
type BoundaryRuntime<R> = ManagedRuntime.ManagedRuntime<R, never>;

/**
 * Runs `effect` for a Promise caller (see the module comment for how its exit maps). The fiber is
 * interrupted when `signal` aborts; the promise settles once the interruption has completed.
 */
export function runAtBoundary<A, E, R = never>(
  runtime: BoundaryRuntime<R> | null,
  effect: Effect.Effect<A, E, R>,
  options: { signal?: AbortSignal | undefined } = {},
): Promise<A> {
  const runOptions = options.signal ? { signal: options.signal } : undefined;
  const exit = runtime
    ? runtime.runPromiseExit(effect, runOptions)
    : Effect.runPromiseExit(effect as Effect.Effect<A, E>, runOptions);
  return exit.then((result) => {
    if (Exit.isSuccess(result)) return result.value;
    throw boundaryError(result.cause);
  });
}

/** The value a Promise caller sees for a failed Effect (see `runAtBoundary`). */
export function boundaryError<E>(cause: Cause.Cause<E>): unknown {
  const failure = Cause.findErrorOption(cause);
  if (failure._tag === 'Some') return failure.value;
  if (Cause.hasDies(cause)) return Cause.squash(cause);
  if (Cause.hasInterrupts(cause)) return abortedError({});
  return Cause.squash(cause);
}

/** The Standard Schema interface (v1), as zod 4 implements it: just what decoding needs. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
}

type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | {
      readonly issues: ReadonlyArray<{
        readonly message: string;
        readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
      }>;
    };

/**
 * Decodes `input` with a Standard Schema (a contracts zod schema), failing with
 * `GitCoreError('invalid_argument')` that lists the issues (`details.issues`).
 */
export const decodeUnknown = <Output>(
  schema: StandardSchemaV1<unknown, Output>,
  input: unknown,
  what = 'input',
): Effect.Effect<Output, GitCoreError> =>
  Effect.flatMap(
    Effect.promise(async () => schema['~standard'].validate(input)),
    (result): Effect.Effect<Output, GitCoreError> => {
      if (result.issues === undefined) return Effect.succeed(result.value);
      const issues = result.issues.map((issue) => ({
        message: issue.message,
        path: (issue.path ?? []).map((p) =>
          String(typeof p === 'object' && p !== null ? p.key : p),
        ),
      }));
      const first = issues[0];
      const where = first && first.path.length > 0 ? ` at ${first.path.join('.')}` : '';
      return Effect.fail(
        new GitCoreError(
          'invalid_argument',
          `invalid ${what}${where}: ${first?.message ?? 'rejected'}`,
          { issues },
        ),
      );
    },
  );
