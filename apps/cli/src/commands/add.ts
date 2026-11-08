import { stat } from 'node:fs/promises';
import { SCAN_DEPTH_DEFAULT } from '@octopus-diff/contracts';
import type { AddFlags } from '../args.js';
import type { CliDeps } from '../deps.js';
import { EXIT_FAILURE, EXIT_OK } from '../errors.js';
import { resolveUserPath, tildify } from '../paths.js';
import { loadContext } from '../settings.js';
import { oneLine } from '../terminal.js';
import { connectToDaemon, describeApiError } from './daemon-client.js';

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * `octopus-diff add <path>… [--scan <dir>]… [--depth n]`: registers repositories and scan roots
 * with the running daemon. Paths are resolved against the CLI's cwd before they are sent, since
 * the daemon's cwd is unrelated. Without a running daemon this fails with a hint to run `serve`.
 */
export async function runAdd(flags: AddFlags, deps: CliDeps): Promise<number> {
  const ctx = { env: deps.env, cwd: deps.cwd };
  const { paths, loaded } = await loadContext(flags, ctx);
  const out = (line: string) => deps.stdout.write(`${line}\n`);
  const err = (line: string) => deps.stderr.write(`${line}\n`);
  // Names and paths come from the daemon and the repositories: one line each (SEC-09).
  const show = (p: string) => oneLine(tildify(p, paths.home));

  const conn = await connectToDaemon(flags, loaded.config, paths.stateDir, deps);
  let failures = 0;

  for (const input of flags.paths) {
    const absolute = resolveUserPath(input, deps.cwd, paths.home);
    if (!(await isDirectory(absolute))) {
      err(`error: ${show(absolute)}: no such directory`);
      failures++;
      continue;
    }
    try {
      const { project, created } = await conn.client.addProject({ path: absolute });
      const worktrees = project.worktrees.length;
      out(
        `${created ? 'added' : 'already added'}: ${oneLine(project.project.name)} ` +
          `(${worktrees} worktree${worktrees === 1 ? '' : 's'}) ${show(project.project.mainWorktreePath ?? absolute)}`,
      );
    } catch (error) {
      err(`error: ${show(absolute)}: ${oneLine(describeApiError(error))}`);
      failures++;
    }
  }

  const depth = flags.depth ?? loaded.config.scanDepth ?? SCAN_DEPTH_DEFAULT;
  for (const input of flags.scan) {
    const absolute = resolveUserPath(input, deps.cwd, paths.home);
    if (!(await isDirectory(absolute))) {
      err(`error: ${show(absolute)}: no such directory`);
      failures++;
      continue;
    }
    try {
      const { scanRoot, created } = await conn.client.addScanRoot({ path: absolute, depth });
      out(
        `${created ? 'scan root added' : 'scan root already added'}: ${show(scanRoot.path)} ` +
          `(depth ${scanRoot.depth}); scanning in the background`,
      );
    } catch (error) {
      err(`error: ${show(absolute)}: ${oneLine(describeApiError(error))}`);
      failures++;
    }
  }

  return failures > 0 ? EXIT_FAILURE : EXIT_OK;
}
