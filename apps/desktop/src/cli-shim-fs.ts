/**
 * The real effects behind `cli-shim-service.ts` (docs/DESKTOP.md §3.2, roadmap #21): the filesystem
 * and, on Windows, the user's PATH in the registry. No git, no repository access.
 *
 * - `createNodeShimFs`: never follows a symlink (`lstat`), reads only the top of a file, creates a
 *   launcher *exclusively* (a hard link from a staged file, so it cannot replace anything even in a
 *   race) and replaces only a file that still carries our marker (staged file, then `rename`).
 * - `createWindowsUserPath`: reads and writes `HKCU\Environment\Path` through the system PowerShell
 *   (no admin rights). The new value travels in the environment, never in the script or the
 *   arguments, so a path with quotes or `$(…)` cannot become code. The raw value is kept
 *   (`%VAR%` unexpanded, REG_EXPAND_SZ stays REG_EXPAND_SZ) and the shell is told
 *   (`WM_SETTINGCHANGE`) so a new terminal sees it.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { type FileFacts, isOwnLauncher } from './cli-shim.js';
import {
  type RegistryKind,
  ShimExistsError,
  type ShimFs,
  ShimNotOursError,
  type UserPathEditor,
} from './cli-shim-service.js';

/** How much of a file is read to look for the marker and to compare with the launcher text. */
const READ_LIMIT = 64 * 1024;

function readTop(file: string): string {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(READ_LIMIT);
    const n = readSync(fd, buffer, 0, READ_LIMIT, 0);
    return buffer.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function inspect(file: string): FileFacts {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' };
    // Something is there that cannot be looked at: not ours to touch.
    return { kind: 'other' };
  }
  if (stat.isSymbolicLink()) return { kind: 'symlink' };
  if (!stat.isFile()) return { kind: 'other' };
  try {
    return { kind: 'file', content: readTop(file) };
  } catch {
    return { kind: 'other' };
  }
}

export interface NodeShimFsOptions {
  /** A suffix for staging files (tests); default: pid and random bytes, unique per call. */
  unique?: () => string;
}

export function createNodeShimFs(options: NodeShimFsOptions = {}): ShimFs {
  const unique = options.unique ?? (() => `${process.pid}.${randomBytes(6).toString('hex')}`);

  /** Writes `content` next to `file` in a staging file; the caller moves or deletes it. */
  function stage(file: string, content: string): string {
    const staging = `${file}.${unique()}.tmp`;
    writeFileSync(staging, content, { flag: 'wx', mode: 0o755 });
    chmodSync(staging, 0o755); // the umask may have taken bits away
    return staging;
  }

  return {
    inspect,

    mkdirp(dir) {
      mkdirSync(dir, { recursive: true, mode: 0o755 });
    },

    create(file, content) {
      const staging = stage(file, content);
      try {
        try {
          // A hard link fails with EEXIST when anything is at `file` (a symlink included, dangling
          // or not): it cannot replace a file that appeared since the check.
          linkSync(staging, file);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EEXIST') throw new ShimExistsError(file);
          // No hard links here (some filesystems, some Windows volumes): exclusive create instead.
          try {
            writeFileSync(file, content, { flag: 'wx', mode: 0o755 });
          } catch (fallback) {
            if ((fallback as NodeJS.ErrnoException).code === 'EEXIST') {
              throw new ShimExistsError(file);
            }
            throw fallback;
          }
        }
      } finally {
        try {
          unlinkSync(staging);
        } catch {
          // already gone
        }
      }
    },

    replaceOwn(file, content) {
      const now = inspect(file);
      if (now.kind !== 'file' || !isOwnLauncher(now.content)) throw new ShimNotOursError(file);
      const staging = stage(file, content);
      try {
        renameSync(staging, file);
      } catch (error) {
        try {
          unlinkSync(staging);
        } catch {
          // already gone
        }
        throw error;
      }
    },
  };
}

// --- Windows user PATH ------------------------------------------------------------------------------

export const READ_USER_PATH_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
  "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')",
  "$value = $key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentVariables)",
  "if ($null -eq $value) { 'none' } else { [string]$key.GetValueKind('Path'); $value }",
].join('\n');

export const WRITE_USER_PATH_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$value = $env:OCTOPUS_DIFF_USER_PATH',
  '$kind = $env:OCTOPUS_DIFF_USER_PATH_KIND',
  "if ([string]::IsNullOrEmpty($value)) { throw 'empty PATH value' }",
  "if ($kind -ne 'String' -and $kind -ne 'ExpandString') { throw 'unknown registry type' }",
  "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)",
  "$key.SetValue('Path', $value, [Microsoft.Win32.RegistryValueKind]$kind)",
  '$key.Close()',
  // Tell Explorer and new terminals the environment changed (HWND_BROADCAST, WM_SETTINGCHANGE).
  'Add-Type -Namespace OctopusDiff -Name Native -MemberDefinition \'[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);\'',
  '$result = [UIntPtr]::Zero',
  "[void][OctopusDiff.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)",
].join('\n');

/** The base64 of the script's UTF-16LE bytes: what `powershell -EncodedCommand` takes. */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** The system PowerShell by absolute path: never one found through PATH. */
export function powerShellExe(env: Readonly<Record<string, string | undefined>>): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
  return path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** What the read script printed: a type line (`none`, `String`, `ExpandString`), then the value. */
export function parseUserPathOutput(output: string): {
  value: string | null;
  kind: RegistryKind;
} {
  const lines = output.replace(/^\uFEFF/, '').split(/\r?\n/);
  const type = lines[0]?.trim();
  if (type === 'none') return { value: null, kind: 'ExpandString' };
  if (type === 'String' || type === 'ExpandString') {
    return { value: lines.slice(1).join('\n').replace(/\n+$/, ''), kind: type };
  }
  throw new Error(`unexpected answer reading the user PATH: ${JSON.stringify(type ?? '')}`);
}

export type RunPowerShell = (
  file: string,
  args: readonly string[],
  env: Record<string, string | undefined>,
) => Promise<string>;

export const defaultRunPowerShell: RunPowerShell = (file, args, env) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { env, windowsHide: true, timeout: 20_000, encoding: 'utf8', maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`${error.message}${stderr ? `: ${stderr.trim()}` : ''}`));
        else resolve(stdout);
      },
    );
  });

export function createWindowsUserPath(options: {
  env: Readonly<Record<string, string | undefined>>;
  run?: RunPowerShell;
}): UserPathEditor {
  const run = options.run ?? defaultRunPowerShell;
  const exe = powerShellExe(options.env);
  const invoke = (script: string, extraEnv: Record<string, string>) =>
    run(
      exe,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encodePowerShell(script),
      ],
      { ...options.env, ...extraEnv },
    );
  return {
    async read() {
      return parseUserPathOutput(await invoke(READ_USER_PATH_SCRIPT, {}));
    },
    async write(value, kind) {
      if (value === '') throw new Error('refusing to write an empty user PATH');
      if (kind !== 'String' && kind !== 'ExpandString') {
        throw new Error(`unknown registry type: ${String(kind)}`);
      }
      await invoke(WRITE_USER_PATH_SCRIPT, {
        OCTOPUS_DIFF_USER_PATH: value,
        OCTOPUS_DIFF_USER_PATH_KIND: kind,
      });
    },
  };
}
