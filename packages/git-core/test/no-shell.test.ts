import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

describe('process spawning hygiene', () => {
  const files = sources(SRC);

  it('scans the sources', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('never uses a shell', () => {
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/shell\s*:\s*(true|['"`])/);
      // child_process.exec/execSync (a bare call; `regex.exec(...)` is fine).
      expect(text, file).not.toMatch(/(?<![.\w])exec(Sync)?\s*\(/);
      expect(text, file).not.toMatch(/\bexecFile(Sync)?\b/);
      expect(text, file).not.toMatch(/\bspawnSync\b/);
    }
  });

  it('spawns processes only in the runner and its spawn helper, and only with spawn', () => {
    const importers = files.filter((file) =>
      readFileSync(file, 'utf8').includes('node:child_process'),
    );
    expect(importers.map((file) => path.relative(SRC, file)).sort()).toEqual([
      path.join('runner', 'git-helper.ts'),
      path.join('runner', 'helper-client.ts'),
      path.join('runner', 'runner.ts'),
    ]);
    const read = (name: string) => readFileSync(path.join(SRC, 'runner', name), 'utf8');
    const spawnCalls = (text: string) => text.match(/(?<![.\w])spawn\(\s*[^,]+,/g) ?? [];
    expect(read('runner.ts')).toMatch(
      /import \{ type ChildProcess, spawn \} from 'node:child_process';/,
    );
    // The runner spawns the resolved git binary (direct path, the helper's kill switch).
    expect(spawnCalls(read('runner.ts'))).toEqual(['spawn(binary,']);
    // The client starts only the helper entry, with Node.
    expect(spawnCalls(read('helper-client.ts'))).toEqual([
      'spawn(\n      options.execPath ?? process.execPath,',
    ]);
    // The helper runs only the git binary it was started with, never one from a message.
    expect(spawnCalls(read('git-helper.ts'))).toEqual(['spawn(GIT,']);
    for (const name of ['git-helper.ts', 'helper-client.ts']) {
      expect(read(name)).toMatch(
        /import \{ type ChildProcess, spawn \} from 'node:child_process';/,
      );
    }
  });
});
