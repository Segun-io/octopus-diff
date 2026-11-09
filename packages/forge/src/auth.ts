import { stripVTControlCharacters } from 'node:util';
import { type ForgeCliAccount, ForgeHostSchema } from '@octopus-diff/contracts';

/**
 * Parses the human-readable `gh auth status` / `glab auth status` output into the hosts the CLI
 * is signed in to. Text, not `--json`, because `gh auth status --json` needs gh >= 2.81 (Ubuntu
 * ships 2.46) and glab has no JSON form. Both print one block per host:
 *
 *   github.com
 *     ✓ Logged in to github.com account octo (/home/u/.config/gh/hosts.yml)     (gh >= 2.40)
 *     ✓ Logged in to github.com as octo (/home/u/.config/gh/hosts.yml)          (older gh, glab)
 *     X Failed to log in to github.com account old (default)
 *
 * Adapted from T3 Code's `parseGitLabAuthStatusHosts`
 * (packages/source-control-gitlab/src/server/gitLabAuthStatus.ts, MIT,
 * https://github.com/pingdotgg/t3code).
 */

const HOST_LINE = /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[a-f0-9:.]+\])(?::\d+)?$/i;
const LOGGED_IN = /Logged in to (\S+?) (?:account|as)\s+([^\s(]+)/i;

/** Strips ANSI escapes and other control characters (tabs and newlines are kept). */
export function stripControl(text: string): string {
  let out = '';
  for (const ch of stripVTControlCharacters(text)) {
    const code = ch.charCodeAt(0);
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)) out += ch;
  }
  return out;
}

export function parseAuthStatus(text: string): ForgeCliAccount[] {
  const accounts = new Map<string, string | null>();
  let currentHost: string | null = null;
  for (const raw of stripControl(text).split(/\r?\n/)) {
    if (raw.trim().length === 0) continue;
    const indented = raw.length !== raw.trimStart().length;
    const line = raw.trim();
    if (!indented && HOST_LINE.test(line)) {
      currentHost = line.toLowerCase();
      continue;
    }
    const match = LOGGED_IN.exec(line);
    if (!match) continue;
    const host = (match[1] ?? currentHost ?? '').toLowerCase().replace(/:$/, '');
    const account = match[2] ?? null;
    if (!ForgeHostSchema.safeParse(host).success) continue;
    // gh lists every account of a host; the first signed-in one is enough to know the host works.
    if (!accounts.has(host) || accounts.get(host) === null) accounts.set(host, account);
  }
  return [...accounts].map(([host, account]) => ({ host, account }));
}

/** First line worth showing from auth output (never a token line). */
export function firstSafeLine(text: string): string | null {
  for (const raw of stripControl(text).split(/\r?\n/)) {
    const line = raw.trim().replace(/^[✓✗xX!-]\s+/, '');
    if (line.length === 0 || /token/i.test(line)) continue;
    return line.length > 200 ? `${line.slice(0, 197)}...` : line;
  }
  return null;
}
