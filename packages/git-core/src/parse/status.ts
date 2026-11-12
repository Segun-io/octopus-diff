import { splitFields, splitNul } from './tokens.js';

/** Parsed `# branch.*` headers of `git status --porcelain=v2 --branch`. */
export interface StatusBranch {
  /** HEAD commit, or null for an unborn branch (`(initial)`). */
  oid: string | null;
  /** Branch short name (bstr), or null when detached. */
  head: string | null;
  detached: boolean;
  /** Upstream short name (bstr), e.g. `origin/main`, or null. */
  upstream: string | null;
  /** From `# branch.ab`; null when there is no (existing) upstream. */
  ahead: number | null;
  behind: number | null;
}

interface StatusEntryBase {
  /** Repo-relative path, raw bytes as bstr. */
  path: string;
  /** The raw entry text (bstr), useful for hashing. */
  line: string;
}

/** `1 XY sub mH mI mW hH hI path` */
export interface OrdinaryStatusEntry extends StatusEntryBase {
  kind: 'ordinary';
  /** Index status (`.` = unmodified). */
  x: string;
  /** Worktree status (`.` = unmodified). */
  y: string;
  sub: string;
  modeHead: string;
  modeIndex: string;
  modeWorktree: string;
  oidHead: string;
  oidIndex: string;
}

/** `2 XY sub mH mI mW hH hI Xscore path NUL origPath` */
export interface RenamedStatusEntry extends Omit<OrdinaryStatusEntry, 'kind'> {
  kind: 'renamed';
  /** `R` or `C` followed by the similarity score, e.g. `R100`. */
  score: string;
  origPath: string;
}

/** `u XY sub m1 m2 m3 mW h1 h2 h3 path` */
export interface UnmergedStatusEntry extends StatusEntryBase {
  kind: 'unmerged';
  x: string;
  y: string;
  sub: string;
  modes: [string, string, string, string];
  oids: [string, string, string];
}

/** `? path` */
export interface UntrackedStatusEntry extends StatusEntryBase {
  kind: 'untracked';
}

/** `! path` */
export interface IgnoredStatusEntry extends StatusEntryBase {
  kind: 'ignored';
}

export type StatusEntry =
  | OrdinaryStatusEntry
  | RenamedStatusEntry
  | UnmergedStatusEntry
  | UntrackedStatusEntry
  | IgnoredStatusEntry;

export interface StatusResult {
  branch: StatusBranch;
  entries: StatusEntry[];
  /** The raw `# ...` header tokens, in output order (without their NUL). */
  header: string[];
}

export class StatusParseError extends Error {
  override name = 'StatusParseError';
}

/**
 * Parses `git status --porcelain=v2 -z [--branch]` output given as a bstr (raw bytes in a
 * latin1 string), so paths that are not UTF-8 survive.
 */
export function parseStatusV2(output: string): StatusResult {
  const branch: StatusBranch = {
    oid: null,
    head: null,
    detached: false,
    upstream: null,
    ahead: null,
    behind: null,
  };
  const entries: StatusEntry[] = [];
  const header: string[] = [];
  const tokens = splitNul(output);

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as string;
    if (token.length === 0) continue;
    const tag = token[0];
    switch (tag) {
      case '#': {
        parseHeader(token, branch);
        header.push(token);
        break;
      }
      case '1': {
        const parsed = splitFields(token, 8);
        if (!parsed) throw new StatusParseError(`malformed status entry: ${token}`);
        const [, xy = '', sub = '', mH = '', mI = '', mW = '', hH = '', hI = ''] = parsed.fields;
        entries.push({
          kind: 'ordinary',
          x: xy[0] ?? '.',
          y: xy[1] ?? '.',
          sub,
          modeHead: mH,
          modeIndex: mI,
          modeWorktree: mW,
          oidHead: hH,
          oidIndex: hI,
          path: parsed.rest,
          line: token,
        });
        break;
      }
      case '2': {
        const parsed = splitFields(token, 9);
        const origPath = tokens[i + 1];
        if (!parsed || origPath === undefined) {
          throw new StatusParseError(`malformed status rename entry: ${token}`);
        }
        i += 1;
        const [, xy = '', sub = '', mH = '', mI = '', mW = '', hH = '', hI = '', score = ''] =
          parsed.fields;
        entries.push({
          kind: 'renamed',
          x: xy[0] ?? '.',
          y: xy[1] ?? '.',
          sub,
          modeHead: mH,
          modeIndex: mI,
          modeWorktree: mW,
          oidHead: hH,
          oidIndex: hI,
          score,
          path: parsed.rest,
          origPath,
          line: `${token}\u0000${origPath}`,
        });
        break;
      }
      case 'u': {
        const parsed = splitFields(token, 10);
        if (!parsed) throw new StatusParseError(`malformed status unmerged entry: ${token}`);
        const [, xy = '', sub = '', m1 = '', m2 = '', m3 = '', mW = '', h1 = '', h2 = '', h3 = ''] =
          parsed.fields;
        entries.push({
          kind: 'unmerged',
          x: xy[0] ?? 'U',
          y: xy[1] ?? 'U',
          sub,
          modes: [m1, m2, m3, mW],
          oids: [h1, h2, h3],
          path: parsed.rest,
          line: token,
        });
        break;
      }
      case '?':
        entries.push({ kind: 'untracked', path: token.slice(2), line: token });
        break;
      case '!':
        entries.push({ kind: 'ignored', path: token.slice(2), line: token });
        break;
      default:
        throw new StatusParseError(`unknown status entry: ${token}`);
    }
  }
  return { branch, entries, header };
}

function parseHeader(token: string, branch: StatusBranch): void {
  const space = token.indexOf(' ', 2);
  const key = space < 0 ? token.slice(2) : token.slice(2, space);
  const value = space < 0 ? '' : token.slice(space + 1);
  switch (key) {
    case 'branch.oid':
      branch.oid = value === '(initial)' ? null : value;
      break;
    case 'branch.head':
      if (value === '(detached)') {
        branch.head = null;
        branch.detached = true;
      } else {
        branch.head = value;
        branch.detached = false;
      }
      break;
    case 'branch.upstream':
      branch.upstream = value || null;
      break;
    case 'branch.ab': {
      const match = /^\+(\d+) -(\d+)$/.exec(value);
      if (match) {
        branch.ahead = Number(match[1]);
        branch.behind = Number(match[2]);
      }
      break;
    }
    default:
      // e.g. `# stash <n>`; ignored.
      break;
  }
}
