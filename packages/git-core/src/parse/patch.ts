/**
 * Splitting a multi-file unified diff (bstr) into per-file chunks, keyed by the file's path.
 *
 * Chunks start at lines beginning with `diff --git `, `diff --cc `, `diff --combined ` or
 * `* Unmerged path `. Body lines of a patch always start with ` `, `+`, `-`, `\` or `@`, and
 * extended header lines never start with `diff --`, so these markers cannot occur inside a
 * chunk. A typechange produces two consecutive chunks for the same path; consumers that key
 * by path concatenate them.
 */

export type ChunkKind = 'git' | 'cc' | 'unmerged';

export interface ChunkInfo {
  kind: ChunkKind;
  /** Destination path (bstr), without the `b/` prefix. */
  key: string;
  /** Source path (bstr) for renames and copies, else null. */
  srcKey: string | null;
}

export interface ChunkSink {
  write(data: string): void;
  end(): void;
}

const START_MARKERS = ['diff --git ', 'diff --cc ', 'diff --combined ', '* Unmerged path '];
const NEWLINE_MARKERS = START_MARKERS.map((marker) => `\n${marker}`);
const MAX_MARKER_LENGTH = Math.max(...START_MARKERS.map((marker) => marker.length));
const BODY_PREFIXES = ['@@', 'Binary files ', 'GIT binary patch'];
const MAX_HEADER = 1024 * 1024;

function isChunkStart(line: string): boolean {
  return START_MARKERS.some((marker) => line.startsWith(marker));
}

const ESCAPES: Record<string, string> = {
  a: '\x07',
  b: '\b',
  t: '\t',
  n: '\n',
  v: '\v',
  f: '\f',
  r: '\r',
  '"': '"',
  '\\': '\\',
};

/**
 * Parses a C-style quoted string as git writes it (`quote_c_style`) starting at `start`
 * (which must be `"`). Returns the unquoted bstr and the index after the closing quote.
 */
export function parseQuoted(value: string, start: number): { text: string; end: number } | null {
  if (value[start] !== '"') return null;
  let out = '';
  let i = start + 1;
  while (i < value.length) {
    const ch = value[i] as string;
    if (ch === '"') return { text: out, end: i + 1 };
    if (ch !== '\\') {
      out += ch;
      i += 1;
      continue;
    }
    const next = value[i + 1];
    if (next === undefined) return null;
    if (next >= '0' && next <= '7') {
      const octal = value.slice(i + 1, i + 4);
      if (!/^[0-7]{3}$/.test(octal)) return null;
      out += String.fromCharCode(Number.parseInt(octal, 8) & 0xff);
      i += 4;
      continue;
    }
    const escaped = ESCAPES[next];
    if (escaped === undefined) return null;
    out += escaped;
    i += 2;
  }
  return null;
}

/** Unquotes a whole value if it is C-quoted; otherwise returns it unchanged. */
export function unquoteMaybe(value: string): string {
  if (value.startsWith('"')) {
    const parsed = parseQuoted(value, 0);
    if (parsed && parsed.end === value.length) return parsed.text;
  }
  return value;
}

function stripPrefix(name: string, prefix: string): string {
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/** Parses `a/<old> b/<new>` from a `diff --git` line (git's own ambiguity rules). */
function parseGitNames(rest: string): { a: string; b: string } | null {
  if (rest.startsWith('"')) {
    const first = parseQuoted(rest, 0);
    if (!first || rest[first.end] !== ' ') return null;
    const second = rest.slice(first.end + 1);
    return { a: first.text, b: unquoteMaybe(second) };
  }
  if (rest.endsWith('"')) {
    // Unquoted a-name, quoted b-name: find the opening quote of the last token.
    for (let i = rest.lastIndexOf(' "'); i > 0; i = rest.lastIndexOf(' "', i - 1)) {
      const parsed = parseQuoted(rest, i + 1);
      if (parsed && parsed.end === rest.length) return { a: rest.slice(0, i), b: parsed.text };
    }
    return null;
  }
  // Both unquoted: identical names are the only unambiguous case (`a/P b/P`).
  if ((rest.length - 1) % 2 === 0) {
    const half = (rest.length - 1) / 2;
    const a = rest.slice(0, half);
    const b = rest.slice(half + 1);
    if (
      rest[half] === ' ' &&
      a.startsWith('a/') &&
      b.startsWith('b/') &&
      a.slice(2) === b.slice(2)
    ) {
      return { a, b };
    }
  }
  return null;
}

function headerValue(lines: readonly string[], prefix: string): string | null {
  for (const line of lines) {
    if (line.startsWith(prefix)) return unquoteMaybe(line.slice(prefix.length));
  }
  return null;
}

function fileLineName(lines: readonly string[], prefix: '--- ' | '+++ '): string | null {
  for (const line of lines) {
    if (!line.startsWith(prefix)) continue;
    let name = line.slice(4);
    if (name.endsWith('\t')) name = name.slice(0, -1);
    name = unquoteMaybe(name);
    if (name === '/dev/null') return null;
    return stripPrefix(name, prefix === '--- ' ? 'a/' : 'b/');
  }
  return null;
}

/** Identifies the file of a chunk from its header lines (without trailing newlines). */
export function parseChunkHeader(lines: readonly string[]): ChunkInfo | null {
  const first = lines[0];
  if (first === undefined) return null;
  if (first.startsWith('* Unmerged path ')) {
    // git prints this name unquoted, and this "chunk" is a single line: any further header
    // lines are the rest of a name that contains newlines.
    const name = [first.slice('* Unmerged path '.length), ...lines.slice(1)].join('\n');
    return { kind: 'unmerged', key: name, srcKey: null };
  }
  if (first.startsWith('diff --cc ')) {
    return { kind: 'cc', key: unquoteMaybe(first.slice('diff --cc '.length)), srcKey: null };
  }
  if (first.startsWith('diff --combined ')) {
    return { kind: 'cc', key: unquoteMaybe(first.slice('diff --combined '.length)), srcKey: null };
  }
  if (!first.startsWith('diff --git ')) return null;

  const renameTo = headerValue(lines, 'rename to ') ?? headerValue(lines, 'copy to ');
  const renameFrom = headerValue(lines, 'rename from ') ?? headerValue(lines, 'copy from ');
  if (renameTo !== null) {
    return { kind: 'git', key: renameTo, srcKey: renameFrom };
  }
  const names = parseGitNames(first.slice('diff --git '.length));
  if (names) {
    return { kind: 'git', key: stripPrefix(names.b, 'b/'), srcKey: null };
  }
  const plus = fileLineName(lines, '+++ ');
  if (plus !== null) return { kind: 'git', key: plus, srcKey: null };
  const minus = fileLineName(lines, '--- ');
  if (minus !== null) return { kind: 'git', key: minus, srcKey: null };
  return null;
}

/**
 * Streaming splitter. Feed bstr data with `write`; for each chunk, `onChunk` is called once
 * the header is complete and may return a sink that receives the chunk's full text (header
 * included) in pieces, or null to skip the chunk.
 */
export class PatchSplitter {
  private pending = '';
  private midLine = false;
  private mode: 'none' | 'header' | 'body' = 'none';
  private header: string[] = [];
  private headerBytes = 0;
  private sink: ChunkSink | null = null;

  constructor(
    private readonly onChunk: (info: ChunkInfo | null, header: string) => ChunkSink | null,
  ) {}

  write(data: string): void {
    if (data.length === 0) return;
    let text = data;
    if (this.midLine) {
      // Continuation of a body line already known not to start a chunk.
      const newline = text.indexOf('\n');
      if (newline < 0) {
        this.sink?.write(text);
        return;
      }
      this.sink?.write(text.slice(0, newline + 1));
      this.midLine = false;
      text = text.slice(newline + 1);
      if (text.length === 0) return;
    }
    text = this.pending + text;
    this.pending = '';
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline >= 0) {
      this.process(text, lastNewline + 1);
      text = text.slice(lastNewline + 1);
    }
    // `text` is now an incomplete line that starts at a line beginning.
    if (this.mode === 'header' && this.headerBytes + text.length > MAX_HEADER) this.flushHeader();
    if (this.mode === 'body' && text.length >= MAX_MARKER_LENGTH && !isChunkStart(text)) {
      // A long body line (e.g. minified code): stream it instead of buffering it.
      this.sink?.write(text);
      this.midLine = true;
      return;
    }
    this.pending = text;
  }

  end(): void {
    if (this.pending.length > 0) {
      const rest = this.pending;
      this.pending = '';
      this.process(rest, rest.length);
    }
    if (this.mode === 'header') this.flushHeader();
    this.closeChunk();
    this.mode = 'none';
    this.midLine = false;
  }

  /** Processes complete lines in `text[0, end)`. */
  private process(text: string, end: number): void {
    let pos = 0;
    // Where each marker next occurs in `text` (-1: nowhere after; -2: not searched yet). `pos`
    // only grows, so a found index stays valid until passed and an absent marker stays absent:
    // each marker is searched once per pass instead of once per patch (#42: one search of the
    // whole rest per file made a 36k-file diff spend seconds here).
    const nextAt = NEWLINE_MARKERS.map(() => -2);
    while (pos < end) {
      if (this.mode === 'body') {
        const next = this.findChunkStart(text, pos, end, nextAt);
        if (next < 0) {
          this.sink?.write(text.slice(pos, end));
          return;
        }
        if (next > pos) this.sink?.write(text.slice(pos, next));
        pos = next;
        this.closeChunk();
        this.mode = 'none';
        continue;
      }
      const newline = text.indexOf('\n', pos);
      const lineEnd = newline < 0 || newline >= end ? end : newline + 1;
      const line = text.slice(pos, lineEnd);
      pos = lineEnd;
      this.processHeaderLine(line);
    }
  }

  private processHeaderLine(line: string): void {
    if (isChunkStart(line)) {
      if (this.mode === 'header') this.flushHeader();
      this.closeChunk();
      this.mode = 'header';
      this.header = [line];
      this.headerBytes = line.length;
      return;
    }
    if (this.mode === 'none') return; // Stray text before the first chunk.
    if (BODY_PREFIXES.some((prefix) => line.startsWith(prefix))) {
      this.flushHeader();
      this.sink?.write(line);
      return;
    }
    this.header.push(line);
    this.headerBytes += line.length;
    if (this.headerBytes > MAX_HEADER) this.flushHeader();
  }

  /** Ends the header phase: identifies the chunk and switches to body mode. */
  private flushHeader(): void {
    if (this.mode !== 'header') return;
    const headerText = this.header.join('');
    const lines = this.header.map((line) => (line.endsWith('\n') ? line.slice(0, -1) : line));
    const info = parseChunkHeader(lines);
    this.sink = this.onChunk(info, headerText);
    this.sink?.write(headerText);
    this.header = [];
    this.headerBytes = 0;
    this.mode = 'body';
  }

  private closeChunk(): void {
    if (this.sink) {
      this.sink.end();
      this.sink = null;
    }
  }

  /** Index of the next chunk start at a line beginning within `[pos, end)`, or -1. */
  private findChunkStart(text: string, pos: number, end: number, nextAt: number[]): number {
    if (pos === 0 || text[pos - 1] === '\n') {
      if (START_MARKERS.some((marker) => text.startsWith(marker, pos))) return pos;
    }
    let best = -1;
    for (let m = 0; m < NEWLINE_MARKERS.length; m++) {
      let index = nextAt[m] as number;
      if (index === -2 || (index >= 0 && index < pos)) {
        index = text.indexOf(NEWLINE_MARKERS[m] as string, pos);
        nextAt[m] = index;
      }
      if (index >= 0 && index + 1 < end && (best < 0 || index + 1 < best)) best = index + 1;
    }
    return best;
  }
}

/** Splits a complete patch into chunks (convenience wrapper; consecutive same-key chunks merge). */
export function splitPatch(patch: string): Array<ChunkInfo & { text: string }> {
  const chunks: Array<ChunkInfo & { text: string }> = [];
  const splitter = new PatchSplitter((info) => {
    if (!info) return null;
    const last = chunks[chunks.length - 1];
    const target =
      last && last.key === info.key && last.kind === info.kind
        ? last
        : (() => {
            const created = { ...info, text: '' };
            chunks.push(created);
            return created;
          })();
    return {
      write(data: string) {
        target.text += data;
      },
      end() {},
    };
  });
  splitter.write(patch);
  splitter.end();
  return chunks;
}
