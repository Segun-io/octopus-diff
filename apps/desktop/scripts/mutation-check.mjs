// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the mutations are source text that contains `${…}`.
// Mutation check for the rules that must not regress silently: the security policy (DESKTOP §5),
// the menu accelerator rule, and the supervisor's lifecycle (stdin lifeline, RUN_AS_NODE,
// restart/backoff, attach, shutdown escalation, token never logged).
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
  // --- shell env ---
  ['shell-env.ts', 'shell-env', 'PATH script without braces', '\\${PATH}', '$PATH'],
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

const survivors = [];
let killed = 0;
for (const [file, test, description, from, to] of MUTATIONS) {
  const abs = path.join(desktopRoot, 'src', file);
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
    const result = spawnSync(
      process.execPath,
      [
        path.join(desktopRoot, '..', '..', 'node_modules', 'vitest', 'vitest.mjs'),
        'run',
        `test/${test}.test.ts`,
      ],
      { cwd: desktopRoot, encoding: 'utf8' },
    );
    if (result.status === 0) {
      survivors.push(`${description} (${file})`);
      console.log(`SURVIVED  ${description}`);
    } else {
      killed++;
      console.log(`killed    ${description}`);
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
