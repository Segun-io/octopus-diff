import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  HELPER_MAX_ARGV,
  HELPER_MAX_ENV,
  HELPER_MAX_REQUEST_FRAME,
} from '../src/runner/helper-client.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

/**
 * The only modules that may start a process, and the exact spawn calls each may make (#45): the
 * runner spawns the resolved git binary (the direct path), the client starts the helper entry with
 * Node, the helper runs the one git binary it was started with.
 */
const ALLOWED: Record<string, string[]> = {
  [path.join('runner', 'runner.ts')]: ['spawn(binary,'],
  [path.join('runner', 'helper-client.ts')]: [
    'spawn(\n      options.execPath ?? process.execPath,',
  ],
  [path.join('runner', 'git-helper.ts')]: ['spawn(GIT,'],
};
const IMPORT = "import { type ChildProcess, spawn } from 'node:child_process';";

/** Comments out of the way (they talk about spawning a lot); strings are left alone. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

const spawnCalls = (code: string): string[] => code.match(/(?<![.\w$])spawn\(\s*[^,]+,/g) ?? [];

/** Everything wrong with one source file (`name` relative to src/); empty when it is clean. */
function spawnHygieneProblems(name: string, text: string): string[] {
  const code = stripComments(text);
  const problems: string[] = [];
  const forbid = (pattern: RegExp, what: string) => {
    if (pattern.test(code)) problems.push(what);
  };
  forbid(/(?<![.\w$])exec(Sync)?\s*\(/, 'exec/execSync');
  forbid(/\bexecFile(Sync)?\b/, 'execFile');
  forbid(/\bspawnSync\b/, 'spawnSync');
  forbid(/(?<![.\w$])fork\s*\(|\bfork\b\s*[,}]/, 'fork');
  forbid(
    /\bprocess\s*\.\s*binding\b|\binternalBinding\b|process_wrap|spawn_sync/,
    'process bindings',
  );
  // `shell:` only as the literal `shell: false`.
  forbid(/\bshell\s*:(?!\s*false\b)/, 'shell: other than false');
  const mentions = code.match(/child_process/g)?.length ?? 0;
  const pinned = ALLOWED[name];
  if (!pinned) {
    if (mentions > 0) problems.push('child_process outside the runner');
    return problems;
  }
  // Exactly one mention: the one named import (no alias, namespace, require or dynamic import).
  if (mentions !== 1 || !code.includes(IMPORT)) problems.push(`not exactly: ${IMPORT}`);
  const calls = spawnCalls(code);
  if (JSON.stringify(calls) !== JSON.stringify(pinned)) {
    problems.push(`spawn calls ${JSON.stringify(calls)}`);
  }
  // `spawn` itself only in the import and those calls (no `const run = spawn`).
  const uses = code.match(/(?<![.\w$-])spawn(?![\w$-])/g)?.length ?? 0;
  if (uses !== 1 + pinned.length) problems.push(`spawn referenced ${uses} times`);
  return problems;
}

describe('process spawning hygiene', () => {
  const files = sources(SRC);
  const rel = (file: string) => path.relative(SRC, file);

  it('scans the sources', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('every source is clean, and only the three runner modules import child_process', () => {
    for (const file of files) {
      expect(spawnHygieneProblems(rel(file), readFileSync(file, 'utf8')), rel(file)).toEqual([]);
    }
    const importers = files.filter((file) =>
      stripComments(readFileSync(file, 'utf8')).includes('child_process'),
    );
    expect(importers.map(rel).sort()).toEqual(Object.keys(ALLOWED).sort());
  });

  it('the checker catches the ways around it (review #5)', () => {
    const runnerName = path.join('runner', 'runner.ts');
    const runner = readFileSync(path.join(SRC, runnerName), 'utf8');
    const withRunner = (from: string, to: string) => {
      expect(runner.includes(from), from).toBe(true);
      return spawnHygieneProblems(runnerName, runner.replace(from, to));
    };
    const extra = (code: string) => spawnHygieneProblems(runnerName, `${runner}\n${code}\n`);
    // An alias.
    expect(
      withRunner(
        IMPORT,
        "import { type ChildProcess, spawn, spawn as run } from 'node:child_process';",
      ),
    ).not.toEqual([]);
    // A namespace import.
    expect(
      extra("import * as cp from 'node:child_process';\ncp.spawn('/bin/sh', ['-c', x]);"),
    ).not.toEqual([]);
    // require and a dynamic import.
    expect(extra("const cp = require('node:child_process');")).not.toEqual([]);
    expect(extra("const cp = await import('child_process');")).not.toEqual([]);
    // fork, exec, execFile.
    expect(
      withRunner(IMPORT, "import { type ChildProcess, fork, spawn } from 'node:child_process';"),
    ).not.toEqual([]);
    expect(extra("fork('/tmp/x.js');")).not.toEqual([]);
    expect(extra("exec('ls');")).not.toEqual([]);
    expect(extra("execFile('/bin/sh');")).not.toEqual([]);
    // Another spawn call, and spawn through a variable.
    expect(extra("spawn('/bin/sh', ['-c', x]);")).not.toEqual([]);
    expect(extra("const run = spawn;\nrun('/bin/sh', ['-c', x]);")).not.toEqual([]);
    // shell: anything but false.
    expect(extra('const options = { shell: someVar };')).not.toEqual([]);
    expect(extra('const options = { shell: true };')).not.toEqual([]);
    expect(extra("const options = { shell: '/bin/sh' };")).not.toEqual([]);
    expect(extra('const options = { shell: false };')).toEqual([]);
    // Process bindings.
    expect(extra("process.binding('spawn_sync');")).not.toEqual([]);
    // child_process anywhere else.
    expect(spawnHygieneProblems('diff.ts', "const cp = require('child_process');")).not.toEqual([]);
    expect(
      spawnHygieneProblems(
        'diff.ts',
        "import { spawn } from 'node:child_process';\nspawn('git', []);",
      ),
    ).not.toEqual([]);
    // Comments are not code.
    expect(extra("// exec('ls') and spawn('/bin/sh') in a comment")).toEqual([]);
  });

  it('the client checks the limits the helper enforces (review #2)', () => {
    const helper = readFileSync(path.join(SRC, 'runner', 'git-helper.ts'), 'utf8');
    const value = (name: string) => {
      const match = new RegExp(`const ${name} = ([\\d_ *]+);`).exec(helper);
      if (!match) return Number.NaN;
      // A product of integer literals, e.g. `8 * 1024 * 1024`.
      return (match[1] as string)
        .replace(/_/g, '')
        .split('*')
        .reduce((product, factor) => product * Number(factor.trim()), 1);
    };
    expect(value('MAX_ARGV')).toBe(HELPER_MAX_ARGV);
    expect(value('MAX_ENV')).toBe(HELPER_MAX_ENV);
    expect(value('MAX_REQUEST_FRAME')).toBe(HELPER_MAX_REQUEST_FRAME);
  });
});
