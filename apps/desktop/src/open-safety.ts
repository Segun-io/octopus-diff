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

/**
 * Extensions (lowercase, without the dot) that `openPath` refuses, by where they come from
 * (DECISIONS #535, #546). A deny list on purpose: an allowlist would refuse the source files people
 * open, and those have "Open in editor" anyway. Files checked out by git carry no Mark-of-the-Web,
 * so Windows' own "downloaded file" prompts do not protect these types here. One list on every
 * platform: Wine, Python launchers and the like register these types anywhere.
 */
// biome-ignore format: word lists, kept dense
export const UNSAFE_OPEN_EXTENSION_GROUPS = {
  /**
   * Microsoft's "Blocked attachments in Outlook" Level-1 list, complete (CHM help runs script
   * through hh.exe, `.theme` was ThemeBleed, `.website`/`.url`/`.lnk` launch, the Access types run
   * macros, the certificate types open the import wizard).
   */
  outlookLevel1: [
    'ade', 'adp', 'app', 'appcontent-ms', 'application', 'appref-ms', 'asp', 'aspx', 'asx', 'bas',
    'bat', 'bgi', 'cab', 'cer', 'chm', 'cmd', 'cnt', 'com', 'cpl', 'crt', 'csh', 'der', 'diagcab',
    'exe', 'fxp', 'gadget', 'grp', 'hlp', 'hpj', 'hta', 'htc', 'inf', 'ins', 'isp', 'its', 'jar',
    'jnlp', 'js', 'jse', 'ksh', 'lnk', 'mad', 'maf', 'mag', 'mam', 'maq', 'mar', 'mas', 'mat', 'mau',
    'mav', 'maw', 'mcf', 'mda', 'mdb', 'mde', 'mdt', 'mdw', 'mdz', 'msc', 'msh', 'msh1', 'msh2',
    'mshxml', 'msh1xml', 'msh2xml', 'msi', 'msp', 'mst', 'msu', 'ops', 'osd', 'pcd', 'pif', 'pl',
    'plg', 'prf', 'prg', 'printerexport', 'ps1', 'ps1xml', 'ps2', 'ps2xml', 'psc1', 'psc2', 'psd1',
    'psdm1', 'pst', 'py', 'pyc', 'pyo', 'pyw', 'pyz', 'pyzw', 'reg', 'scf', 'scr', 'sct',
    'settingcontent-ms', 'shb', 'shs', 'theme', 'tmp', 'url', 'vb', 'vbe', 'vbp', 'vbs', 'vhd', 'vhdx',
    'vsmacros', 'vsw', 'webpnp', 'website', 'ws', 'wsb', 'wsc', 'wsf', 'wsh', 'xbap', 'xll', 'xnk',
  ],
  /**
   * Windows, beyond Level-1: theme packs (ThemeBleed's carriers), app and extension packages,
   * shell search/library files, PowerShell modules, Access databases and runtime files, disk images
   * that mount and autorun (and used to shed Mark-of-the-Web), OneNote containers (embedded files
   * launch from them), macro-enabled Office files (without Mark-of-the-Web Office's internet-macro
   * block does not apply), Node module scripts (WSH runs `.js`; `.mjs`/`.cjs` are often mapped to
   * node), and `py3`.
   */
  windows: [
    'themepack', 'deskthemepack', 'msix', 'msixbundle', 'appx', 'appxbundle', 'appinstaller', 'vsix',
    'library-ms', 'search-ms', 'searchconnector-ms', 'psm1', 'accdb', 'accde', 'accda', 'accdr',
    'accdt', 'iso', 'img', 'one', 'onepkg', 'docm', 'dotm', 'xlsm', 'xltm', 'xlam', 'xla', 'pptm',
    'potm', 'ppam', 'ppsm', 'sldm', 'mjs', 'cjs', 'py3',
  ],
  /** Scripts a registered interpreter runs on open (POSIX shells, Ruby, PHP, Tcl, Lua). */
  scripts: ['sh', 'bash', 'zsh', 'tcsh', 'fish', 'rb', 'php', 'tcl', 'lua'],
  /**
   * macOS: app and plug-in bundles (they launch or load code), Terminal launchers (`.command`,
   * `.tool`, `.terminal`, `.term`), Automator and Shortcuts files, installers, AppleScript,
   * location files that open any URL or app (`.fileloc`, `.webloc`, `.inetloc`), configuration
   * profiles, Dashboard widgets and libraries.
   */
  macos: [
    'command', 'tool', 'terminal', 'term', 'workflow', 'action', 'shortcut', 'pkg', 'mpkg',
    'prefpane', 'kext', 'saver', 'qlgenerator', 'mdimporter', 'osax', 'service', 'scpt', 'scptd',
    'applescript', 'fileloc', 'webloc', 'inetloc', 'mobileconfig', 'dylib', 'bundle', 'plugin',
    'widget',
  ],
  /** Linux: desktop launchers (run by some file managers), AppImages, installers and packages, binaries. */
  linux: [
    'desktop', 'appimage', 'run', 'bin', 'elf', 'so', 'deb', 'rpm', 'flatpak', 'flatpakref',
    'flatpakrepo', 'snap',
  ],
} as const;

/** Every refused extension (the union of the groups). */
export const UNSAFE_OPEN_EXTENSIONS: ReadonlySet<string> = new Set(
  Object.values(UNSAFE_OPEN_EXTENSION_GROUPS).flat(),
);

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
