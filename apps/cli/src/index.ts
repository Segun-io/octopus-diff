#!/usr/bin/env node
/**
 * octopus-diff CLI — PLACEHOLDER until WS5 lands.
 *
 * WS5 implements `serve`, `add` and `doctor` (PLAN §6 WS5) on top of `startDaemon`.
 */
import { APP_NAME } from '@octopus-diff/contracts';

export const USAGE = `Usage: ${APP_NAME} <command> [options]

Commands:
  serve     Start the daemon and print the URL to open
  add       Register a repository by path
  doctor    Check git, watcher limits and config paths
`;

export function main(argv: readonly string[]): number {
  const [command] = argv;
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  process.stderr.write(`${APP_NAME}: command not implemented yet: ${command}\n`);
  return 1;
}

const entry = process.argv[1];
if (entry && import.meta.url === new URL(`file://${entry}`).href) {
  process.exitCode = main(process.argv.slice(2));
}
