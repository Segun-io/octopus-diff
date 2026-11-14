/**
 * `openPath` hands a file to the OS's default app. For a program that means running it, and the
 * files come from repositories (untrusted content, often written by agents). So the bridge's
 * "Open" never opens something that would run: an executable or script type (one list on every
 * platform, since Wine, Python launchers and friends register these types anywhere), a macOS
 * bundle or launcher (`.app`, `.command`, `.fileloc`, …, folders included), a file with an
 * execute bit (macOS, Linux), or anything that is neither a file nor a folder. "Open in editor"
 * and "Reveal" stay available for those. Pure.
 */
import type { Refusal, ResolvedTarget } from './path-guard.js';
import { pathApi, refuse } from './path-guard.js';

/** Lowercase extensions (without the dot) that `openPath` refuses. */
// biome-ignore format: a word list, kept dense
export const UNSAFE_OPEN_EXTENSIONS: ReadonlySet<string> = new Set([
  // Windows programs, installers, shortcuts and script hosts
  'exe', 'com', 'scr', 'pif', 'cpl', 'msc', 'msi', 'msp', 'mst', 'msix', 'msixbundle', 'appx',
  'appxbundle', 'appinstaller', 'application', 'appref-ms', 'gadget', 'hta', 'inf', 'reg', 'lnk',
  'url', 'scf', 'settingcontent-ms', 'library-ms', 'search-ms', 'searchconnector-ms', 'diagcab',
  'bat', 'cmd', 'ps1', 'psm1', 'psd1', 'ps1xml', 'vb', 'vbs', 'vbe', 'js', 'jse', 'mjs', 'cjs',
  'wsf', 'wsh', 'wsc', 'sct', 'xll', 'jar', 'jnlp',
  // Scripts that a registered interpreter runs on open
  'sh', 'bash', 'zsh', 'ksh', 'csh', 'tcsh', 'fish', 'py', 'pyw', 'pyz', 'pyzw', 'pyc', 'pl',
  'rb', 'php', 'tcl', 'lua',
  // macOS bundles, launchers and scripts
  'app', 'command', 'tool', 'terminal', 'workflow', 'action', 'pkg', 'mpkg', 'prefpane', 'kext',
  'saver', 'qlgenerator', 'mdimporter', 'osax', 'service', 'scpt', 'scptd', 'applescript',
  'fileloc', 'webloc', 'inetloc', 'mobileconfig', 'dylib', 'bundle', 'plugin',
  // Linux launchers and executables
  'desktop', 'appimage', 'run', 'bin', 'elf', 'so', 'deb', 'rpm', 'flatpakref', 'snap',
]);

function extensionOf(file: string, platform: NodeJS.Platform): string {
  const p = pathApi(platform);
  let name = p.basename(file);
  // Windows ignores trailing dots and spaces: `a.exe.` runs `a.exe`.
  if (platform === 'win32') name = name.replace(/[. ]+$/, '');
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** Null when `openPath` may open the target; otherwise why not. */
export function openPathRefusal(target: ResolvedTarget, platform: NodeJS.Platform): Refusal | null {
  const unsafe = refuse(
    'unsafe-file',
    'This would run a program, so it is not opened. Use Open in editor or Reveal instead.',
  );
  if (target.kind === 'other') return unsafe;
  if (UNSAFE_OPEN_EXTENSIONS.has(extensionOf(target.path, platform))) return unsafe;
  if (target.kind === 'file' && platform !== 'win32' && (target.mode & 0o111) !== 0) return unsafe;
  return null;
}
