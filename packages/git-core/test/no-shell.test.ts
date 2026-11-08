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

  it('spawns processes only in the runner, and only with spawn', () => {
    const importers = files.filter((file) =>
      readFileSync(file, 'utf8').includes('node:child_process'),
    );
    expect(importers.map((file) => path.relative(SRC, file))).toEqual([
      path.join('runner', 'runner.ts'),
    ]);
    const runner = readFileSync(path.join(SRC, 'runner', 'runner.ts'), 'utf8');
    expect(runner).toMatch(/import \{ type ChildProcess, spawn \} from 'node:child_process';/);
  });
});
