/**
 * The WSL backend's pure rules (docs/DESKTOP.md §11, roadmap #22): reading `wsl.exe -l -v`, the
 * prerequisite probe that runs inside the distro, and the `wsl.exe` argument arrays. No I/O here:
 * `wsl-backend.ts` runs these through an injected `run`, `main.ts` wires it to `child_process`.
 *
 * Command lines (DECISIONS #614): every `wsl.exe` call is an argv array (no shell on the Windows
 * side, Node quotes each element); the distro is its own argument after `-d` and must pass
 * `isSafeDistroName`; `--exec` runs the program directly (no Linux shell re-parses a command line,
 * unlike `wsl.exe -- …`). The probe's script goes to `/bin/sh -s` on stdin, never on the command
 * line; `serve` runs as `/usr/bin/env PATH=<probed PATH> <absolute CLI path> serve …`.
 *
 * Distro listing adapted in part from T3 Code (`apps/desktop/src/wsl/wslPathParsing.ts`,
 * `parseWslDistroList`, MIT, Copyright (c) 2026 T3 Tools Inc.): the UTF-16LE detection by NUL
 * bytes and the "*" default marker. Ours also parses by the header's columns (localized headers and
 * states), checks names before they can reach a command line, and marks tool-owned distros.
 */
import { ServeReadyNonceSchema } from '@octopus-diff/contracts';

export const WSL_EXE = 'wsl.exe';
export const WSL_LIST_ARGS: readonly string[] = ['--list', '--verbose'];

export interface WslDistro {
  name: string;
  state: 'running' | 'stopped' | 'other';
  /** The state as `wsl.exe` printed it (localized). */
  stateText: string;
  version: 1 | 2;
  isDefault: boolean;
  /** docker-desktop and the like: not offered in the picker. */
  system: boolean;
}

/**
 * `wsl.exe`'s output as text. It writes UTF-16LE to a pipe (no BOM; NULs in every odd byte for
 * ASCII), or UTF-8 when `WSL_UTF8=1` is set. A BOM, if any, is dropped.
 */
export function decodeWslText(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let utf16 = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe;
  if (!utf16 && buf.length >= 2) {
    const sample = buf.subarray(0, Math.min(buf.length, 200));
    let oddNuls = 0;
    let evenNuls = 0;
    for (let i = 0; i < sample.length; i++) {
      if (sample[i] !== 0) continue;
      if (i % 2 === 1) oddNuls++;
      else evenNuls++;
    }
    utf16 = oddNuls > 0 && oddNuls >= sample.length / 4 && evenNuls < oddNuls / 4;
  }
  const text = buf.toString(utf16 ? 'utf16le' : 'utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

const SYSTEM_DISTRO = /^(docker-desktop(-data)?|rancher-desktop(-data)?|podman-machine(-.+)?)$/i;

export function isSystemDistro(name: string): boolean {
  return SYSTEM_DISTRO.test(name);
}

/**
 * A name that may go after `wsl.exe -d`: 1-64 letters, digits and `_`, with `.`, `-` and single
 * spaces inside; never a leading `-` (an option), no quotes, slashes, shell or control characters.
 */
export function isSafeDistroName(name: string): boolean {
  return /^[\p{L}\p{N}_](?:[\p{L}\p{N}_. -]{0,62}[\p{L}\p{N}_.-])?$/u.test(name);
}

function stateOf(text: string): WslDistro['state'] {
  const t = text.toLowerCase();
  if (t === 'running') return 'running';
  if (t === 'stopped') return 'stopped';
  return 'other';
}

interface Row {
  name: string;
  stateText: string;
  version: string;
}

/** Column starts of the header line (groups separated by two or more spaces). */
function headerColumns(line: string): [number, number, number] | null {
  const starts: number[] = [];
  const re = /\S+(?: \S+)*/g;
  for (let m = re.exec(line); m; m = re.exec(line)) starts.push(m.index);
  if (starts.length !== 3) return null;
  return [starts[0] ?? 0, starts[1] ?? 0, starts[2] ?? 0];
}

function byColumns(line: string, cols: [number, number, number]): Row | null {
  const [, s1, s2] = cols;
  // The cuts must fall on spaces, or this line is not aligned with the header.
  if (line.length <= s2 || line[s1 - 1] !== ' ' || line[s2 - 1] !== ' ') return null;
  const row = {
    name: line.slice(2, s1).trim(),
    stateText: line.slice(s1, s2).trim(),
    version: line.slice(s2).trim(),
  };
  return row.name && row.stateText && row.version ? row : null;
}

function byFields(line: string): Row | null {
  const fields = line
    .slice(2)
    .trim()
    .split(/\s{2,}/);
  if (fields.length < 3) return null;
  return {
    name: fields[0] ?? '',
    stateText: fields.slice(1, -1).join(' '),
    version: fields[fields.length - 1] ?? '',
  };
}

/** The distros in `wsl.exe -l -v` output (bytes or decoded text); unparseable lines are skipped. */
export function parseWslList(output: Uint8Array | string): WslDistro[] {
  const text = typeof output === 'string' ? output : decodeWslText(output);
  const lines = text
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stray NULs of a mis-decoded UTF-16
    .replace(/\u0000/g, '')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '');
  let cols: [number, number, number] | null = null;
  const out: WslDistro[] = [];
  const seen = new Set<string>();
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const isDefault = line.startsWith('*');
    const row = (cols && byColumns(line, cols)) ?? byFields(line);
    if (!row || (row.version !== '1' && row.version !== '2')) {
      // The first line that is not a distro is the (localized) header: its columns line up.
      if (!cols && !isDefault && out.length === 0) cols = headerColumns(line);
      continue;
    }
    if (!isSafeDistroName(row.name) || seen.has(row.name)) continue;
    seen.add(row.name);
    out.push({
      name: row.name,
      state: stateOf(row.stateText),
      stateText: row.stateText,
      version: row.version === '1' ? 1 : 2,
      isDefault,
      system: isSystemDistro(row.name),
    });
  }
  return out;
}

function assertDistro(distro: string): void {
  if (!isSafeDistroName(distro)) throw new Error('not a valid WSL distro name');
}

/** `wsl.exe` arguments that run the probe: the script is written to stdin (`WSL_PROBE_SCRIPT`). */
export function wslProbeArgs(distro: string): string[] {
  assertDistro(distro);
  return ['-d', distro, '--cd', '~', '--exec', '/bin/sh', '-s'];
}

/**
 * The probe (POSIX sh, on stdin). Read-only: it asks the user's login shell for its PATH (an
 * interactive login shell, with stdin from /dev/null and a timeout, as `shell-env.ts` does on
 * macOS/Linux: nvm and friends only set PATH there), then where `octopus-diff`, `node` and `git` are
 * and their versions, and whether this CLI knows `--ready-stdout`. Answers are lines
 * `RS "od:" key "=" value`; the last is `od:end=1`. It installs, writes and changes nothing.
 */
export const WSL_PROBE_SCRIPT =
  String.raw`# octopus-diff desktop: WSL prerequisite probe (read-only)
od_rs=$(printf '\036')
od_say() { printf '%sod:%s=%s\n' "$od_rs" "$1" "$2"; }
od_shell=$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f7)
if [ -z "$od_shell" ] || [ ! -x "$od_shell" ]; then od_shell=/bin/sh; fi
od_ask='printf "\n\036od-path=%s\n" "$PATH"'
if command -v timeout >/dev/null 2>&1; then
  od_out=$(timeout 15 "$od_shell" -ilc "$od_ask" </dev/null 2>/dev/null)
else
  od_out=$("$od_shell" -lc "$od_ask" </dev/null 2>/dev/null)
fi
od_path=
while IFS= read -r od_l; do
  case $od_l in
    *"$od_rs"od-path=*) od_path=%{od_l#*"$od_rs"od-path=} ;;
  esac
done <<OD_EOF
$od_out
OD_EOF
if [ -n "$od_path" ]; then PATH=$od_path; export PATH; fi
od_say path "$PATH"
od_say home "$HOME"
if [ -x /usr/bin/env ]; then od_say env /usr/bin/env; fi
od_c=$(command -v octopus-diff 2>/dev/null) && od_say cli "$od_c"
od_v=$(node --version 2>/dev/null) && od_say node "$od_v"
od_g=$(git --version 2>/dev/null) && od_say git "$od_g"
if [ -n "$od_c" ]; then
  od_cv=$("$od_c" --version 2>/dev/null) && od_say cliVersion "$od_cv"
  if "$od_c" serve --help 2>/dev/null | grep -q -e '--ready-stdout'; then od_say readyStdout 1; fi
fi
od_say end 1
`.replaceAll('%{', '${'); // (a template literal cannot hold the sh "${" itself)

export interface WslProbe {
  /** The login shell's PATH (or the default one). */
  path: string | null;
  home: string | null;
  /** `command -v octopus-diff`. */
  cli: string | null;
  cliVersion: string | null;
  /** `node --version`, e.g. `v24.1.0`. */
  node: string | null;
  /** `git --version`, e.g. `git version 2.43.0`. */
  git: string | null;
  /** The CLI's `serve --help` lists `--ready-stdout`. */
  readyStdout: boolean;
  /** `/usr/bin/env`, when it exists. */
  env: string | null;
}

const PROBE_KEYS = ['path', 'home', 'cli', 'cliVersion', 'node', 'git', 'readyStdout', 'env'];

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it finds
const hasControl = (value: string) => /[\u0000-\u001f\u007f]/.test(value);

/** The probe's answers, or null when it did not finish (no `od:end`). */
export function parseWslProbe(stdout: string): WslProbe | null {
  const values = new Map<string, string | null>();
  let ended = false;
  for (const raw of stdout.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    // At the line start, or after noise a shell printed without a newline (a title escape).
    const at = line.indexOf('\u001eod:');
    if (at === -1) continue;
    const body = line.slice(at + 4);
    const eq = body.indexOf('=');
    if (eq === -1) continue;
    const key = body.slice(0, eq);
    const value = body.slice(eq + 1);
    if (key === 'end') {
      ended = true;
      continue;
    }
    if (!PROBE_KEYS.includes(key) || values.has(key)) continue;
    values.set(key, value === '' || hasControl(value) ? null : value);
  }
  if (!ended) return null;
  const get = (key: string) => values.get(key) ?? null;
  return {
    path: get('path'),
    home: get('home'),
    cli: get('cli'),
    cliVersion: get('cliVersion'),
    node: get('node'),
    git: get('git'),
    readyStdout: get('readyStdout') === '1',
    env: get('env'),
  };
}

export type WslProblemKind =
  | 'cli-missing'
  | 'cli-path'
  | 'cli-old'
  | 'node-missing'
  | 'node-old'
  | 'git-missing'
  | 'git-old'
  | 'env-missing';

export interface WslProblem {
  kind: WslProblemKind;
  /** One or two sentences. */
  text: string;
  /** Commands to copy (shown monospaced); never run by the app. */
  commands: string[];
}

function versionParts(text: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

function atLeast(text: string, min: string): boolean {
  const have = versionParts(text);
  const want = versionParts(min);
  if (!have || !want) return false;
  for (let i = 0; i < 3; i++) {
    if ((have[i] ?? 0) !== (want[i] ?? 0)) return (have[i] ?? 0) > (want[i] ?? 0);
  }
  return true;
}

/** A CLI path that can follow `/usr/bin/env`: absolute, no `=` (env would take it as a variable). */
export function isUsableCliPath(p: string): boolean {
  return p.startsWith('/') && !p.includes('=') && !hasControl(p);
}

const NODE_COMMANDS = ['nvm install 24', 'nvm alias default 24'];
const CLI_COMMANDS = [
  'git clone <the octopus-diff repository> octopus-diff && cd octopus-diff',
  'pnpm install && pnpm build',
  'cd apps/cli && pnpm link --global',
];

/** What is missing in the distro, in order (CLI, Node, git, env), with what to run there. */
export function wslProblems(
  probe: WslProbe,
  mins: { minNode: number; minGit: string },
): WslProblem[] {
  const problems: WslProblem[] = [];
  if (probe.cli === null) {
    problems.push({
      kind: 'cli-missing',
      text:
        'The octopus-diff command is not on the PATH of your login shell in the distro. It is ' +
        'not on npm yet: build it from a checkout inside the distro and link it (or install a ' +
        'tarball with npm install -g octopus-diff-<version>.tgz):',
      commands: CLI_COMMANDS,
    });
  } else if (!isUsableCliPath(probe.cli)) {
    problems.push({
      kind: 'cli-path',
      text: `octopus-diff was found at "${probe.cli}", a path the app cannot pass on safely (it must be absolute and contain no "="). Install it under a plain path:`,
      commands: CLI_COMMANDS.slice(2),
    });
  } else if (!probe.readyStdout) {
    problems.push({
      kind: 'cli-old',
      text: `The octopus-diff in the distro${probe.cliVersion ? ` (${probe.cliVersion})` : ''} is too old for the app: its serve has no --ready-stdout. Update the checkout and rebuild:`,
      commands: ['git pull && pnpm install && pnpm build'],
    });
  }
  if (probe.node === null) {
    problems.push({
      kind: 'node-missing',
      text: `Node.js ${mins.minNode} or newer is needed in the distro (https://nodejs.org), for example with nvm:`,
      commands: NODE_COMMANDS,
    });
  } else if (!atLeast(probe.node.replace(/^v/, ''), `${mins.minNode}.0.0`)) {
    problems.push({
      kind: 'node-old',
      text: `Node.js ${probe.node} is too old: ${mins.minNode} or newer is needed, for example with nvm:`,
      commands: NODE_COMMANDS,
    });
  }
  if (probe.git === null) {
    problems.push({
      kind: 'git-missing',
      text: `git ${mins.minGit} or newer is needed in the distro:`,
      commands: ['sudo apt install git', 'sudo dnf install git'],
    });
  } else if (!atLeast(probe.git, mins.minGit)) {
    problems.push({
      kind: 'git-old',
      text: `${probe.git} is older than ${mins.minGit}. Update it with the distro's package manager:`,
      commands: ['sudo apt update && sudo apt install git'],
    });
  }
  if (probe.env === null) {
    problems.push({
      kind: 'env-missing',
      text: '/usr/bin/env is missing in the distro (it comes with coreutils):',
      commands: ['sudo apt install coreutils'],
    });
  }
  return problems;
}

export interface WslServeInput {
  distro: string;
  /** The probe's PATH (the login shell's). */
  path: string;
  /** The probe's absolute `octopus-diff`. */
  cli: string;
  /** This run's ready nonce (`--ready-stdout`). */
  nonce: string;
  /** `--port` for the daemon (the app's `--port`), or null for its default. */
  port: number | null;
}

/**
 * `wsl.exe` arguments that run `serve` in the distro: the ready frame on stdout (fds above 2 do
 * not cross `wsl.exe`), the stdin lifeline, and `--host 127.0.0.1` explicitly, so a `host` in the
 * distro's config file cannot put the daemon on the LAN (DECISIONS #615).
 */
export function wslServeArgs(input: WslServeInput): string[] {
  assertDistro(input.distro);
  if (!input.cli.startsWith('/')) throw new Error('the CLI path must be absolute');
  if (hasControl(input.cli) || hasControl(input.path)) {
    throw new Error('the CLI path and PATH must not contain control characters');
  }
  if (input.cli.includes('=')) throw new Error('the CLI path must not contain "="');
  if (!ServeReadyNonceSchema.safeParse(input.nonce).success) throw new Error('invalid nonce');
  if (
    input.port !== null &&
    (!Number.isInteger(input.port) || input.port < 0 || input.port > 65_535)
  ) {
    throw new Error('invalid port');
  }
  return [
    '-d',
    input.distro,
    '--cd',
    '~',
    '--exec',
    '/usr/bin/env',
    `PATH=${input.path}`,
    input.cli,
    'serve',
    '--ready-stdout',
    input.nonce,
    '--exit-with-stdin',
    '--no-open',
    '--host',
    '127.0.0.1',
    ...(input.port !== null ? ['--port', String(input.port)] : []),
  ];
}
