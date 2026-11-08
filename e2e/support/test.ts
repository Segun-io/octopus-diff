import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  allWorktrees,
  type FixtureManifest,
  type IsolatedGitEnv,
  type ProjectFixture,
  readManifestFile,
  registeredProjects,
  type WorktreeFixture,
} from '@octopus-diff/fixtures';
import { test as base, expect } from '@playwright/test';
import { AppPage } from './app.js';
import { TestDaemon } from './daemon.js';
import { ENV } from './env.js';

/** Records original file contents so a test can mutate the mutable fixture and put it back. */
export class FileEdits {
  #originals = new Map<string, Buffer | null>();

  async #remember(path: string) {
    if (this.#originals.has(path)) return;
    this.#originals.set(path, existsSync(path) ? await readFile(path) : null);
  }

  async write(path: string, content: string): Promise<void> {
    await this.#remember(path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }

  async append(path: string, content: string): Promise<void> {
    await this.#remember(path);
    await appendFile(path, content);
  }

  async remove(path: string): Promise<void> {
    await this.#remember(path);
    await rm(path, { force: true });
  }

  async restore(): Promise<void> {
    for (const [path, original] of this.#originals) {
      if (original === null) await rm(path, { force: true });
      else await writeFile(path, original);
    }
    this.#originals.clear();
  }
}

interface WorkerFixtures {
  manifest: FixtureManifest;
  gitEnv: IsolatedGitEnv;
}

interface TestFixtures {
  /** A daemon with every fixture project registered (fresh state dir per test). */
  daemon: TestDaemon;
  app: AppPage;
  edits: FileEdits;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  manifest: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright fixtures require a destructuring pattern.
    async ({}, use) => {
      const path = process.env[ENV.manifest];
      if (!path)
        throw new Error(`${ENV.manifest} is not set: run the suite with \`pnpm test:e2e\``);
      await use(await readManifestFile(path));
    },
    { scope: 'worker' },
  ],
  gitEnv: [
    async ({ manifest }, use) => {
      await use({ configPath: manifest.git.configPath, vars: manifest.git.vars });
    },
    { scope: 'worker' },
  ],
  daemon: async ({ manifest }, use) => {
    const daemon = await TestDaemon.start({ manifest });
    try {
      await daemon.waitForProjects();
      await use(daemon);
    } finally {
      await daemon.close();
    }
  },
  app: async ({ page }, use) => {
    await use(new AppPage(page));
  },
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixtures require a destructuring pattern.
  edits: async ({}, use) => {
    const edits = new FileEdits();
    try {
      await use(edits);
    } finally {
      await edits.restore();
    }
  },
});

export { countPatchLines, hasComparableLineCounts, sampleLines, statusMatches } from './patch.js';
export { expect };

// --- manifest helpers ------------------------------------------------------------------------

/** Every non-bare worktree of every project the daemon should know. */
export function registeredCheckouts(
  manifest: FixtureManifest,
): Array<{ project: ProjectFixture; worktree: WorktreeFixture }> {
  const names = new Set(registeredProjects(manifest).map((p) => p.name));
  return allWorktrees(manifest, (p) => names.has(p.name)).filter(({ worktree }) => !worktree.bare);
}

export function dirtyCheckouts(manifest: FixtureManifest) {
  return registeredCheckouts(manifest).filter(({ worktree }) => worktree.dirty);
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
