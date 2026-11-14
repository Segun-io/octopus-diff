// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the mutations are source text that contains `${…}`.
// Mutation check for the rules that must not regress silently: the security policy (DESKTOP §5),
// the packaged-build argument rules, the menu accelerator rule, the supervisor's lifecycle (stdin lifeline, RUN_AS_NODE,
// restart/backoff, attach, shutdown escalation, token never logged), the UI load (superseded by sequence, the commit
// watchdog, attempts), the window.octopusDesktop bridge (#20: the sender check, zod, the worktree path check,
// openPath's program refusal, the editor URL allowlist, the preload's user-gesture gate), and the `octopus-diff`
// command's marker, never-overwrite and quoting rules (cli-shim*.ts, #21).
//
//   node apps/desktop/scripts/mutation-check.mjs
//
// Applies one mutation at a time to a source file, runs the matching unit tests, and expects them
// to FAIL ("killed"). A mutation the tests survive is reported and makes the script exit 1. The
// file is always restored (also on Ctrl+C). Run it after changing those rules or their tests.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const e2eRoot = path.resolve(desktopRoot, '..', '..', 'e2e');

// A mutation's file is under apps/desktop/src, or `e2e:<path under e2e/>` with its test as
// `e2e:<name>` (e2e/support/<name>.test.ts, run from e2e/).
const sourcePath = (file) =>
  file.startsWith('e2e:') ? path.join(e2eRoot, file.slice(4)) : path.join(desktopRoot, 'src', file);

/** [file, test file, description, from, to] */
const MUTATIONS = [
  // --- security policy ---
  [
    'policy.ts',
    'policy',
    'navigation: any origin allowed',
    'origin !== null && origin === allowedOrigin',
    'origin !== null',
  ],
  [
    'policy.ts',
    'policy',
    'navigation: allowed with no UI origin',
    "if (allowedOrigin === null) return 'deny';",
    "if (allowedOrigin === null) return 'allow';",
  ],
  [
    'policy.ts',
    'policy',
    'httpOrigin: any scheme',
    "if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;",
    '',
  ],
  [
    'policy.ts',
    'policy',
    'window.open: every URL opened externally',
    'openExternally: httpOrigin(url) === null ? null : url',
    'openExternally: url',
  ],
  [
    'policy.ts',
    'policy',
    'permissions granted',
    'export function permissionPolicy(_permission: string): false {\n  return false;',
    'export function permissionPolicy(_permission: string): false {\n  return true as false;',
  ],
  [
    'policy.ts',
    'policy',
    'contextIsolation off',
    'contextIsolation: true,',
    'contextIsolation: false,',
  ],
  ['policy.ts', 'policy', 'sandbox off', 'sandbox: true,', 'sandbox: false,'],
  [
    'policy.ts',
    'policy',
    'nodeIntegration on',
    '    nodeIntegration: false,',
    '    nodeIntegration: true,',
  ],
  ['policy.ts', 'policy', 'webSecurity off', 'webSecurity: true,', 'webSecurity: false,'],
  ['policy.ts', 'policy', 'webviewTag on', 'webviewTag: false,', 'webviewTag: true,'],
  ['policy.ts', 'policy', 'DevTools always on', '    devTools,\n', '    devTools: true,\n'],
  ['policy.ts', 'policy', 'window shown before ready', 'show: false,', 'show: true,'],
  ['screens.ts', 'misc', 'screens: no HTML escaping', ".replace(/</g, '&lt;')", ''],
  [
    'screens.ts',
    'misc',
    'screens: action from any URL',
    'if (!url.startsWith(SCREEN_ACTION_SCHEME)) return null;',
    '',
  ],
  // --- packaged-build arguments (DECISIONS #502, #507, #509) ---
  [
    'args.ts',
    'args',
    'packaged: debugger switches allowed',
    'if (name !== null && isRefusedPackagedSwitch(name)) {',
    'if (false) {',
  ],
  [
    'args.ts',
    'args',
    'packaged: --dev allowed',
    "if (options.isPackaged) {\n        throw new DesktopArgsError('--dev",
    "if (false) {\n        throw new DesktopArgsError('--dev",
  ],
  [
    'args.ts',
    'args',
    'packaged: --backend source allowed',
    "if (value === 'source' && options.isPackaged) {",
    'if (false) {',
  ],
  [
    'args.ts',
    'args',
    'packaged: --renderer-url allowed',
    "if (options.isPackaged) {\n          throw new DesktopArgsError('--renderer-url",
    "if (false) {\n          throw new DesktopArgsError('--renderer-url",
  ],
  [
    'args.ts',
    'args',
    '--renderer-url: any host',
    'if (!isLoopbackHost(new URL(origin).hostname)) {',
    'if (false) {',
  ],
  ['args.ts', 'args', 'loopback: any first octet', "parts[0] === '127' &&", ''],
  ['args.ts', 'args', 'loopback: octets over 255', 'Number(p) <= 255', 'true'],
  [
    'args.ts',
    'args',
    'switches: inspect* prefix not refused',
    " || name.startsWith('inspect')",
    '',
  ],
  ['args.ts', 'args', 'switches: single dash not read', '/^--?/.exec(arg)', '/^--/.exec(arg)'],
  [
    'args.ts',
    'args',
    'switches: Windows /switch not read',
    "(platform === 'win32' ? /^\\//.exec(arg) : null)",
    'null',
  ],
  [
    'args.ts',
    'args',
    'switches: Windows letter case',
    "return platform === 'win32' ? name.toLowerCase() : name;",
    'return name;',
  ],
  [
    'args.ts',
    'args',
    'switches: only the parsed options checked, not every argv element',
    'for (const arg of argv) {\n      const name = switchName(arg, platform);',
    "for (const arg of argv.filter((a) => a.startsWith('--'))) {\n      const name = switchName(arg, platform);",
  ],
  // --- menus ---
  [
    'menu.ts',
    'menu',
    'accelerators: anything allowed',
    "if (parts.some((p) => p === '')) return false;",
    'return true;',
  ],
  [
    'menu.ts',
    'menu',
    'accelerators: Shift is enough',
    "  'super',\n  'meta',\n]);\n\n/**",
    "  'super',\n  'meta',\n  'shift',\n]);\n\n/**",
  ],
  [
    'menu.ts',
    'menu',
    'Cmd/Ctrl+R reloads the page',
    "{ label: 'Refresh', accelerator: 'CommandOrControl+R', click: () => a.refresh() },",
    "{ role: 'reload' },",
  ],
  ['menu.ts', 'menu', 'DevTools in production menus', '...(input.dev\n', '...(true\n'],
  [
    'menu.ts',
    'menu',
    'a bare-key accelerator',
    "{ label: 'Add Folder…', accelerator: 'CommandOrControl+O'",
    "{ label: 'Add Folder…', accelerator: 'O'",
  ],
  // --- supervisor lifecycle ---
  [
    'backend.ts',
    'backend',
    'no ELECTRON_RUN_AS_NODE',
    "return { ...base, ELECTRON_RUN_AS_NODE: '1' };",
    'return { ...base };',
  ],
  [
    'backend.ts',
    'backend',
    'stdin ignored (no lifeline)',
    "return ['pipe', out, out, 'pipe'];",
    "return ['ignore', out, out, 'pipe'];",
  ],
  [
    'backend.ts',
    'backend',
    'no fd 3 pipe',
    "return ['pipe', out, out, 'pipe'];",
    "return ['pipe', out, out, 'ignore'] as unknown as StdioLike;",
  ],
  [
    'backend.ts',
    'backend',
    'serve without --exit-with-stdin',
    "'--exit-with-stdin', '--no-open', ...extra",
    "'--no-open', ...extra",
  ],
  [
    'backend.ts',
    'backend',
    'quit does not close stdin',
    '      run.child.stdin?.end();',
    '      void 0;',
  ],
  [
    'backend.ts',
    'backend',
    'quit never escalates to SIGKILL',
    "            run.child.kill('SIGKILL');\n          }, this.#policy.killGraceMs),",
    '          }, this.#policy.killGraceMs),',
  ],
  [
    'backend.ts',
    'backend',
    'quit signals right away',
    '      }, this.#policy.stopGraceMs),',
    '      }, 0),',
  ],
  [
    'backend.ts',
    'backend',
    'attach exit counted as a failure',
    "    if (run.ready?.mode === 'attached') {\n      // Expected",
    '    if (false) {\n      // Expected',
  ],
  [
    'backend.ts',
    'backend',
    'attached daemon not polled',
    '      this.#schedulePoll(ready.url);',
    '      void 0;',
  ],
  [
    'backend.ts',
    'backend',
    'one missed poll restarts',
    'if (this.#misses >= this.#policy.attachedMisses) {',
    'if (this.#misses >= 1) {',
  ],
  [
    'backend.ts',
    'backend',
    'never gives up',
    'if (this.#failures >= this.#policy.maxFailures) {',
    'if (false) {',
  ],
  [
    'backend.ts',
    'backend',
    'no backoff growth',
    'const delayMs = backoffDelay(this.#policy, this.#failures);',
    'const delayMs = backoffDelay(this.#policy, 1);',
  ],
  [
    'backend.ts',
    'backend',
    'stable daemon does not reset the count',
    'if (this.#o.timers.now() - run.readyAt >= this.#policy.stableMs) this.#failures = 0;',
    'void 0;',
  ],
  [
    'backend.ts',
    'backend',
    'any lifetime resets the count',
    'if (this.#o.timers.now() - run.readyAt >= this.#policy.stableMs) this.#failures = 0;',
    'this.#failures = 0;',
  ],
  [
    'backend.ts',
    'backend',
    'no ready timeout',
    'if (!run.settled) {\n        this.#attemptFailed(run, `no ready line',
    'if (false) {\n        this.#attemptFailed(run, `no ready line',
  ],
  [
    'backend.ts',
    'backend',
    'restart after a requested stop',
    '    if (this.#stopping) {\n      this.#o.log.note(`backend stopped (${how})`);\n      return;\n    }',
    '',
  ],
  [
    'backend.ts',
    'backend',
    'version mismatch never flagged',
    'const versionMismatch = ready.version !== this.#o.appVersion;',
    'const versionMismatch = false;',
  ],
  [
    'backend.ts',
    'backend',
    'token logged',
    '`backend ready: ${ready.mode} ${ready.url}',
    '`backend ready: ${ready.mode} ${ready.authUrl}',
  ],
  [
    'backend.ts',
    'backend',
    'invalid ready line accepted',
    'const result = ServeReadySchema.safeParse(json);',
    'const result = { success: true as const, data: json as ServeReady, error: undefined as never };',
  ],
  // --- the health answer of a daemon that has left ready (PR #108) ---
  [
    'backend.ts',
    'backend',
    'a health answer is dropped once the daemon left ready',
    "return state?.kind === 'ready' && state.ready === r;",
    "return state?.kind === 'ready';",
  ],
  // --- review of PR #108 (second pair of eyes) ---
  [
    'policy.ts',
    'policy',
    'a load failure note leaks the message (the URL, so the token)',
    "return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,60}$/.test(code) ? code : 'unknown error';",
    "return error instanceof Error ? error.message : 'unknown error';",
  ],
  [
    'screens.ts',
    'misc',
    'a screen button counts on any page',
    "return url.startsWith('data:text/html');",
    'return true;',
  ],
  // --- shell env ---
  [
    'shell-env.ts',
    'shell-env',
    'PATH script with a braced expansion (fish rejects it)',
    '; printenv PATH;',
    '; printf \'%s\' "\\${PATH}";',
  ],
  [
    'shell-env.ts',
    'shell-env',
    'login shell on Windows',
    "if (input.platform === 'win32') {",
    'if (false) {',
  ],
  [
    'shell-env.ts',
    'shell-env',
    'no timeout passed',
    'timeoutMs: input.timeoutMs ?? SHELL_ENV_TIMEOUT_MS,',
    'timeoutMs: 0,',
  ],
  // --- window state ---
  [
    'window-state.ts',
    'window-state',
    'off-screen bounds restored',
    'if (!best) return null;',
    'if (!best) return b;',
  ],
  [
    'window-state.ts',
    'window-state',
    'no clamping to the display',
    'const x = Math.min(Math.max(b.x, best.x), best.x + best.width - width);',
    'const x = b.x;',
  ],
  // --- the window.octopusDesktop bridge (#20) ---
  // Not mutated: `trusted.origin === null` in senderAllowed and `parsed.host === 'file'` in
  // isAllowedEditorUrl are implied by the origin comparison and the `<scheme>://file/` prefix check
  // (equivalent mutants); they stay as explicit belts.
  [
    'ipc.ts',
    'ipc',
    'bridge: sender origin not checked',
    'return origin !== null && origin === trusted.origin;',
    'return origin !== null;',
  ],
  [
    'ipc.ts',
    'ipc',
    'bridge: another window accepted',
    'if (event.sender.id !== trusted.webContentsId) return false;',
    '',
  ],
  [
    'ipc.ts',
    'ipc',
    'bridge: subframes accepted',
    'if (!frame || frame.parent !== null) return false;',
    'if (!frame) return false;',
  ],
  [
    'ipc.ts',
    'ipc',
    'bridge: handlers skip the sender check',
    'if (!senderAllowed(event, deps.trusted())) return fallback(forbidden(method));',
    '',
  ],
  [
    'ipc.ts',
    'ipc',
    'bridge: handlers skip zod',
    'const parsed = schema.safeParse(raw);\n        if (!parsed.success) return fallback(invalid(method));\n        return run(parsed.data);',
    'return run(raw as never);',
  ],
  [
    'ipc.ts',
    'ipc',
    'bridge: any editor name',
    'editor: z.enum(DESKTOP_EDITORS).optional(),',
    'editor: z.string().optional() as never,',
  ],
  [
    'ipc.ts',
    'ipc',
    'bridge: commands-ready from any sender',
    "        if (!senderAllowed(event, deps.trusted())) {\n          forbidden('commandsReady');\n          return;\n        }\n",
    '',
  ],
  [
    'ipc.ts',
    'ipc',
    'bridge: openPath runs programs',
    "if (unsafe) return note('openPath', unsafe);",
    '',
  ],
  [
    'ipc.ts',
    'ipc',
    'bridge: editor URL not allowlisted',
    'if (url === null || !isAllowedEditorUrl(url)) {',
    'if (url === null) {',
  ],
  [
    'ipc.ts',
    'ipc',
    'bridge: refusals log the message (paths)',
    'deps.log(`bridge: ${method} refused (${refusal.reason})`);',
    'deps.log(`bridge: ${method} refused (${refusal.reason}) ${JSON.stringify(refusal)} ${JSON.stringify(arguments)}`);',
  ],
  [
    'path-guard.ts',
    'path-guard',
    'path check: realpath not checked (symlink escapes)',
    "  if (!isInside(root, real, platform)) {\n    return refuse('outside-worktree', 'The path leads outside its worktree (a symlink).');\n  }\n",
    '',
  ],
  [
    'path-guard.ts',
    'path-guard',
    'path check: string prefix instead of segments',
    "return rel !== '..' && !rel.startsWith(`..${p.sep}`);",
    "return !target.startsWith(root) ? false : rel !== '..' || true;",
  ],
  [
    'path-guard.ts',
    'path-guard',
    'path check: another drive counts as inside',
    '  if (p.isAbsolute(rel)) return false;\n',
    '',
  ],
  [
    'path-guard.ts',
    'path-guard',
    "path check: '..' segments allowed",
    "if (segment === '' || segment === '.' || segment === '..') return null;",
    "if (segment === '') return null;",
  ],
  [
    'path-guard.ts',
    'path-guard',
    'path check: Windows backslash and colon allowed',
    'if (/[\\\\:]/.test(segment)) return null;',
    '',
  ],
  [
    'path-guard.ts',
    'path-guard',
    'path check: missing worktrees used',
    "if (worktree.missing) return refuse('missing-worktree', 'The worktree is gone from disk.');",
    '',
  ],
  [
    'path-guard.ts',
    'path-guard',
    'path check: worktree root not realpathed',
    '    root = await fs.realpath(worktree.path);',
    '    root = worktree.path;',
  ],
  [
    'open-safety.ts',
    'path-guard',
    'openPath: executable types allowed',
    'if (UNSAFE_OPEN_EXTENSIONS.has(extensionOf(target.path, platform))) return unsafe;',
    '',
  ],
  [
    'open-safety.ts',
    'path-guard',
    'openPath: execute bit ignored',
    "if (target.kind === 'file' && platform !== 'win32' && (target.mode & 0o111) !== 0) return unsafe;",
    '',
  ],
  [
    'open-safety.ts',
    'path-guard',
    'openPath: Windows trailing dots not trimmed',
    "if (platform === 'win32') name = name.replace(/[. ]+$/, '');",
    '',
  ],
  [
    'open-safety.ts',
    'path-guard',
    'openPath: sockets and devices allowed',
    "if (target.kind === 'other') return unsafe;",
    '',
  ],
  [
    'editor-url.ts',
    'editor-url',
    'editor URL: any scheme',
    'const editor = DESKTOP_EDITORS.find((e) => url.startsWith(`${e}://file/`));\n  if (!editor) return false;',
    "const editor = url.split(':')[0] ?? '';",
  ],
  [
    'editor-url.ts',
    'editor-url',
    'editor URL: query and fragment allowed',
    "    parsed.search === '' &&\n    parsed.hash === '' &&\n    !url.includes('?') &&\n    !url.includes('#') &&\n",
    '',
  ],
  [
    'editor-url.ts',
    'editor-url',
    'editor URL: segments not encoded',
    "  return `/${rest.map(encodeURIComponent).join('/')}`;\n}",
    "  return `/${rest.join('/')}`;\n}",
  ],
  [
    'bridge.ts',
    'bridge',
    'preload: actions without a user gesture',
    'const action = async (channel: string, args: unknown[]): Promise<DesktopActionResult> => {\n    if (!env.hasUserActivation()) return NO_GESTURE;',
    'const action = async (channel: string, args: unknown[]): Promise<DesktopActionResult> => {',
  ],
  [
    'bridge.ts',
    'bridge',
    'preload: pickFolder without a user gesture',
    '    async pickFolder(options) {\n      if (!env.hasUserActivation()) return null;',
    '    async pickFolder(options) {',
  ],
  [
    'bridge.ts',
    'bridge',
    'preload: copyText without a user gesture',
    '    async copyText(text) {\n      if (!env.hasUserActivation()) return false;',
    '    async copyText(text) {',
  ],
  [
    'bridge.ts',
    'bridge',
    'preload: any command delivered',
    'if (!(DESKTOP_COMMANDS as readonly string[]).includes(command)) return;',
    '',
  ],
  [
    'policy.ts',
    'policy',
    'preload: hiddenInset everywhere',
    "...(input.platform === 'darwin'",
    '...(input.platform !== undefined',
  ],
  [
    'bridge.ts',
    'bridge',
    'preload: installCli without a user gesture',
    "// Writes a file in the user's home: only from a click or key press, like the other actions.\n      if (!env.hasUserActivation()) return failed('Only available from a click or a key press.');",
    '',
  ],
  // --- loading the UI into the window (DECISIONS #591, #594) ---
  [
    'ui-load.ts',
    'ui-load',
    'ERR_ABORTED taken for superseded (the macOS flake)',
    '        // A newer load (a screen, a forced reload) replaced it: whatever the code, not a failure.\n        if (!this.#live()) return;',
    "        if ((error as { code?: unknown } | null)?.code === 'ERR_ABORTED') return;\n        if (!this.#live()) return;",
  ],
  [
    'ui-load.ts',
    'ui-load',
    'a superseded failure still retried',
    '        if (this.#ticket !== ticket) return;\n        // A newer load',
    '        // A newer load',
  ],
  [
    'ui-load.ts',
    'ui-load',
    'no commit watchdog',
    '      if (this.#ticket !== ticket || this.#committed || !this.#live()) return;\n      const state',
    '      return;\n      const state',
  ],
  [
    'ui-load.ts',
    'ui-load',
    'commit does not cancel the retry',
    '    this.#committed = true;\n    this.#clearTimer();',
    '    this.#committed = true;',
  ],
  [
    'ui-load.ts',
    'ui-load',
    'a commit does not stop a watchdog that fires late',
    'if (this.#ticket !== ticket || this.#committed || !this.#live()) return;',
    'if (this.#ticket !== ticket || !this.#live()) return;',
  ],
  [
    'ui-load.ts',
    'ui-load',
    'the watchdog ignores wanted() (quitting, closed window)',
    'if (this.#ticket !== ticket || this.#committed || !this.#live()) return;',
    'if (this.#ticket !== ticket || this.#committed) return;',
  ],
  [
    'ui-load.ts',
    'ui-load',
    'the retry ignores a newer load or wanted()',
    'if (this.#live()) this.#next();',
    'this.#next();',
  ],
  [
    'ui-load.ts',
    'ui-load',
    'a stale attempt resolving ends the current one',
    '        if (this.#ticket !== ticket || !this.#live()) return;\n        this.#clearTimer();\n        this.#done = true;',
    '        if (!this.#live()) return;\n        this.#clearTimer();\n        this.#done = true;',
  ],
  [
    'ui-load.ts',
    'ui-load',
    'committed() of a superseded or cancelled load counts',
    'if (!this.#live() || this.#committed) return;',
    'if (this.#committed) return;',
  ],
  [
    'ui-load.ts',
    'ui-load',
    'committed() twice counts twice',
    'if (!this.#live() || this.#committed) return;',
    'if (!this.#live()) return;',
  ],
  [
    'ui-load.ts',
    'ui-load',
    'the UI still wanted while quitting',
    'return !input.quitting && input.current === input.window && !input.destroyed;',
    'return input.current === input.window && !input.destroyed;',
  ],
  [
    'ui-load.ts',
    'ui-load',
    'failure screen on the first failed attempt',
    'if (attempt >= this.#policy.maxAttempts) {',
    'if (true) {',
  ],
  [
    'ui-load.ts',
    'ui-load',
    'retries for ever',
    'if (attempt >= this.#policy.maxAttempts) {',
    'if (false) {',
  ],
  [
    'ui-load.ts',
    'ui-load',
    'the load error message logged (holds the token)',
    'const note = loadFailureNote(error);',
    'const note = String(error);',
  ],
  [
    'ui-load.ts',
    'ui-load',
    'urlForLog keeps the path and fragment',
    "if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.origin;",
    "if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return url;",
  ],
  // --- the `octopus-diff` command (roadmap #21, DECISIONS #560-): the marker and never-overwrite rules ---
  [
    'cli-shim.ts',
    'cli-shim',
    'marker: every file counts as ours',
    'lines.some((line) => line === `# ${MARKER}` || line === `rem ${MARKER}`)',
    'true',
  ],
  [
    'cli-shim.ts',
    'cli-shim',
    'marker: the text anywhere in the file counts',
    'lines.some((line) => line === `# ${MARKER}` || line === `rem ${MARKER}`)',
    'content.includes(MARKER)',
  ],
  [
    'cli-shim.ts',
    'cli-shim',
    'marker: only the exact comment line is not required',
    'lines.some((line) => line === `# ${MARKER}` || line === `rem ${MARKER}`)',
    'lines.some((line) => line.includes(MARKER))',
  ],
  [
    'cli-shim.ts',
    'cli-shim',
    'marker: searched far down the file',
    'const MARKER_SEARCH_LINES = 4;',
    'const MARKER_SEARCH_LINES = 4000;',
  ],
  [
    'cli-shim.ts',
    'cli-shim',
    'decide: a foreign file at the target is overwritten',
    "if (target.kind !== 'missing' && !(target.kind === 'file' && isOwnLauncher(target.content))) {",
    'if (false) {',
  ],
  [
    'cli-shim.ts',
    'cli-shim',
    'decide: another install on PATH is ignored',
    "if (isCommand) return { action: 'refuse'",
    "if (false) return { action: 'refuse'",
  ],
  [
    'cli-shim.ts',
    'cli-shim',
    'decide: a foreign file on PATH counts as ours',
    "(other.facts.kind === 'file' && !isOwnLauncher(other.facts.content));",
    "(other.facts.kind === 'file' && false);",
  ],
  [
    'cli-shim.ts',
    'cli-shim',
    'decide: a symlink on PATH (npm links its bin) is not an install',
    "other.facts.kind === 'symlink' ||",
    'false ||',
  ],
  [
    'cli-shim.ts',
    'cli-shim',
    'decide: a different launcher is never updated',
    "return target.kind === 'file' && target.content === facts.desired",
    'return true',
  ],
  [
    'cli-shim.ts',
    'cli-shim',
    'PATH candidates: relative entries searched',
    'if (!path.posix.isAbsolute(dir)) return [];',
    '',
  ],
  // quoting and the launchers
  [
    'cli-shim.ts',
    'cli-shim',
    'sh quoting: a single quote is not escaped',
    `value.replaceAll("'", \`'"'"'\`)`,
    'value',
  ],
  [
    'cli-shim.ts',
    'cli-shim',
    'cmd quoting: % not doubled',
    "return value.replaceAll('%', '%%');",
    'return value;',
  ],
  [
    'cli-shim.ts',
    'cli-shim',
    'cmd quoting: a quote or line break in a path accepted',
    'if (/["\\r\\n\\0]/.test(value)) {',
    'if (false) {',
  ],
  [
    'cli-shim.ts',
    'cli-shim',
    'sh launcher: RUN_AS_NODE not exported',
    "  'export ELECTRON_RUN_AS_NODE=1',",
    "  'true',",
  ],
  [
    'cli-shim.ts',
    'cli-shim',
    'cmd launcher: delayed expansion left on',
    "'setlocal EnableExtensions DisableDelayedExpansion',",
    "'setlocal EnableExtensions',",
  ],
  [
    'cli-shim.ts',
    'cli-shim',
    'cmd launcher: no UTF-8 code page for non-ASCII paths',
    'const utf8 = NON_ASCII.test(target.executable) || NON_ASCII.test(target.entry);',
    'const utf8 = false;',
  ],
  [
    'cli-shim.ts',
    'cli-shim',
    'AppImage: a mount path from the install run is trusted',
    '      inside(appDir, input.execPath)\n',
    '      true\n',
  ],
  [
    'cli-shim.ts',
    'cli-shim',
    'a development run can install',
    'if (!input.isPackaged) {',
    'if (false) {',
  ],
  [
    'cli-shim.ts',
    'cli-shim',
    'macOS: a mounted dmg accepted',
    "(input.execPath.startsWith('/Volumes/') || input.execPath.includes('/AppTranslocation/'))",
    'false',
  ],
  // the flow and its effects
  [
    'cli-shim-service.ts',
    'cli-shim-service',
    'a file that appears during the write is overwritten (error not turned into a refusal)',
    'if (error instanceof ShimExistsError || error instanceof ShimNotOursError) {',
    'if (false) {',
  ],
  [
    'cli-shim-service.ts',
    'cli-shim-service',
    'PATH is not searched for another install',
    ".filter((o) => o.facts.kind !== 'missing');",
    '.filter(() => false);',
  ],
  [
    'cli-shim-service.ts',
    'cli-shim-service',
    'refresh rewrites whatever the decision is',
    "if (a.kind !== 'ready' || a.decision.action !== 'update') return 'skipped';",
    "if (a.kind !== 'ready') return 'skipped';",
  ],
  [
    'cli-shim-service.ts',
    'cli-shim-service',
    'installs run in parallel',
    'const run = queue.then(job, job);',
    'const run = job();',
  ],
  [
    'cli-shim-fs.ts',
    'cli-shim-fs',
    'create replaces what is there',
    'linkSync(staging, file);',
    'renameSync(staging, file);',
  ],
  [
    'cli-shim-fs.ts',
    'cli-shim-fs',
    'replace rewrites a file without the marker',
    "if (now.kind !== 'file' || !isOwnLauncher(now.content)) throw new ShimNotOursError(file);",
    '',
  ],
  [
    'cli-shim-fs.ts',
    'cli-shim-fs',
    'a symlink is not noticed',
    "if (stat.isSymbolicLink()) return { kind: 'symlink' };",
    '',
  ],
  [
    'cli-shim-fs.ts',
    'cli-shim-fs',
    'the new user PATH is built into the script text',
    "'$value = $env:OCTOPUS_DIFF_USER_PATH',",
    "'$value = \\'C:\\\\new\\'',",
  ],
  [
    'cli-shim-fs.ts',
    'cli-shim-fs',
    'an empty user PATH is written',
    "if (value === '') throw new Error('refusing to write an empty user PATH');",
    '',
  ],
  // --- PR #113 review (DECISIONS #546-#550): the CLI channels on the bridge's guard ---
  [
    'ipc.ts',
    'cli-shim-ipc',
    'cli channels: sender check removed from the guard',
    '        if (!senderAllowed(event, deps.trusted())) return fallback(forbidden(method));\n',
    '',
  ],
  [
    'ipc.ts',
    'cli-shim-ipc',
    'cli channels: window id not checked',
    'if (event.sender.id !== trusted.webContentsId) return false;',
    '',
  ],
  [
    'ipc.ts',
    'cli-shim-ipc',
    'cli channels: subframe accepted',
    'if (!frame || frame.parent !== null) return false;',
    'if (!frame) return false;',
  ],
  [
    'ipc.ts',
    'cli-shim-ipc',
    'cli channels: arguments accepted (zod skipped)',
    '        const parsed = schema.safeParse(raw);\n        if (!parsed.success) return fallback(invalid(method));\n        return run(parsed.data);',
    '        return run(raw as never);',
  ],
  [
    'cli-shim-ipc.ts',
    'cli-shim-ipc',
    'cli channels: a refusal throws instead of a value',
    "function refusedStatus(refusal: Refusal): DesktopCliStatus {\n  return { state: 'unavailable', reason: refusal.message };",
    'function refusedStatus(refusal: Refusal): DesktopCliStatus {\n  throw new Error(refusal.message);',
  ],
  [
    'cli-shim-ipc.ts',
    'cli-shim-ipc',
    'cli channels: a failing install throws across IPC',
    "          return parsed.success ? parsed.data : refusedInstall(failed('installCli'));\n        } catch {\n          return refusedInstall(failed('installCli'));\n        }",
    "          return parsed.success ? parsed.data : refusedInstall(failed('installCli'));\n        } finally {\n        }",
  ],
  [
    'cli-shim-ipc.ts',
    'cli-shim-ipc',
    'cli channels: install result not validated',
    'const parsed = DesktopCliInstallResultSchema.safeParse(await options.shim.install());',
    'const parsed = { success: true as const, data: (await options.shim.install()) as never };',
  ],
  [
    'cli-shim-ipc.ts',
    'cli-shim-ipc',
    'cli channels: status result not validated',
    'const parsed = DesktopCliStatusSchema.safeParse(await options.shim.status());',
    'const parsed = { success: true as const, data: (await options.shim.status()) as never };',
  ],
  // openPath: the documented deny list (DECISIONS #546); one mutant per group plus the review's types
  ...[
    'chm',
    'theme',
    'website',
    'msu',
    'ws',
    'xbap',
    'themepack',
    'deskthemepack',
    'vsix',
    'accde',
    'py3',
    'cer',
    'asp',
    'docm',
    'iso',
    'one',
    'sh',
    'term',
    'shortcut',
    'flatpak',
  ].map((ext) => ['open-safety.ts', 'open-safety', `openPath: .${ext} allowed`, `'${ext}',`, '']),
  [
    'open-safety.ts',
    'open-safety',
    'openPath: a whole group dropped (macOS)',
    'Object.values(UNSAFE_OPEN_EXTENSION_GROUPS).flat()',
    "Object.entries(UNSAFE_OPEN_EXTENSION_GROUPS).filter(([k]) => k !== 'macos').flatMap(([, v]) => v)",
  ],
  // pickFolder's defaultPath (DECISIONS #548)
  [
    'ipc.ts',
    'ipc',
    'pickFolder: UNC defaultPath accepted on Windows',
    "if (platform === 'win32') return /^[A-Za-z]:[\\\\/]/.test(p);",
    "if (platform === 'win32') return true;",
  ],
  [
    'ipc.ts',
    'ipc',
    'pickFolder: // accepted on POSIX',
    "return p.startsWith('/') && !p.startsWith('//');",
    "return p.startsWith('/');",
  ],
  [
    'ipc.ts',
    'ipc',
    'pickFolder: defaultPath not checked to be a directory',
    '    return (await deps.fs.stat(p)).isDirectory();',
    '    await deps.fs.stat(p);\n    return true;',
  ],
  [
    'ipc.ts',
    'ipc',
    'pickFolder: defaultPath stat before the path check (SMB)',
    '  if (!isLocalAbsolutePath(p, deps.platform)) return false;\n  try {\n    return (await deps.fs.stat(p)).isDirectory();',
    '  const dir = await deps.fs.stat(p).then((s) => s.isDirectory(), () => false);\n  if (!isLocalAbsolutePath(p, deps.platform)) return false;\n  try {\n    return dir;',
  ],
  [
    'ipc.ts',
    'ipc',
    'pickFolder: defaultPath passed through unchecked',
    '            defaultPath !== undefined && (await isLocalDirectory(defaultPath, deps))',
    '            defaultPath !== undefined',
  ],
  // limits and the openPath rejection (PR #113 test gaps)
  ['ipc.ts', 'ipc', 'copyText: no 32 MiB limit', 'z.string().max(MAX_CLIPBOARD)', 'z.string()'],
  [
    'ipc.ts',
    'ipc',
    'pickFolder: no 200-character title limit',
    'title: z.string().max(200).optional(),',
    'title: z.string().optional(),',
  ],
  [
    'ipc.ts',
    'ipc',
    'openPath: a rejected shell.openPath throws across IPC',
    'const error = await deps.openPath(t.path).catch((e: unknown) => String(e));',
    'const error = await deps.openPath(t.path);',
  ],
  // the preload (PR #113 test gaps)
  [
    'bridge.ts',
    'bridge',
    'preload: listeners also get the IPC event',
    '              l(command as DesktopCommand);',
    '              (l as (...a: unknown[]) => void)(command, _event);',
  ],
  [
    'bridge.ts',
    'bridge',
    'preload: any answer passed to the page',
    'return isResult(result) ? result : FAILED;',
    'return result as DesktopActionResult;',
  ],
  [
    'bridge.ts',
    'bridge',
    'preload: pickFolder passes any answer',
    "return typeof result === 'string' ? result : null;",
    'return result as string;',
  ],
  // --- PR #110 review (DECISIONS #574-): refresh, signals, unreadable commands, safe reads ---
  [
    'cli-shim-service.ts',
    'cli-shim-service',
    'refresh: retargets even though the app the launcher names still exists',
    "if (named === null || deps.fs.inspect(named).kind !== 'missing') return 'skipped';",
    "if (named === null) return 'skipped';",
  ],
  [
    'cli-shim-service.ts',
    'cli-shim-service',
    'refresh: retargets a launcher it cannot read the app from',
    "if (named === null || deps.fs.inspect(named).kind !== 'missing') return 'skipped';",
    "if (named !== null && deps.fs.inspect(named).kind !== 'missing') return 'skipped';",
  ],
  [
    'cli-shim.ts',
    'cli-shim',
    'launcherApp: reads the app out of a file that is not ours',
    'if (!isOwnLauncher(content)) return null;',
    '',
  ],
  [
    'cli-shim.ts',
    'cli-shim',
    'AppImage launcher: SIGHUP not handled (skips the cleanup)',
    `"trap 'exit 129' HUP",`,
    `"true",`,
  ],
  [
    'cli-shim.ts',
    'cli-shim',
    'AppImage launcher: SIGTERM not handled',
    `"trap 'exit 143' TERM",`,
    `"true",`,
  ],
  [
    'cli-shim.ts',
    'cli-shim',
    'AppImage launcher: SIGINT not handled',
    `"trap 'exit 130' INT",`,
    `"true",`,
  ],
  [
    'cli-shim.ts',
    'cli-shim',
    'AppImage launcher: the CLI is not stopped on exit',
    `'cleanup() { stop "$child"; stop "$mounter"; rm -rf "$work"; }',`,
    `'cleanup() { stop "$mounter"; rm -rf "$work"; }',`,
  ],
  [
    'cli-shim.ts',
    'cli-shim',
    'AppImage launcher: the mount is not released on exit',
    `'cleanup() { stop "$child"; stop "$mounter"; rm -rf "$work"; }',`,
    `'cleanup() { stop "$child"; rm -rf "$work"; }',`,
  ],
  [
    'cli-shim.ts',
    'cli-shim',
    'AppImage launcher: the work dir is left behind',
    `'cleanup() { stop "$child"; stop "$mounter"; rm -rf "$work"; }',`,
    `'cleanup() { stop "$child"; stop "$mounter"; }',`,
  ],
  [
    'cli-shim.ts',
    'cli-shim',
    'AppImage launcher: the CLI runs in the foreground (a signal waits for it)',
    '"$@" <&3 3<&- &`,',
    '"$@" <&3 3<&-`,',
  ],
  [
    'cli-shim.ts',
    'cli-shim',
    'AppImage launcher: the CLI loses stdin',
    '"$@" <&3 3<&- &`,',
    '"$@" &`,',
  ],
  [
    'cli-shim.ts',
    'cli-shim',
    'AppImage launcher: a CLI that ignores TERM is never killed',
    `'  if kill -0 "$1" 2>/dev/null; then kill -9 "$1" 2>/dev/null; fi',`,
    `'  true',`,
  ],
  [
    'cli-shim.ts',
    'cli-shim',
    'decide: a command that cannot be read on PATH is not a conflict',
    "other.facts.kind === 'unreadable' ||",
    'false ||',
  ],
  [
    'cli-shim.ts',
    'cli-shim',
    'Windows PATH: relative entries searched',
    'if (dir === null || !/^(?:[a-zA-Z]:[\\\\/]|[\\\\/]{2})/.test(dir)) return [];',
    'if (dir === null) return [];',
  ],
  [
    'cli-shim-fs.ts',
    'cli-shim-fs',
    'readTop: no check that the descriptor is a regular file',
    'if (!fstatSync(fd).isFile()) throw new Error(`${file} is not a regular file`);',
    '',
  ],
  [
    'cli-shim-fs.ts',
    'cli-shim-fs',
    'readTop: a symlink is followed',
    '(constants.O_NOFOLLOW ?? 0)',
    '0',
  ],
  [
    'cli-shim-fs.ts',
    'cli-shim-fs',
    'inspect: a path that cannot be looked at is "other"',
    "(cheaper to refuse than to guess).\n      return { kind: 'unreadable' };",
    "(cheaper to refuse than to guess).\n      return { kind: 'other' };",
  ],
  [
    'cli-shim-fs.ts',
    'cli-shim-fs',
    'inspect: a file that cannot be read is "other"',
    "} catch {\n      return { kind: 'unreadable' };",
    "} catch {\n      return { kind: 'other' };",
  ],
  [
    'cli-shim-fs.ts',
    'cli-shim-fs',
    'create: the staging file is left behind',
    '} finally {\n        try {\n          ops.unlinkSync(staging);',
    '} finally {\n        try {\n          void staging;',
  ],
  [
    'cli-shim-fs.ts',
    'cli-shim-fs',
    'replaceOwn: the staging file is left behind when the rename fails',
    '} catch (error) {\n        try {\n          ops.unlinkSync(staging);',
    '} catch (error) {\n        try {\n          void staging;',
  ],
  [
    'cli-shim-fs.ts',
    'cli-shim-fs',
    'create fallback (no hard links): overwrites what is there',
    "ops.writeFileSync(file, content, { flag: 'wx', mode: 0o755 });",
    "ops.writeFileSync(file, content, { flag: 'w', mode: 0o755 });",
  ],
  [
    'cli-shim-fs.ts',
    'cli-shim-fs',
    'create fallback: an existing file is not reported as such',
    "if ((fallback as NodeJS.ErrnoException).code === 'EEXIST') {",
    'if (false) {',
  ],
  // the packaged-app e2e never lets the app rewrite a real launcher, and does not fake HOME (DECISIONS #581)
  [
    'cli-shim-service.ts',
    'cli-shim-service',
    'the startup refresh ignores OCTOPUS_DESKTOP_NO_CLI_REFRESH',
    "if (env[NO_CLI_REFRESH_ENV] === '1') {",
    'if (false) {',
  ],
  [
    'cli-shim-service.ts',
    'cli-shim-service',
    'the startup refresh switch accepts any value',
    "if (env[NO_CLI_REFRESH_ENV] === '1') {",
    'if (env[NO_CLI_REFRESH_ENV] !== undefined) {',
  ],
  [
    'cli-shim-service.ts',
    'cli-shim-service',
    'the startup refresh does not log that it is skipped',
    'log(`startup refresh of the octopus-diff command skipped (${NO_CLI_REFRESH_ENV}=1)`);',
    '',
  ],
  [
    'main.ts',
    'cli-shim-service',
    'main calls refresh() directly, past the switch',
    'void startupRefresh(cliShim, process.env, (text) => log.note(text));',
    'void cliShim.refresh();',
  ],
  [
    'e2e:desktop/support/packaged-app.ts',
    'e2e:desktop-app-env',
    'e2e: the app is launched without the switch',
    "{ ...env, OCTOPUS_DESKTOP_NO_CLI_REFRESH: '1' }",
    '{ ...env }',
  ],
  [
    'e2e:desktop/support/packaged-app.ts',
    'e2e:desktop-app-env',
    'e2e: HOME is redirected again (breaks Chromium on macOS)',
    "{ ...env, OCTOPUS_DESKTOP_NO_CLI_REFRESH: '1' }",
    "{ ...env, HOME: '/nonexistent', OCTOPUS_DESKTOP_NO_CLI_REFRESH: '1' }",
  ],
  [
    'e2e:desktop/support/packaged-app.ts',
    'e2e:desktop-app-env',
    'e2e: RUN_AS_NODE inherited by the app',
    '  delete out.ELECTRON_RUN_AS_NODE;\n  return out;',
    '  return out;',
  ],
  [
    'e2e:desktop/support/packaged-app.ts',
    'e2e:desktop-app-env',
    'e2e: launchApp passes the plain environment',
    '{ env: appLaunchEnv(env), stdio: [...CDP_PIPE_STDIO] }',
    '{ env, stdio: [...CDP_PIPE_STDIO] }',
  ],
  [
    'e2e:desktop/support/packaged-app.ts',
    'e2e:desktop-app-env',
    'e2e: runApp passes the plain environment',
    "{ env: appLaunchEnv(env), encoding: 'utf8', timeout: 30_000 }",
    "{ env, encoding: 'utf8', timeout: 30_000 }",
  ],
];

let current = null;
const restore = () => {
  if (current) writeFileSync(current.file, current.original);
  current = null;
};
process.on('SIGINT', () => {
  restore();
  process.exit(130);
});

/** One vitest run of a test file: its exit status and the failed-test count it printed (or null). */
function runTests(test) {
  const inE2e = test.startsWith('e2e:');
  const result = spawnSync(
    process.execPath,
    [
      path.join(desktopRoot, '..', '..', 'node_modules', 'vitest', 'vitest.mjs'),
      'run',
      inE2e ? `support/${test.slice(4)}.test.ts` : `test/${test}.test.ts`,
    ],
    {
      cwd: inE2e ? e2eRoot : desktopRoot,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    },
  );
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const summary = text.match(/Tests\s+(?:(\d+) failed\s*\|\s*)?(\d+) passed/);
  return {
    status: result.status,
    error: result.error,
    failed: summary ? Number(summary[1] ?? 0) : null,
    passed: summary ? Number(summary[2]) : null,
  };
}

// The unchanged tests must pass first: otherwise "tests fail" proves nothing (a missing vitest, a
// runner that dies before loading a file, a test already broken).
for (const test of new Set(MUTATIONS.map((m) => m[1]))) {
  const base = runTests(test);
  if (base.error || base.status !== 0 || base.failed !== 0 || !base.passed) {
    console.error(
      `mutation-check: the unchanged test/${test}.test.ts does not pass (exit ${base.status}, ` +
        `${base.passed} passed, ${base.failed} failed${base.error ? `, ${base.error.message}` : ''})`,
    );
    process.exit(2);
  }
}

const survivors = [];
let killed = 0;
for (const [file, test, description, from, to] of MUTATIONS) {
  const abs = sourcePath(file);
  const original = readFileSync(abs, 'utf8');
  const count = original.split(from).length - 1;
  if (count !== 1) {
    console.error(`mutation-check: "${description}": pattern found ${count} times in ${file}`);
    survivors.push(`${description} (pattern not found once)`);
    continue;
  }
  current = { file: abs, original };
  try {
    writeFileSync(abs, original.replace(from, to));
    const result = runTests(test);
    if (result.status === 0 && result.failed === 0) {
      survivors.push(`${description} (${file})`);
      console.log(`SURVIVED  ${description}`);
    } else if (result.failed !== null && result.failed > 0) {
      // Caught: a test ran and failed. A run that died before reporting tests is not a catch.
      killed++;
      console.log(`killed    ${description}`);
    } else {
      survivors.push(`${description} (${file}: the test run did not report results)`);
      console.log(`BROKEN    ${description} (exit ${result.status}, no test results)`);
    }
  } finally {
    restore();
  }
}
console.log(
  `mutation-check: ${killed} killed, ${survivors.length} survived (of ${MUTATIONS.length})`,
);
if (survivors.length > 0) {
  for (const s of survivors) console.log(`  survived: ${s}`);
  process.exit(1);
}
