import { spawn as nodeSpawn } from 'node:child_process';

export interface OpenCommand {
  command: string;
  args: string[];
}

/** Only plain http(s) URLs are opened; anything else could be interpreted by the opener. */
const SAFE_URL = /^https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;

/**
 * A PowerShell `Start-Process` call passed as `-EncodedCommand` (UTF-16LE base64), so no Windows
 * command-line quoting rules apply to the URL.
 */
export function powershellOpenArgs(url: string): string[] {
  const script = `Start-Process '${url.replace(/'/g, "''")}'`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encoded,
  ];
}

/**
 * Commands that open `url` in the default browser, in the order to try them. On WSL the Windows
 * browser is preferred (`wslview` from wslu, else PowerShell `Start-Process`), then `xdg-open` in case a
 * Linux browser is set up.
 */
export function browserOpenCommands(
  url: string,
  platform: NodeJS.Platform,
  isWsl: boolean,
): OpenCommand[] {
  if (!SAFE_URL.test(url)) throw new Error(`refusing to open a non-http(s) URL: ${url}`);
  if (platform === 'darwin') return [{ command: 'open', args: [url] }];
  if (platform === 'win32') {
    return [{ command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] }];
  }
  const commands: OpenCommand[] = [];
  if (isWsl) {
    commands.push({ command: 'wslview', args: [url] });
    commands.push({ command: 'powershell.exe', args: powershellOpenArgs(url) });
  }
  commands.push({ command: 'xdg-open', args: [url] });
  return commands;
}

/** The subset of `child_process.spawn` used here (injectable for tests). */
export type SpawnFn = (
  command: string,
  args: string[],
  options: { detached: boolean; stdio: 'ignore'; shell: false },
) => {
  once(event: 'spawn', listener: () => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  unref(): void;
};

function trySpawn(spawn: SpawnFn, { command, args }: OpenCommand): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ReturnType<SpawnFn>;
    try {
      child = spawn(command, args, { detached: true, stdio: 'ignore', shell: false });
    } catch {
      resolve(false);
      return;
    }
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

/**
 * Opens `url` with the first opener that exists. Resolves with the command used; rejects if none
 * could be started. Never uses a shell.
 */
export async function openBrowser(
  url: string,
  platform: NodeJS.Platform,
  isWsl: boolean,
  spawn: SpawnFn = nodeSpawn as unknown as SpawnFn,
): Promise<string> {
  const commands = browserOpenCommands(url, platform, isWsl);
  for (const candidate of commands) {
    if (await trySpawn(spawn, candidate)) return candidate.command;
  }
  throw new Error(
    `could not open a browser (tried ${commands.map((c) => c.command).join(', ')}); open the URL manually`,
  );
}
