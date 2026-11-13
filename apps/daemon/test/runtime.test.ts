/**
 * The daemon's Effect runtime (#46): Promise callers run Effects through it (an AbortSignal
 * interrupts them), `Effect.log*` reaches the daemon's logger, and disposing it releases the
 * scoped services (the watch host is killed).
 */
import { isGitCoreError, type LogFields } from '@octopus-diff/contracts';
import * as Effect from 'effect/Effect';
import { describe, expect, it } from 'vitest';
import { makeDaemonRuntime } from '../src/runtime.js';
import { WatchHostService } from '../src/watch-host.js';
import { eventually, tempDir } from './helpers.js';

function recordingLogger() {
  const lines: Array<{ level: string; message: string; fields: LogFields | undefined }> = [];
  const at =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      lines.push({ level, message, fields });
    };
  return {
    lines,
    logger: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') },
  };
}

const alive = (pid: number | undefined): boolean => {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('daemon runtime', () => {
  it('runs Effects for Promise callers; an AbortSignal interrupts them and rejects with aborted', async () => {
    const { logger } = recordingLogger();
    const rt = makeDaemonRuntime({ logger });
    expect(await rt.run(Effect.succeed(7))).toBe(7);
    let interrupted = false;
    const controller = new AbortController();
    const forever = rt.run(
      Effect.never.pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            interrupted = true;
          }),
        ),
      ),
      { signal: controller.signal },
    );
    controller.abort();
    const error = await forever.catch((e: unknown) => e);
    expect(isGitCoreError(error, 'aborted')).toBe(true);
    expect(interrupted).toBe(true);
    await rt.dispose();
  });

  it('sends Effect logs to the daemon logger, with annotations and causes as fields', async () => {
    const { lines, logger } = recordingLogger();
    const rt = makeDaemonRuntime({ logger });
    await rt.run(
      Effect.gen(function* () {
        yield* Effect.logDebug('debug line');
        yield* Effect.logWarning('watch host restarted', { attempt: 2 });
        yield* Effect.logError('failed').pipe(Effect.annotateLogs('repo', 'r1'));
      }),
    );
    expect(lines).toEqual([
      { level: 'debug', message: 'debug line', fields: undefined },
      { level: 'warn', message: 'watch host restarted', fields: { data: { attempt: 2 } } },
      { level: 'error', message: 'failed', fields: { repo: 'r1' } },
    ]);
    await rt.dispose();
  });

  it('owns the watch host: disposing the runtime kills it, and later subscribes are refused', async () => {
    const { logger } = recordingLogger();
    const rt = makeDaemonRuntime({ logger });
    const host = rt.runtime.runSync(WatchHostService);
    const dir = await tempDir();
    await host.subscribe(dir, () => {});
    const pid = host.pid;
    expect(alive(pid)).toBe(true);
    await rt.dispose();
    await rt.dispose(); // idempotent
    await eventually(() => !alive(pid), 5_000);
    await expect(host.subscribe(dir, () => {})).rejects.toThrow(/watch host closed/);
  });
});
