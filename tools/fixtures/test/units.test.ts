import { describe, expect, it } from 'vitest';
import {
  configPathValue,
  countsFromStatus,
  createRng,
  decodePath,
  fixtureId,
  parseNumstatZ,
  parsePorcelainV2,
  parseProcStat,
  parseRawZ,
  parseWorktreeListZ,
  readProcCpu,
  sampleProcessCpu,
  summarize,
} from '../src/index.js';

const z = (...parts: Array<string | Buffer>) =>
  Buffer.concat(parts.flatMap((p) => [Buffer.isBuffer(p) ? p : Buffer.from(p), Buffer.from([0])]));

describe('rng', () => {
  it('is deterministic and in range', () => {
    const a = createRng(123);
    const b = createRng(123);
    const seqA = Array.from({ length: 20 }, () => a.int(1, 6));
    const seqB = Array.from({ length: 20 }, () => b.int(1, 6));
    expect(seqA).toEqual(seqB);
    expect(seqA.every((v) => v >= 1 && v <= 6)).toBe(true);
    expect(createRng(1).next()).not.toBe(createRng(2).next());
  });

  it('weighted() never picks zero-weight entries', () => {
    const rng = createRng(9);
    for (let i = 0; i < 200; i++) {
      expect(
        rng.weighted([
          ['a', 1],
          ['b', 0],
          ['c', 3],
        ] as const),
      ).not.toBe('b');
    }
  });
});

describe('oracle parsers', () => {
  it('decodes non-UTF-8 paths lossily with rawPath', () => {
    expect(decodePath(Buffer.from('ok.txt'))).toEqual({ path: 'ok.txt' });
    const raw = Buffer.from([0x63, 0x61, 0x66, 0xe9]);
    expect(decodePath(raw)).toEqual({ path: 'caf�', rawPath: raw.toString('base64') });
  });

  it('computes contract ids', () => {
    expect(fixtureId('/tmp/x')).toMatch(/^[0-9a-f]{16}$/);
    expect(fixtureId('/tmp/x')).toBe(fixtureId('/tmp/x'));
  });

  it('parses porcelain v2 with renames, unmerged and untracked entries', () => {
    const out = z(
      '# branch.oid abc',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
      '1 MM N... 100644 100644 100644 aaa bbb src/both file.ts',
      '2 R. N... 100644 100644 100644 aaa aaa R100 src/new.ts',
      'src/old.ts',
      'u UU N... 100644 100644 100644 100644 a b c shared.txt',
      '? untracked.txt',
    );
    const status = parsePorcelainV2(out);
    expect(status).toMatchObject({
      oid: 'abc',
      head: 'main',
      upstream: 'origin/main',
      ahead: 2,
      behind: 1,
    });
    expect(status.entries).toEqual([
      { path: 'src/both file.ts', oldPath: null, kind: 'ordinary', x: 'M', y: 'M' },
      { path: 'src/new.ts', oldPath: 'src/old.ts', kind: 'renamed', x: 'R', y: '.' },
      { path: 'shared.txt', oldPath: null, kind: 'unmerged', x: 'U', y: 'U' },
      { path: 'untracked.txt', oldPath: null, kind: 'untracked', x: '?', y: '?' },
    ]);
    expect(countsFromStatus(status.entries)).toEqual({
      staged: 2,
      unstaged: 1,
      untracked: 1,
      conflicted: 1,
    });
  });

  it('parses detached/initial headers', () => {
    const status = parsePorcelainV2(z('# branch.oid (initial)', '# branch.head (detached)'));
    expect(status).toMatchObject({ oid: null, head: null, detached: true });
  });

  it('parses raw and numstat -z output', () => {
    const raw = z(
      ':100644 100644 aaa bbb M',
      'a.txt',
      ':100644 100644 aaa aaa R090',
      'old.txt',
      'new.txt',
      ':000000 120000 000 ccc A',
      'link',
    );
    expect(parseRawZ(raw)).toEqual([
      { path: 'a.txt', oldPath: null, status: 'modified', oldMode: '100644', newMode: '100644' },
      {
        path: 'new.txt',
        oldPath: 'old.txt',
        status: 'renamed',
        oldMode: '100644',
        newMode: '100644',
      },
      { path: 'link', oldPath: null, status: 'added', oldMode: null, newMode: '120000' },
    ]);
    const numstat = z('3\t1\ta.txt', '0\t0\t', 'old.txt', 'new.txt', '-\t-\tbin.png');
    expect(parseNumstatZ(numstat)).toEqual([
      { path: 'a.txt', additions: 3, deletions: 1, binary: false },
      { path: 'new.txt', additions: 0, deletions: 0, binary: false },
      { path: 'bin.png', additions: null, deletions: null, binary: true },
    ]);
  });

  it('parses worktree list --porcelain -z', () => {
    const out = z(
      'worktree /r/main',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      'worktree /r/wt',
      'HEAD 2222222222222222222222222222222222222222',
      'detached',
      'locked reason',
      '',
    );
    expect(parseWorktreeListZ(out)).toEqual([
      {
        path: '/r/main',
        head: '1'.repeat(40),
        branch: 'main',
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      },
      {
        path: '/r/wt',
        head: '2'.repeat(40),
        branch: null,
        detached: true,
        bare: false,
        locked: true,
        prunable: false,
      },
    ]);
  });
});

describe('perf helpers', () => {
  it('parses /proc/<pid>/stat even with spaces in comm', () => {
    const fields = Array.from({ length: 50 }, (_, i) => String(i + 3));
    const parsed = parseProcStat(`42 (node (worker) x) ${fields.join(' ')}`);
    expect(parsed).toEqual({ utime: 14, stime: 15, cutime: 16, cstime: 17, rssPages: 24 });
  });

  it('summarizes with nearest-rank percentiles', () => {
    const s = summarize([5, 1, 4, 2, 3, 6, 7, 8, 9, 10]);
    expect(s).toMatchObject({ count: 10, min: 1, max: 10, mean: 5.5, p50: 5, p90: 9, p95: 10 });
    expect(summarize([]).count).toBe(0);
  });

  it.runIf(process.platform === 'linux')('samples real CPU of this process', async () => {
    const times = await readProcCpu(process.pid);
    expect(times.selfTicks).toBeGreaterThan(0);
    const busy = setInterval(() => {
      const end = Date.now() + 20;
      while (Date.now() < end) {}
    }, 25);
    try {
      const result = await sampleProcessCpu(process.pid, 600, 200);
      expect(result.supported).toBe(true);
      expect(result.intervals.length).toBeGreaterThanOrEqual(2);
      expect(result.averagePercent).toBeGreaterThan(5);
    } finally {
      clearInterval(busy);
    }
  });
});

describe('configPathValue (Windows paths in the isolated git config)', () => {
  it('turns backslashes into forward slashes, which git config accepts', () => {
    expect(
      configPathValue('C:\\Users\\runneradmin\\AppData\\Local\\Temp\\x\\.gitignore-isolated'),
    ).toBe('C:/Users/runneradmin/AppData/Local/Temp/x/.gitignore-isolated');
    expect(configPathValue('/tmp/octopus-diff-abc/.gitignore-isolated')).toBe(
      '/tmp/octopus-diff-abc/.gitignore-isolated',
    );
  });
});
