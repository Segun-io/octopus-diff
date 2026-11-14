/**
 * `openPath` must refuse every type that runs code when the OS opens it (DECISIONS #535, #546).
 * The lists below are copied here on purpose, independent of `src/open-safety.ts`: dropping an
 * extension from the source makes this test fail.
 */
import { describe, expect, it } from 'vitest';
import { openPathRefusal, UNSAFE_OPEN_EXTENSIONS } from '../src/open-safety.js';

/**
 * Microsoft's "Blocked attachments in Outlook" Level-1 list (support.microsoft.com, the list as
 * published in 2024), lowercase, without the dot.
 */
// biome-ignore format: a word list, kept dense
const OUTLOOK_LEVEL1 = [
  'ade', 'adp', 'app', 'appcontent-ms', 'application', 'appref-ms', 'asp', 'aspx', 'asx', 'bas',
  'bat', 'bgi', 'cab', 'cer', 'chm', 'cmd', 'cnt', 'com', 'cpl', 'crt', 'csh', 'der', 'diagcab',
  'exe', 'fxp', 'gadget', 'grp', 'hlp', 'hpj', 'hta', 'htc', 'inf', 'ins', 'isp', 'its', 'jar',
  'jnlp', 'js', 'jse', 'ksh', 'lnk', 'mad', 'maf', 'mag', 'mam', 'maq', 'mar', 'mas', 'mat', 'mau',
  'mav', 'maw', 'mcf', 'mda', 'mdb', 'mde', 'mdt', 'mdw', 'mdz', 'msc', 'msh', 'msh1', 'msh2',
  'mshxml', 'msh1xml', 'msh2xml', 'msi', 'msp', 'mst', 'msu', 'ops', 'osd', 'pcd', 'pif', 'pl',
  'plg', 'prf', 'prg', 'printerexport', 'ps1', 'ps1xml', 'ps2', 'ps2xml', 'psc1', 'psc2', 'psd1',
  'psdm1', 'pst', 'py', 'pyc', 'pyo', 'pyw', 'pyz', 'pyzw', 'reg', 'scf', 'scr', 'sct', 'settingcontent-ms',
  'shb', 'shs', 'theme', 'tmp', 'url', 'vb', 'vbe', 'vbp', 'vbs', 'vhd', 'vhdx', 'vsmacros', 'vsw',
  'webpnp', 'website', 'ws', 'wsb', 'wsc', 'wsf', 'wsh', 'xbap', 'xll', 'xnk',
];

/** The PR #113 review's list (Windows types that run code), all of which must be refused. */
// biome-ignore format: a word list, kept dense
const REVIEW_113 = [
  'chm', 'hlp', 'website', 'msu', 'theme', 'themepack', 'deskthemepack', 'xbap', 'ins', 'isp',
  'shb', 'shs', 'ws', 'ade', 'adp', 'mda', 'mde', 'accde', 'vsix', 'wsb', 'msh', 'mshxml', 'psc1',
  'pyo', 'py3',
];

/** Further types this app refuses, each justified in DECISIONS #546. */
// biome-ignore format: a word list, kept dense
const EXTRA = [
  // Windows: packages, disk images that mount and run, Office with macros, OneNote containers
  'exe', 'msix', 'msixbundle', 'appx', 'appxbundle', 'appinstaller', 'library-ms', 'search-ms',
  'searchconnector-ms', 'psm1', 'accdb', 'accda', 'accdr', 'accdt', 'iso', 'img', 'one', 'onepkg',
  'docm', 'dotm', 'xlsm', 'xltm', 'xlam', 'xla', 'pptm', 'potm', 'ppam', 'ppsm', 'sldm', 'mjs', 'cjs',
  // Scripts that a registered interpreter runs on open
  'sh', 'bash', 'zsh', 'ksh', 'tcsh', 'fish', 'rb', 'php', 'tcl', 'lua',
  // macOS bundles, launchers, installers, configuration profiles and scripts
  'command', 'tool', 'terminal', 'term', 'workflow', 'action', 'shortcut', 'pkg', 'mpkg', 'prefpane',
  'kext', 'saver', 'qlgenerator', 'mdimporter', 'osax', 'service', 'scpt', 'scptd', 'applescript',
  'fileloc', 'webloc', 'inetloc', 'mobileconfig', 'dylib', 'bundle', 'plugin', 'widget',
  // Linux launchers, packages and executables
  'desktop', 'appimage', 'run', 'bin', 'elf', 'so', 'deb', 'rpm', 'flatpak', 'flatpakref',
  'flatpakrepo', 'snap',
];

const file = (name: string) => ({
  path: `/r/${name}`,
  root: '/r',
  kind: 'file' as const,
  mode: 0o644,
});

describe('the documented deny list', () => {
  for (const [name, list] of [
    ['Outlook Level-1', OUTLOOK_LEVEL1],
    ['PR #113 review', REVIEW_113],
    ['extras', EXTRA],
  ] as const) {
    it(`refuses every ${name} extension, on every platform, in any case`, () => {
      const missing = list.filter((ext) => !UNSAFE_OPEN_EXTENSIONS.has(ext));
      expect(missing, `not in UNSAFE_OPEN_EXTENSIONS`).toEqual([]);
      for (const ext of list) {
        for (const platform of ['linux', 'darwin', 'win32'] as const) {
          for (const n of [`x.${ext}`, `X.${ext.toUpperCase()}`]) {
            expect(openPathRefusal(file(n), platform), `${platform} ${n}`).toMatchObject({
              reason: 'unsafe-file',
            });
          }
        }
      }
    });
  }

  it('still opens the documents and source files people open', () => {
    for (const n of [
      'a.png',
      'b.pdf',
      'c.md',
      'd.txt',
      'e.html',
      'f.svg',
      'g.json',
      'h.ts',
      'i.csv',
    ]) {
      expect(openPathRefusal(file(n), 'win32'), n).toBeNull();
    }
  });
});
