// Preload for perf profiling (`node --import ./spawn-trace.mjs`): wraps child_process.spawn and
// writes one JSON line per finished child to $OCTOPUS_SPAWN_TRACE:
//   { t0, t1, ms, cmd, sub, args, argv, cwd, code }
// t0/t1 are epoch milliseconds (fractional). `sub` is the git subcommand (global options and
// `-c key=value` pins skipped); `args` the next few arguments, enough to group calls; `argv` every
// argument after the subcommand (at most 40, each cut at 200 characters), enough to tell two calls
// apart (object ids come after `--end-of-options`); `cmd` the executable's base name (`git`, `gh`, ...).
// Used by e2e/bench/profile.ts and bench.ts only; the daemon itself is unchanged. With git-core's
// spawn helper on, the preload follows into the helper processes (`traceHelper`).
import childProcess from 'node:child_process';
import { openSync, writeSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const TRACE_VARS = ['OCTOPUS_SPAWN_TRACE', 'OCTOPUS_SPAWN_ACTIVE', 'OCTOPUS_MEM_TRACE'];

/**
 * git-core's spawn helper (#45) starts git in its own process: load this preload there too (same
 * trace files, appended with one write per line), so every git process is still traced, timed
 * from the helper that spawns it. Its memory is not traced (the daemon's RSS is the figure).
 */
function traceHelper(args, options) {
  if (!Array.isArray(args) || !args.includes('--octopus-diff-git-helper')) return [args, options];
  const env = { ...(options?.env ?? {}) };
  for (const name of TRACE_VARS.slice(0, 2)) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return [['--import', SELF, ...args], { ...options, env }];
}

const file = process.env.OCTOPUS_SPAWN_TRACE;
if (file) {
  const fd = openSync(file, 'a');
  const activeFile = process.env.OCTOPUS_SPAWN_ACTIVE;
  const activeFd = activeFile ? openSync(activeFile, 'a') : null;
  const original = childProcess.spawn;
  const now = () => performance.timeOrigin + performance.now();
  childProcess.spawn = function tracedSpawn(command, rawArgs, rawOptions) {
    const [args, options] = traceHelper(rawArgs, rawOptions);
    const t0 = now();
    const child = original.call(this, command, args, options);
    const argv = Array.isArray(args) ? args : [];
    let i = 0;
    while (i < argv.length) {
      const a = String(argv[i]);
      if (a === '-c' || a === '-C') i += 2;
      else if (a.startsWith('-')) i += 1;
      else break;
    }
    const sub = argv[i] === undefined ? String(command) : String(argv[i]);
    const rest = argv
      .slice(i + 1)
      .map(String)
      .filter((a) => !['--no-ext-diff', '--no-textconv', '--no-color'].includes(a))
      .slice(0, 6);
    const full = argv
      .slice(i + 1)
      .slice(0, 40)
      .map((a) => String(a).slice(0, 200));
    const cwd = options && typeof options === 'object' ? options.cwd : undefined;
    // $OCTOPUS_SPAWN_ACTIVE: one '+' when a git child starts and one '-' when it is gone, so a reader can
    // tell how many git processes are still running (the trace above only grows when one finishes).
    // Only git: the daemon's long-lived helpers (the watch host is a `node` child) would otherwise
    // count as running forever, and a "quiet" wait would always run into its timeout (#74).
    const cmd = String(command).split(/[\\/]/).pop();
    if (activeFd !== null && /^git(\.exe)?$/i.test(cmd ?? '')) {
      writeSync(activeFd, '+');
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        writeSync(activeFd, '-');
      };
      child.once('close', end);
      child.once('error', end);
    }
    child.once('close', (code) => {
      const t1 = now();
      writeSync(
        fd,
        `${JSON.stringify({ t0, t1, ms: Math.round((t1 - t0) * 100) / 100, cmd: String(command).split('/').pop(), sub, args: rest, argv: full, cwd: cwd === undefined ? null : String(cwd), code })}\n`,
      );
    });
    return child;
  };
  syncBuiltinESMExports();
}

// $OCTOPUS_MEM_TRACE: one `process.memoryUsage()` line every 2 s (epoch ms in `t`).
const memFile = process.env.OCTOPUS_MEM_TRACE;
if (memFile) {
  const fd = openSync(memFile, 'a');
  const timer = setInterval(() => {
    const m = process.memoryUsage();
    writeSync(fd, `${JSON.stringify({ t: Date.now(), ...m })}\n`);
  }, 2000);
  timer.unref();
}
