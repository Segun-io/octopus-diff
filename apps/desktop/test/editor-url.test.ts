import { describe, expect, it } from 'vitest';
import { editorUrl, isAllowedEditorUrl } from '../src/editor-url.js';

describe('editorUrl', () => {
  it('builds the file URL of each allowlisted editor', () => {
    expect(editorUrl('vscode', '/home/me/repo/src/a.ts', undefined, 'linux')).toBe(
      'vscode://file/home/me/repo/src/a.ts',
    );
    expect(editorUrl('cursor', '/home/me/repo/src/a.ts', 12, 'darwin')).toBe(
      'cursor://file/home/me/repo/src/a.ts:12',
    );
    expect(editorUrl('zed', '/home/me/repo/src/a.ts', 3, 'linux')).toBe(
      'zed://file/home/me/repo/src/a.ts:3',
    );
  });

  it('percent-encodes every segment, so a name cannot add a query, a fragment or a line', () => {
    expect(editorUrl('vscode', '/r/a b#?:%.ts', 2, 'linux')).toBe(
      'vscode://file/r/a%20b%23%3F%3A%25.ts:2',
    );
  });

  it('writes Windows paths with forward slashes and the drive letter as is', () => {
    expect(editorUrl('vscode', 'C:\\Users\\me\\repo\\a.ts', 5, 'win32')).toBe(
      'vscode://file/C:/Users/me/repo/a.ts:5',
    );
  });

  it('builds nothing for a path that is not absolute', () => {
    expect(editorUrl('vscode', 'relative/a.ts', 1, 'linux')).toBeNull();
    expect(editorUrl('vscode', '\\\\server\\share\\a.ts', 1, 'win32')).toBeNull();
  });

  it('every URL it builds passes the allowlist', () => {
    for (const editor of ['vscode', 'cursor', 'zed'] as const) {
      expect(isAllowedEditorUrl(editorUrl(editor, '/r/x y.ts', 9, 'linux') ?? '')).toBe(true);
      expect(isAllowedEditorUrl(editorUrl(editor, 'C:\\r\\x.ts', undefined, 'win32') ?? '')).toBe(
        true,
      );
    }
  });
});

describe('isAllowedEditorUrl (the openExternal allowlist)', () => {
  it('refuses every other scheme or form', () => {
    for (const url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'http://127.0.0.1:7428/',
      'https://example.com/',
      'vscode-insiders://file/r/a.ts',
      'vscode://settings/security.workspace.trust',
      'vscode://vscode.git/clone?url=https://evil',
      'vscode://file/r/a.ts?windowId=_blank',
      'vscode://file/r/a.ts#x',
      'vscode://user:pw@file/r/a.ts',
      'vscode://file:1234/r/a.ts',
      'vscode://file',
      'vscode:file/r/a.ts',
      'VSCODE://FILE/r/a.ts',
      'zed://extension/x',
      'cursor://anysphere.cursor-retrieval/x',
      'ms-msdt:/id',
      'smb://host/share',
      '',
      'not a url',
    ]) {
      expect(isAllowedEditorUrl(url), url).toBe(false);
    }
  });
});
