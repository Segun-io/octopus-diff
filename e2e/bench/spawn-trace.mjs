// Preload for perf profiling (`node --import ./spawn-trace.mjs`): wraps child_process.spawn and
// writes one JSON line per finished child to $OCTOPUS_SPAWN_TRACE:
//   { t0, t1, ms, cmd, sub, args, cwd, code }
// t0/t1 are epoch milliseconds (fractional). `sub` is the git subcommand (global options and
// `-c key=value` pins skipped); `args` the next few arguments, enough to tell calls apart; `cmd`
// the executable's base name (`git`, `gh`, ...).
// Used by e2e/bench/profile.ts and bench.ts only; the daemon itself is unchanged.
import childProcess from 'node:child_process';
import { openSync, writeSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const file = process.env.OCTOPUS_SPAWN_TRACE;
if (file) {
  const fd = openSync(file, 'a');
  const activeFile = process.env.OCTOPUS_SPAWN_ACTIVE;
  const activeFd = activeFile ? openSync(activeFile, 'a') : null;
  const original = childProcess.spawn;
  const now = () => performance.timeOrigin + performance.now();
  childProcess.spawn = function tracedSpawn(command, args, options) {
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
    const cwd = options && typeof options === 'object' ? options.cwd : undefined;
    // $OCTOPUS_SPAWN_ACTIVE: one '+' when a child starts and one '-' when it is gone, so a reader can tell
    // how many children are still running (the trace above only grows when one finishes).
    if (activeFd !== null) {
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
        `${JSON.stringify({ t0, t1, ms: Math.round((t1 - t0) * 100) / 100, cmd: String(command).split('/').pop(), sub, args: rest, cwd: cwd === undefined ? null : String(cwd), code })}\n`,
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
