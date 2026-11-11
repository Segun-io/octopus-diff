/**
 * Test fixtures: scratch repositories under the OS temp dir with fully isolated git config.
 *
 * Fixture *setup* runs git directly (spawnSync with an argv array, never a shell); this is the
 * one place outside the runner allowed to spawn git (AGENTS.md). Every process gets
 * GIT_CONFIG_GLOBAL pointing at a file inside the temp dir and GIT_CONFIG_NOSYSTEM=1, so the
 * developer's global config (core.autocrlf=input, core.pager=delta, ...) never leaks in.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GitCoreOptions } from '@octopus-diff/contracts';

export interface Fixture {
  /** Realpath of the temp dir. */
  root: string;
  env: Record<string, string>;
  /** Options for createGitCore with the same isolation. */
  coreOptions(extra?: GitCoreOptions): GitCoreOptions;
  git(cwd: string, args: string[], options?: { allowFail?: boolean; input?: string }): string;
  /** Creates a repo at `root/<name>` with one commit (unless `empty`). */
  repo(name: string, options?: { empty?: boolean; files?: Record<string, string> }): string;
  write(file: string, content: string | Buffer): void;
  /** Writes a file whose name is raw bytes (e.g. not valid UTF-8) inside `dir`. */
  writeRaw(dir: string, name: Buffer, content: string | Buffer): void;
  symlink(target: string, file: string): void;
  commitAll(cwd: string, message: string): string;
  dispose(): void;
}

const FIXED_DATE = '2026-01-01T00:00:00Z';

/**
 * Whether the temp dir's file system accepts file names that are not valid UTF-8. Linux file
 * systems take any bytes; APFS (macOS) refuses them with EILSEQ, so tests that need such a name
 * skip it there (the parsers are still covered by synthetic git output in parsers.test.ts).
 */
export const RAW_NAMES_SUPPORTED: boolean = probeRawNames();

function probeRawNames(): boolean {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'octopus-diff-probe-'));
  try {
    writeFileSync(Buffer.concat([Buffer.from(`${dir}/`), Buffer.from([0x78, 0xff])]), '');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EILSEQ') return false;
    throw error;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function createFixture(prefix = 'octopus-diff-'): Fixture {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  const configFile = path.join(root, '.gitconfig-test');
  writeFileSync(
    configFile,
    [
      '[user]',
      '\tname = Fixture User',
      '\temail = fixture@example.com',
      '[init]',
      '\tdefaultBranch = main',
      '[commit]',
      '\tgpgsign = false',
      '[tag]',
      '\tgpgsign = false',
      '[core]',
      '\tautocrlf = false',
      '[protocol "file"]',
      '\tallow = always',
      '',
    ].join('\n'),
  );
  const env: Record<string, string> = {
    GIT_CONFIG_GLOBAL: configFile,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture User',
    GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'Fixture User',
    GIT_COMMITTER_EMAIL: 'fixture@example.com',
    GIT_AUTHOR_DATE: FIXED_DATE,
    GIT_COMMITTER_DATE: FIXED_DATE,
  };
  const processEnv: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.startsWith('GIT_')) processEnv[name] = value;
  }
  const fullEnv = { ...processEnv, ...env, LC_ALL: 'C' };

  const fixture: Fixture = {
    root,
    env,
    coreOptions(extra = {}) {
      return { ...extra, env: { ...env, ...(extra.env ?? {}) } };
    },
    git(cwd, args, options = {}) {
      const result = spawnSync('git', args, {
        cwd,
        env: fullEnv,
        encoding: 'utf8',
        input: options.input,
        maxBuffer: 256 * 1024 * 1024,
      });
      if (result.error) throw result.error;
      if (result.status !== 0 && !options.allowFail) {
        throw new Error(
          `git ${args.join(' ')} failed in ${cwd} (exit ${result.status}): ${result.stderr}`,
        );
      }
      return result.stdout;
    },
    repo(name, options = {}) {
      const dir = path.join(root, name);
      mkdirSync(dir, { recursive: true });
      fixture.git(dir, ['init', '-q', '.']);
      if (!options.empty) {
        const files = options.files ?? { 'README.md': `# ${name}\n` };
        for (const [file, content] of Object.entries(files)) {
          fixture.write(path.join(dir, file), content);
        }
        fixture.commitAll(dir, 'initial');
      }
      return dir;
    },
    write(file, content) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
    },
    writeRaw(dir, name, content) {
      writeFileSync(Buffer.concat([Buffer.from(`${dir}/`), name]), content);
    },
    symlink(target, file) {
      mkdirSync(path.dirname(file), { recursive: true });
      symlinkSync(target, file);
    },
    commitAll(cwd, message) {
      fixture.git(cwd, ['add', '-A']);
      fixture.git(cwd, ['commit', '-q', '--allow-empty', '-m', message]);
      return fixture.git(cwd, ['rev-parse', 'HEAD']).trim();
    },
    dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
  return fixture;
}

/** Line-oriented file content helper. */
export function lines(count: number, prefix = 'line'): string {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}\n`).join('');
}
