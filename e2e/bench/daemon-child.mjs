// Runs the daemon in its own process so the bench can sample its CPU from /proc/<pid>/stat.
// Options arrive as JSON in OCTOPUS_BENCH_DAEMON_OPTIONS; one JSON line on stdout reports the
// result. Plain JS so it runs on bare `node` against the built `apps/daemon/dist`.
import { writeFileSync } from 'node:fs';
import { startDaemon } from '@octopus-diff/daemon';

const options = JSON.parse(process.env.OCTOPUS_BENCH_DAEMON_OPTIONS ?? '{}');
try {
  const handle = await startDaemon(options);
  process.stdout.write(
    `${JSON.stringify({ ready: true, url: handle.url, authUrl: handle.authUrl, port: handle.port })}\n`,
  );
  // The bench asks for the daemon's cache counters (#49) with SIGUSR2; the answer is one JSON
  // file, written atomically enough for a reader that waits for the signal to be handled.
  const statsFile = process.env.OCTOPUS_BENCH_CACHE_STATS;
  if (statsFile && handle.core?.cacheStats) {
    process.on('SIGUSR2', () => {
      writeFileSync(statsFile, `${JSON.stringify(handle.core.cacheStats())}\n`);
    });
  }
  const stop = async () => {
    await handle.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`${JSON.stringify({ ready: false, error: message })}\n`);
  process.exit(1);
}
