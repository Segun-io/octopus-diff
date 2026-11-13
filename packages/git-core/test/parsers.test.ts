import path from 'node:path';
import { CommitInfoSchema } from '@octopus-diff/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  computeFilterOverrides,
  forEachRefFormat,
  PatchSplitter,
  parseChunkHeader,
  parseForEachRef,
  parseGitVersion,
  parseLog,
  parseRawNumstat,
  parseStatusV2,
  parseWorktreeList,
  quotePathName,
  splitPatch,
  synthesizeNewFilePatch,
  unquoteMaybe,
} from '../src/index.js';
import { createFixture, type Fixture } from './helpers/fixture.js';

const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);
const OID_0 = '0'.repeat(40);

describe('parseStatusV2', () => {
  it('parses headers and every entry kind, keeping raw path bytes', () => {
    const output = [
      `# branch.oid ${OID_A}`,
      '# branch.head feature/x',
      '# branch.upstream origin/feature/x',
      '# branch.ab +3 -1',
      '# stash 2',
      `1 .M N... 100644 100644 100644 ${OID_A} ${OID_A} with space.txt`,
      `1 A. N... 000000 100644 100644 ${OID_0} ${OID_B} caf\xe9.txt`,
      `2 R. N... 100644 100644 100644 ${OID_A} ${OID_A} R100 new name.txt`,
      'old name.txt',
      `u UU N... 100644 100644 100644 100644 ${OID_A} ${OID_B} ${OID_A} conflict.txt`,
      '? untracked dir/file.txt',
      '? nested/',
      '! ignored.log',
      '',
    ].join('\u0000');
    const { branch, entries } = parseStatusV2(output);
    expect(branch).toEqual({
      oid: OID_A,
      head: 'feature/x',
      detached: false,
      upstream: 'origin/feature/x',
      ahead: 3,
      behind: 1,
    });
    expect(entries.map((e) => [e.kind, e.path])).toEqual([
      ['ordinary', 'with space.txt'],
      ['ordinary', 'caf\xe9.txt'],
      ['renamed', 'new name.txt'],
      ['unmerged', 'conflict.txt'],
      ['untracked', 'untracked dir/file.txt'],
      ['untracked', 'nested/'],
      ['ignored', 'ignored.log'],
    ]);
    expect(entries[0]).toMatchObject({ x: '.', y: 'M', modeWorktree: '100644', oidIndex: OID_A });
    expect(entries[2]).toMatchObject({ x: 'R', score: 'R100', origPath: 'old name.txt' });
    expect(entries[3]).toMatchObject({ x: 'U', y: 'U', oids: [OID_A, OID_B, OID_A] });
  });

  it('handles unborn and detached heads', () => {
    expect(
      parseStatusV2('# branch.oid (initial)\u0000# branch.head main\u0000').branch,
    ).toMatchObject({
      oid: null,
      head: 'main',
      detached: false,
    });
    expect(
      parseStatusV2(`# branch.oid ${OID_A}\u0000# branch.head (detached)\u0000`).branch,
    ).toMatchObject({
      head: null,
      detached: true,
      ahead: null,
    });
    expect(() => parseStatusV2('X weird\u0000')).toThrow();
  });
});

describe('parseRawNumstat', () => {
  it('parses raw + numstat, renames, binary and combined entries', () => {
    const output = [
      `::100644 100644 100644 ${OID_A} ${OID_B} ${OID_0} MM`,
      'conflict.txt',
      `:100644 100644 ${OID_A} ${OID_0} M`,
      'a b.txt',
      `:100644 100644 ${OID_A} ${OID_A} R087`,
      'old.txt',
      'new.txt',
      `:000000 100644 ${OID_0} ${OID_B} A`,
      'bin.dat',
      '3\t1\ta b.txt',
      '0\t0\t',
      'old.txt',
      'new.txt',
      '-\t-\tbin.dat',
      '',
    ].join('\u0000');
    const { raw, numstat } = parseRawNumstat(output);
    expect(raw.map((e) => [e.status, e.srcPath, e.path, e.combined, e.score])).toEqual([
      ['U', 'conflict.txt', 'conflict.txt', true, null],
      ['M', 'a b.txt', 'a b.txt', false, null],
      ['R', 'old.txt', 'new.txt', false, 87],
      ['A', 'bin.dat', 'bin.dat', false, null],
    ]);
    expect(raw[0]).toMatchObject({ srcMode: '100644', dstMode: '100644', dstOid: OID_0 });
    expect(numstat).toEqual([
      { added: 3, deleted: 1, path: 'a b.txt', srcPath: null },
      { added: 0, deleted: 0, path: 'new.txt', srcPath: 'old.txt' },
      { added: null, deleted: null, path: 'bin.dat', srcPath: null },
    ]);
  });

  it('treats paths positionally (names that look like metadata)', () => {
    const output = [
      `:100644 100644 ${OID_A} ${OID_0} M`,
      ':100644 tricky',
      '1\t1\t:100644 tricky',
      '',
    ].join('\u0000');
    const { raw, numstat } = parseRawNumstat(output);
    expect(raw.map((e) => e.path)).toEqual([':100644 tricky']);
    expect(numstat.map((e) => e.path)).toEqual([':100644 tricky']);
  });
});

const SAMPLE_PATCH = [
  'diff --git a/plain.txt b/plain.txt',
  `index ${OID_A}..${OID_B} 100644`,
  '--- a/plain.txt',
  '+++ b/plain.txt',
  '@@ -1,2 +1,2 @@',
  ' same',
  '-diff --git a/fake b/fake',
  '+--- a/still content',
  'diff --git "a/sp ace\\ttab.txt" "b/sp ace\\ttab.txt"',
  `index ${OID_A}..${OID_B} 100644`,
  '--- "a/sp ace\\ttab.txt"\t',
  '+++ "b/sp ace\\ttab.txt"\t',
  '@@ -1 +1 @@',
  '-x',
  '+y',
  'diff --git a/a b.txt b/c d.txt',
  'similarity index 90%',
  'rename from a b.txt',
  'rename to c d.txt',
  'diff --git a/tc b/tc',
  'deleted file mode 100644',
  `index ${OID_A}..${OID_0}`,
  '--- a/tc',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-file',
  'diff --git a/tc b/tc',
  'new file mode 120000',
  `index ${OID_0}..${OID_B}`,
  '--- /dev/null',
  '+++ b/tc',
  '@@ -0,0 +1 @@',
  '+target',
  '\\ No newline at end of file',
  'diff --cc conflict.txt',
  `index ${OID_A},${OID_B}..${OID_0}`,
  '--- a/conflict.txt',
  '+++ b/conflict.txt',
  '@@@ -1,1 -1,1 +1,5 @@@',
  '++<<<<<<< HEAD',
  '* Unmerged path other.txt',
  'diff --git a/empty.txt b/empty.txt',
  'new file mode 100644',
  `index ${OID_0}..${OID_B}`,
  'diff --git a/caf\xe9.txt b/caf\xe9.txt',
  `index ${OID_A}..${OID_B} 100644`,
  'Binary files a/caf\xe9.txt and b/caf\xe9.txt differ',
  '',
].join('\n');

describe('patch splitting', () => {
  it('splits per file and identifies paths', () => {
    const chunks = splitPatch(SAMPLE_PATCH);
    expect(chunks.map((c) => [c.kind, c.key, c.srcKey])).toEqual([
      ['git', 'plain.txt', null],
      ['git', 'sp ace\ttab.txt', null],
      ['git', 'c d.txt', 'a b.txt'],
      ['git', 'tc', null],
      ['cc', 'conflict.txt', null],
      ['unmerged', 'other.txt', null],
      ['git', 'empty.txt', null],
      ['git', 'caf\xe9.txt', null],
    ]);
    expect(chunks[0]?.text).toContain('-diff --git a/fake b/fake\n+--- a/still content\n');
    expect(chunks[3]?.text.match(/^diff --git /gm)).toHaveLength(2);
    expect(chunks.map((c) => c.text).join('')).toBe(SAMPLE_PATCH);
  });

  it('gives identical results for any chunking of the stream', () => {
    const whole = splitPatch(SAMPLE_PATCH);
    for (const size of [1, 2, 3, 7, 16, 64]) {
      const pieces: Array<{ key: string; text: string }> = [];
      const splitter = new PatchSplitter((info) => {
        if (!info) return null;
        const last = pieces[pieces.length - 1];
        const target = last && last.key === info.key ? last : { key: info.key, text: '' };
        if (target !== last) pieces.push(target);
        return {
          write(data) {
            target.text += data;
          },
          end() {},
        };
      });
      for (let i = 0; i < SAMPLE_PATCH.length; i += size)
        splitter.write(SAMPLE_PATCH.slice(i, i + size));
      splitter.end();
      expect(pieces, `chunk size ${size}`).toEqual(
        whole.map((c) => ({ key: c.key, text: c.text })),
      );
    }
  });

  it('splits a long run of patches with every marker kind the same in one write or many (#42)', () => {
    const run = SAMPLE_PATCH.repeat(60);
    const one = splitPatch(SAMPLE_PATCH);
    const all = splitPatch(run);
    expect(all.map((c) => c.key)).toEqual(
      Array.from({ length: 60 }, () => one.map((c) => c.key)).flat(),
    );
    expect(all.map((c) => c.text).join('')).toBe(run);
    const rawKeys = (size: number) => {
      const keys: string[] = [];
      const splitter = new PatchSplitter((info) => {
        if (info) keys.push(info.key);
        return null;
      });
      for (let i = 0; i < run.length; i += size) splitter.write(run.slice(i, i + size));
      splitter.end();
      return keys;
    };
    const whole = rawKeys(run.length);
    expect(whole.length).toBe(60 * (one.length + 1)); // `tc` is two chunks before merging
    for (const size of [5, 4096]) expect(rawKeys(size), `chunk size ${size}`).toEqual(whole);
  });

  it('streams very long lines without losing chunk boundaries', () => {
    const long = `+${'x'.repeat(200_000)}\n`;
    const patch = `diff --git a/min.js b/min.js\n@@ -1 +1 @@\n-a\n${long}diff --git a/b b/b\n@@ -1 +1 @@\n-1\n+2\n`;
    const chunks = splitPatch(patch);
    expect(chunks.map((c) => c.key)).toEqual(['min.js', 'b']);
    expect(chunks[0]?.text.length).toBe(patch.indexOf('diff --git a/b'));
  });

  it('parses headers with quoting and ambiguity', () => {
    expect(parseChunkHeader(['diff --git a/x b/x'])?.key).toBe('x');
    expect(parseChunkHeader(['diff --git a/a b/c b/a b/c'])?.key).toBe('a b/c');
    expect(parseChunkHeader(['diff --git a/x "b/y\\"q"'])?.key).toBe('y"q');
    expect(parseChunkHeader(['diff --git "a/\\303\\251" "b/\\303\\251"'])?.key).toBe('\xc3\xa9');
    expect(
      parseChunkHeader([
        'diff --git a/x y b/z w',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/z w\t',
      ])?.key,
    ).toBe('z w');
    expect(parseChunkHeader(['* Unmerged path nl', 'name.txt'])?.key).toBe('nl\nname.txt');
    expect(unquoteMaybe('"tab\\there"')).toBe('tab\there');
    expect(unquoteMaybe('plain')).toBe('plain');
    expect(quotePathName('a"b\\c\td')).toBe('"a\\"b\\\\c\\td"');
    expect(quotePathName('caf\xe9')).toBe('caf\xe9');
  });
});

describe('parseWorktreeList', () => {
  const records = [
    ['worktree /repo', `HEAD ${OID_A}`, 'branch refs/heads/main'],
    ['worktree /bare.git', 'bare'],
    ['worktree /wt/detached', `HEAD ${OID_B}`, 'detached', 'locked agent is working'],
    [
      'worktree /wt/gone',
      `HEAD ${OID_A}`,
      'branch refs/heads/gone',
      'prunable gitdir file points to non-existent location',
    ],
    ['worktree /wt/unborn', `HEAD ${OID_0}`, 'branch refs/heads/new', 'locked'],
  ];

  it('parses -z and newline formats identically', () => {
    const z = `${records.map((r) => `${r.join('\u0000')}\u0000`).join('\u0000')}\u0000`;
    const lf = `${records.map((r) => `${r.join('\n')}\n`).join('\n')}\n`;
    const fromZ = parseWorktreeList(z, true);
    expect(parseWorktreeList(lf, false)).toEqual(fromZ);
    expect(fromZ).toEqual([
      {
        path: '/repo',
        head: OID_A,
        branch: 'refs/heads/main',
        bare: false,
        detached: false,
        locked: false,
        lockedReason: null,
        prunable: false,
        prunableReason: null,
      },
      {
        path: '/bare.git',
        head: null,
        branch: null,
        bare: true,
        detached: false,
        locked: false,
        lockedReason: null,
        prunable: false,
        prunableReason: null,
      },
      {
        path: '/wt/detached',
        head: OID_B,
        branch: null,
        bare: false,
        detached: true,
        locked: true,
        lockedReason: 'agent is working',
        prunable: false,
        prunableReason: null,
      },
      {
        path: '/wt/gone',
        head: OID_A,
        branch: 'refs/heads/gone',
        bare: false,
        detached: false,
        locked: false,
        lockedReason: null,
        prunable: true,
        prunableReason: 'gitdir file points to non-existent location',
      },
      {
        path: '/wt/unborn',
        head: null,
        branch: 'refs/heads/new',
        bare: false,
        detached: false,
        locked: true,
        lockedReason: null,
        prunable: false,
        prunableReason: null,
      },
    ]);
  });
});

describe('small parsers', () => {
  it('parses for-each-ref rows', () => {
    expect(forEachRefFormat(['refname', 'objectname'])).toBe('%(refname)%00%(objectname)');
    const rows = parseForEachRef(
      `refs/heads/main\u0000${OID_A}\nrefs/remotes/origin/HEAD\u0000${OID_B}\nbroken\n`,
      2,
    );
    expect(rows).toEqual([
      ['refs/heads/main', OID_A],
      ['refs/remotes/origin/HEAD', OID_B],
    ]);
  });

  it('parses log output', () => {
    const output = [
      OID_A,
      'aaaaaaa',
      `${OID_B} ${OID_0}`,
      'Merge it',
      'Ann',
      'ann@x',
      '1767225600',
      '1767225601',
      OID_B,
      'bbbbbbb',
      '',
      '',
      'Bob',
      'bob@x',
      '0',
      '0',
      '',
    ].join('\u0000');
    expect(parseLog(output)).toEqual([
      {
        sha: OID_A,
        shortSha: 'aaaaaaa',
        parents: [OID_B, OID_0],
        subject: 'Merge it',
        authorName: 'Ann',
        authorEmail: 'ann@x',
        authorDate: '2026-01-01T00:00:00.000Z',
        committerDate: '2026-01-01T00:00:01.000Z',
      },
      {
        sha: OID_B,
        shortSha: 'bbbbbbb',
        parents: [],
        subject: '',
        authorName: 'Bob',
        authorEmail: 'bob@x',
        authorDate: '1970-01-01T00:00:00.000Z',
        committerDate: '1970-01-01T00:00:00.000Z',
      },
    ]);
  });

  it('clamps commit dates to what an ISO timestamp can express', () => {
    const output = [OID_A, 'aaaaaaa', '', 's', 'n', 'e', '253402300800', '9999999999999', ''].join(
      '\u0000',
    );
    const [commit] = parseLog(output);
    expect(commit?.authorDate).toBe('9999-12-31T23:59:59.999Z');
    expect(commit?.committerDate).toBe('9999-12-31T23:59:59.999Z');
    expect(CommitInfoSchema.safeParse(commit).success).toBe(true);
    const old = parseLog(
      [OID_A, 'aaaaaaa', '', 's', 'n', 'e', '-99999999999', '-1', ''].join('\u0000'),
    )[0];
    expect(CommitInfoSchema.safeParse(old).success).toBe(true);
  });

  it('parses git versions', () => {
    expect(parseGitVersion('git version 2.53.0')).toMatchObject({ major: 2, minor: 53, patch: 0 });
    expect(parseGitVersion('git version 2.39.3 (Apple Git-146)')).toMatchObject({
      minor: 39,
      patch: 3,
    });
    expect(parseGitVersion('git version 2.45.1.windows.1')).toMatchObject({ minor: 45, patch: 1 });
    expect(parseGitVersion('git version 2.31')).toMatchObject({ minor: 31, patch: 0 });
    expect(parseGitVersion('git version 2.31.0')?.features).toMatchObject({
      supported: true,
      worktreeListZ: false,
    });
    expect(parseGitVersion('git version 2.30.9')?.features.supported).toBe(false);
    expect(parseGitVersion('git version 2.36.0')?.features.worktreeListZ).toBe(true);
    expect(parseGitVersion('nonsense')).toBeNull();
  });

  it('neutralizes repository-local filter drivers but keeps global ones', () => {
    const output = [
      'global',
      'filter.lfs.clean\ngit-lfs clean -- %f',
      'global',
      'filter.lfs.process\ngit-lfs filter-process',
      'global',
      'filter.lfs.required\ntrue',
      'local',
      'filter.lfs.process\n/tmp/evil',
      'local',
      'filter.evil.clean\n/tmp/evil.sh',
      'local',
      'filter.evil.required\ntrue',
      'worktree',
      'filter.a=b.smudge\n/tmp/x',
      'global',
      'filter.mine.clean\ncat',
      'local',
      'filter.flag.clean',
      '',
    ].join('\u0000');
    expect(computeFilterOverrides(output)).toEqual([
      ['filter.lfs.process', 'git-lfs filter-process'],
      ['filter.evil.clean', ''],
      ['filter.a=b.smudge', ''],
      ['filter.flag.clean', ''],
      ['filter.evil.required', 'false'],
      ['filter.a=b.required', 'false'],
      ['filter.flag.required', 'false'],
    ]);
    expect(computeFilterOverrides('')).toEqual([]);
  });
});

describe('synthesized new-file patches match git diff --no-index', () => {
  let fx: Fixture;
  beforeAll(() => {
    fx = createFixture();
  });
  afterAll(() => fx.dispose());

  const cases: Array<[string, string | Buffer]> = [
    ['text.txt', 'one\ntwo\n'],
    ['single.txt', 'only\n'],
    ['noeol.txt', 'a\nb'],
    ['empty.txt', ''],
    ['crlf.txt', 'a\r\nb\r\n'],
    ['with space.txt', 'x\n'],
    ['quo"te.txt', 'q\n'],
    ['bin.dat', Buffer.from([1, 2, 0, 3])],
  ];
  for (const [name, content] of cases) {
    it(name, () => {
      const dir = path.join(fx.root, 'synth');
      fx.write(path.join(dir, name), content);
      const expected = fx.git(
        dir,
        ['diff', '--no-index', '--full-index', '--', '/dev/null', name],
        {
          allowFail: true,
        },
      );
      const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
      const actual = synthesizeNewFilePatch(name, '100644', buffer, 'sha1');
      expect(Buffer.from(actual, 'latin1').toString('utf8')).toBe(expected);
    });
  }
});
