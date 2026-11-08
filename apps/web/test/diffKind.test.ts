import type { FileDiff } from '@octopus-diff/contracts';
import { parsePatchFiles } from '@pierre/diffs';
import { describe, expect, it } from 'vitest';
import { MockBackend } from '../mock/backend.ts';
import { classifyDiff, repairTruncatedPatch } from '../src/lib/diffKind.ts';

function authDiffs(
  opts: { full?: boolean; ignoreWhitespace?: boolean } = {},
): Map<string, FileDiff> {
  const backend = new MockBackend({ dataset: 'demo' });
  const inbox = backend.inbox({ kind: 'working' }, false);
  const auth = inbox.entries.find((e) => e.worktree.branch === 'feat/auth');
  if (!auth) throw new Error('feat/auth missing');
  const out = new Map<string, FileDiff>();
  for (const f of auth.files) {
    const res = backend.getDiff(auth.worktree.id, {
      scope: { kind: 'working' },
      path: f.path,
      ...(f.rawPath ? { rawPath: f.rawPath } : {}),
      ignoreWhitespace: opts.ignoreWhitespace ?? false,
      full: opts.full ?? false,
    });
    out.set(f.path, res.diff);
  }
  return out;
}

describe('classifyDiff (placeholders)', () => {
  const diffs = authDiffs();
  const kind = (path: string) => {
    const d = diffs.get(path);
    if (!d) throw new Error(`missing ${path}`);
    return classifyDiff(d);
  };

  it('detects binary, too-large, submodule and symlink diffs', () => {
    expect(kind('assets/logo.png').kind).toBe('binary');
    expect(kind('data/fixtures.min.json')).toMatchObject({ kind: 'too-large' });
    const sub = kind('vendor/libgit');
    expect(sub.kind).toBe('submodule');
    if (sub.kind === 'submodule') {
      expect(sub.oldCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(sub.newCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(sub.newCommit).not.toBe(sub.oldCommit);
    }
    expect(kind('config/current.json')).toMatchObject({
      kind: 'symlink',
      oldTarget: '../shared/config.json',
      newTarget: '../shared/config.v2.json',
      typechange: false,
    });
    expect(kind('src/auth/type.ts')).toMatchObject({
      kind: 'symlink',
      oldTarget: null,
      newTarget: '../elsewhere/target.ts',
      typechange: true,
    });
  });

  it('explains header-only diffs', () => {
    expect(kind('scripts/deploy.sh')).toEqual({
      kind: 'empty',
      reason: 'File mode changed 100644 → 100755',
    });
    expect(kind('src/auth/.keep')).toEqual({ kind: 'empty', reason: 'New empty file' });
    expect(kind('src/auth/README.md')).toEqual({
      kind: 'empty',
      reason: 'Renamed without content changes',
    });
    const ws = authDiffs({ ignoreWhitespace: true }).get('src/format.ts');
    if (!ws) throw new Error('missing format.ts');
    expect(classifyDiff(ws, true)).toEqual({
      kind: 'empty',
      reason: 'Only whitespace changed (hidden by the whitespace toggle)',
    });
  });

  it('renders ordinary patches, including renames, deletions and conflicts', () => {
    for (const path of [
      'src/auth/session.ts',
      'src/auth/middleware.ts',
      'src/auth/legacy.ts',
      'src/auth/merge.ts',
      'windows/build.bat',
    ]) {
      expect(kind(path)).toEqual({ kind: 'patch', truncated: false });
    }
  });

  it('flags truncated patches and repairs the last hunk header so they parse cleanly', () => {
    const full = authDiffs({ full: true }).get('data/fixtures.min.json');
    if (!full) throw new Error('missing');
    expect(classifyDiff(full)).toEqual({ kind: 'patch', truncated: true });
    const repaired = repairTruncatedPatch(full.patch);
    const header = /^@@ -0,0 \+1,(\d+) @@/m.exec(repaired);
    const added = repaired
      .split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
    expect(Number(header?.[1])).toBe(added);
    const parsed = parsePatchFiles(repaired, { throwOnError: true });
    expect(parsed[0]?.files[0]?.hunks[0]?.additionCount).toBe(added);
  });

  it('leaves complete patches alone', () => {
    const d = diffs.get('src/auth/session.ts');
    expect(d && repairTruncatedPatch(d.patch)).toBe(d?.patch);
  });
});
