import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixtureId, type IsolatedGitEnv, runGit } from '@octopus-diff/fixtures';

/**
 * Creates small throw-away repositories during a test (for "review on by default for new
 * repos / worktrees"). Everything lives under the fixture root (OS temp dir) with the isolated
 * git config from the manifest; nothing here touches a control repository.
 */
export interface CreatedRepo {
  dir: string;
  /** Worktree id of the main checkout (`hashId(realpath)`; the fixture root is a realpath). */
  worktreeId: string;
  projectId: string;
}

export async function createRepo(
  parent: string,
  name: string,
  env: IsolatedGitEnv,
): Promise<CreatedRepo> {
  const dir = join(parent, name);
  await mkdir(dir, { recursive: true });
  await runGit(['init', '-q', dir], { cwd: parent, env });
  await writeFile(join(dir, 'README.md'), `# ${name}\n`);
  await runGit(['add', '-A'], { cwd: dir, env });
  await runGit(['commit', '-q', '-m', 'initial'], {
    cwd: dir,
    env,
    extraEnv: {
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    },
  });
  // Dirty from the start so it shows up in the Inbox.
  await writeFile(join(dir, 'work.txt'), 'agent output\n');
  return { dir, worktreeId: fixtureId(dir), projectId: fixtureId(join(dir, '.git')) };
}

export async function addWorktree(
  repo: CreatedRepo,
  path: string,
  branch: string,
  env: IsolatedGitEnv,
): Promise<string> {
  await runGit(['worktree', 'add', '-q', '-b', branch, path], { cwd: repo.dir, env });
  await writeFile(join(path, 'work.txt'), 'more agent output\n');
  return fixtureId(path);
}
