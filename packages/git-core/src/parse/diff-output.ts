/**
 * Parser for `git diff --raw --numstat [-p] -z` output (bstr), streaming.
 *
 * Layout: raw entries, then numstat entries, then (only when `-p` is included) one empty
 * NUL-terminated token as separator, then the patch text. With `-z` every raw/numstat field
 * that is a path is its own NUL-terminated token, so paths are consumed positionally and can
 * contain any byte. Combined-diff raw lines (`::`, emitted for unmerged paths when comparing
 * the index with the worktree) have no numstat entry.
 */

export interface RawEntry {
  srcMode: string;
  dstMode: string;
  srcOid: string;
  dstOid: string;
  /** `A` `C` `D` `M` `R` `T` `U` `X` (combined entries are reported as `U`). */
  status: string;
  /** Similarity score for `R`/`C`, else null. */
  score: number | null;
  /** Source path (bstr); equals `path` unless renamed or copied. */
  srcPath: string;
  /** Destination path (bstr). */
  path: string;
  /** A combined-diff (`::`) entry for an unmerged path. */
  combined: boolean;
  /** The raw metadata token, for hashing. */
  meta: string;
}

export interface NumstatEntry {
  /** Null for binary files. */
  added: number | null;
  deleted: number | null;
  path: string;
  srcPath: string | null;
}

export class DiffParseError extends Error {
  override name = 'DiffParseError';
}

type Pending =
  | { kind: 'raw'; entry: RawEntry; paths: string[]; needed: number }
  | { kind: 'numstat'; entry: NumstatEntry; paths: string[] };

const NUMSTAT = /^(\d+|-)\t(\d+|-)\t/;

function parseRawMeta(token: string): { entry: RawEntry; paths: number } {
  let colons = 0;
  while (token[colons] === ':') colons += 1;
  const fields = token.slice(colons).split(' ');
  if (colons > 1) {
    const parents = colons;
    const modes = fields.slice(0, parents + 1);
    const oids = fields.slice(parents + 1, 2 * parents + 2);
    if (modes.length !== parents + 1 || oids.length !== parents + 1) {
      throw new DiffParseError(`malformed combined raw entry: ${token}`);
    }
    return {
      entry: {
        srcMode: modes[0] as string,
        dstMode: modes[parents] as string,
        srcOid: oids[0] as string,
        dstOid: oids[parents] as string,
        status: 'U',
        score: null,
        srcPath: '',
        path: '',
        combined: true,
        meta: token,
      },
      paths: 1,
    };
  }
  const [srcMode, dstMode, srcOid, dstOid, statusField] = fields;
  if (!srcMode || !dstMode || !srcOid || !dstOid || !statusField) {
    throw new DiffParseError(`malformed raw entry: ${token}`);
  }
  const status = statusField[0] as string;
  const scoreText = statusField.slice(1);
  const score = scoreText.length > 0 ? Number.parseInt(scoreText, 10) : null;
  return {
    entry: {
      srcMode,
      dstMode,
      srcOid,
      dstOid,
      status,
      score: Number.isFinite(score) ? score : null,
      srcPath: '',
      path: '',
      combined: false,
      meta: token,
    },
    paths: status === 'R' || status === 'C' ? 2 : 1,
  };
}

function toCount(value: string): number | null {
  return value === '-' ? null : Number(value);
}

export class DiffOutputParser {
  readonly raw: RawEntry[] = [];
  readonly numstat: NumstatEntry[] = [];
  private buffer = '';
  private phase: 'head' | 'patch' = 'head';
  private pending: Pending | null = null;

  /** @param onPatch receives the patch text (bstr) that follows the head, if any. */
  constructor(private readonly onPatch?: (data: string) => void) {}

  write(data: string): void {
    if (this.phase === 'patch') {
      this.onPatch?.(data);
      return;
    }
    this.buffer += data;
    let start = 0;
    for (;;) {
      const nul = this.buffer.indexOf('\u0000', start);
      if (nul < 0) break;
      const token = this.buffer.slice(start, nul);
      start = nul + 1;
      if (this.consume(token)) {
        this.phase = 'patch';
        const rest = this.buffer.slice(start);
        this.buffer = '';
        if (rest.length > 0) this.onPatch?.(rest);
        return;
      }
    }
    this.buffer = this.buffer.slice(start);
  }

  end(): void {
    if (this.phase === 'head') {
      if (this.pending) throw new DiffParseError('truncated diff output');
      if (this.buffer.length > 0) {
        throw new DiffParseError('unterminated token in diff output');
      }
    }
  }

  /** Returns true when the separator before the patch was consumed. */
  private consume(token: string): boolean {
    const pending = this.pending;
    if (pending) {
      pending.paths.push(token);
      if (pending.kind === 'raw') {
        if (pending.paths.length === pending.needed) {
          const [first = '', second] = pending.paths;
          pending.entry.srcPath = first;
          pending.entry.path = second ?? first;
          this.raw.push(pending.entry);
          this.pending = null;
        }
      } else if (pending.paths.length === 2) {
        pending.entry.srcPath = pending.paths[0] as string;
        pending.entry.path = pending.paths[1] as string;
        this.numstat.push(pending.entry);
        this.pending = null;
      }
      return false;
    }
    if (token.length === 0) return true;
    if (token[0] === ':') {
      const { entry, paths } = parseRawMeta(token);
      this.pending = { kind: 'raw', entry, paths: [], needed: paths };
      return false;
    }
    const match = NUMSTAT.exec(token);
    if (!match) throw new DiffParseError(`unexpected token in diff output: ${token.slice(0, 80)}`);
    const path = token.slice(match[0].length);
    const entry: NumstatEntry = {
      added: toCount(match[1] as string),
      deleted: toCount(match[2] as string),
      path,
      srcPath: null,
    };
    if (path.length === 0) this.pending = { kind: 'numstat', entry, paths: [] };
    else this.numstat.push(entry);
    return false;
  }
}

/** Parses complete `--raw --numstat -z` output (no patch). */
export function parseRawNumstat(output: string): { raw: RawEntry[]; numstat: NumstatEntry[] } {
  const parser = new DiffOutputParser();
  parser.write(output);
  parser.end();
  return { raw: parser.raw, numstat: parser.numstat };
}
