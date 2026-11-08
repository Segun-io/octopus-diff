import { stat } from 'node:fs/promises';
import { APP_NAME } from '@octopus-diff/contracts';
import type { TokenFlags } from '../args.js';
import type { CliDeps } from '../deps.js';
import { EXIT_OK } from '../errors.js';
import { tildify } from '../paths.js';
import { rotateToken, tokenFilePath } from '../runtime.js';
import { loadContext } from '../settings.js';
import { oneLine } from '../terminal.js';
import { findRunningDaemon } from './daemon-client.js';

/**
 * `octopus-diff token [--rotate]` (SEC-11). Without `--rotate` it describes the token file
 * (never the token). With `--rotate` it writes a new token; a running daemon keeps the old one
 * in memory until it restarts, so it says so when one is running.
 */
export async function runToken(flags: TokenFlags, deps: CliDeps): Promise<number> {
  const ctx = { env: deps.env, cwd: deps.cwd };
  const { paths } = await loadContext(flags, ctx);
  const file = tokenFilePath(paths.stateDir);
  const show = oneLine(tildify(file, paths.home));
  const out = (line: string) => deps.stdout.write(`${line}\n`);

  if (!flags.rotate) {
    try {
      const info = await stat(file);
      out(`Token file: ${show} (mode ${(info.mode & 0o777).toString(8)})`);
    } catch {
      out(`Token file: ${show} (not created yet; \`${APP_NAME} serve\` creates it)`);
    }
    out(
      `\`${APP_NAME} status\` prints the URL to open; \`${APP_NAME} token --rotate\` replaces it.`,
    );
    return EXIT_OK;
  }

  // Check before rotating: the proof is made with the token the daemon holds (the old one).
  const running = await findRunningDaemon(paths.stateDir, deps);
  await rotateToken(paths.stateDir);
  out(`Replaced the auth token in ${show}.`);
  if (running?.verified) {
    out('');
    out(
      `The running daemon (pid ${running.pid}, ${running.url}) keeps accepting only the old token ` +
        'until it restarts. Stop it (Ctrl+C in its terminal) and run',
    );
    out(`\`${APP_NAME} serve\` again, then open the new URL it prints.`);
  } else {
    out(`Start the daemon with \`${APP_NAME} serve\` and open the new URL it prints.`);
  }
  out('Browsers signed in with the old token must open the new URL.');
  return EXIT_OK;
}
