/**
 * Minimal `~/.ssh/config` reading, for remotes that use an ssh alias such as
 * `git@github-work:me/app.git` with `Host github-work` / `HostName github.com`. Only literal
 * `Host` patterns (no wildcards, no negation) and their `HostName` are used; `Include` and
 * `Match` blocks are ignored. Returns lower-case alias -> lower-case hostname.
 */
export function parseSshConfigAliases(text: string): Map<string, string> {
  const aliases = new Map<string, string>();
  let current: string[] = [];
  let inMatch = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const match = /^(\S+?)\s*(?:=\s*|\s+)(.+)$/.exec(line);
    if (!match) continue;
    const keyword = (match[1] ?? '').toLowerCase();
    const value = (match[2] ?? '').trim();
    if (keyword === 'host') {
      inMatch = false;
      current = value
        .split(/\s+/)
        .map((p) => p.replace(/^"|"$/g, '').toLowerCase())
        .filter((p) => p.length > 0 && !/[*?!]/.test(p));
    } else if (keyword === 'match') {
      inMatch = true;
      current = [];
    } else if (keyword === 'hostname' && !inMatch) {
      const hostname = value.replace(/^"|"$/g, '').toLowerCase();
      // `%h` tokens and the like: not a literal hostname.
      if (hostname.includes('%')) continue;
      for (const alias of current) {
        // First obtained value wins, as in ssh.
        if (!aliases.has(alias)) aliases.set(alias, hostname);
      }
    }
  }
  return aliases;
}
