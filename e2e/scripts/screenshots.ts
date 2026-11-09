/**
 * README screenshots: inbox, diff in split and unified mode, the sidebar filter, each in light and dark themes, from
 * the acceptance fixtures. Writes PNGs to docs/screenshots/ (override with --out <dir>).
 *
 * Usage (after `pnpm build`): pnpm --filter @octopus-diff/fixtures screenshots
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { TEST_IDS } from '@octopus-diff/contracts';
import { findWorktree, generateFixtures } from '@octopus-diff/fixtures';
import { chromium } from '@playwright/test';
import { AppPage } from '../support/app.js';
import { TestDaemon } from '../support/daemon.js';
import {
  applyChromiumLibraryPath,
  assertBuilt,
  E2ePreflightError,
  REPO_ROOT,
  scrubGitEnvironment,
  webUiProblem,
} from '../support/env.js';

const { values: args } = parseArgs({
  options: {
    out: { type: 'string', default: join(REPO_ROOT, 'docs', 'screenshots') },
    scale: { type: 'string', default: '1' },
  },
});

async function main() {
  scrubGitEnvironment();
  assertBuilt();
  const problem = webUiProblem();
  if (problem) throw new E2ePreflightError(problem);
  applyChromiumLibraryPath();
  await mkdir(args.out, { recursive: true });

  const fixtures = await generateFixtures({ seed: 1 });
  const daemon = await TestDaemon.start({ manifest: fixtures.manifest });
  const browser = await chromium.launch();
  const written: string[] = [];
  try {
    await daemon.waitForProjects();
    for (const theme of ['light', 'dark'] as const) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: Number(args.scale),
        colorScheme: theme,
      });
      const page = await context.newPage();
      const app = new AppPage(page);
      // Real defaults (the Settled shelf closed), not the specs' seeded prefs.
      await app.open(daemon.authUrl, { prefs: {} });
      const shot = async (name: string) => {
        await page.waitForTimeout(300); // let highlighting / fonts settle
        const file = join(args.out, `${name}-${theme}.png`);
        await page.screenshot({ path: file });
        written.push(file);
      };

      await app.selectInbox();
      const login = findWorktree(fixtures.manifest, 'alpha-login').worktree;
      await app.openFile('src/login.ts', login.id);
      await shot('inbox');

      const sink = findWorktree(fixtures.manifest, 'kitchen-sink').worktree;
      await app.selectWorktree(sink.id);
      await app.openFile('src/both.ts');
      await app.setDiffMode('split');
      await shot('diff-split');
      await app.setDiffMode('unified');
      await shot('diff-unified');

      // Folder picker: the add dialog browsing the folder that holds alpha and its siblings.
      const alphaDir = findWorktree(fixtures.manifest, 'alpha').worktree.path;
      await app.byTestId(TEST_IDS.addProjectButton).click();
      await app.byTestId(TEST_IDS.folderPickerInput).fill(alphaDir.replace(/[^/]+$/, ''));
      await app.byTestId(TEST_IDS.folderPickerEntry).first().waitFor();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await shot('folder-picker');
      await page.keyboard.press('Escape');

      // The command palette turns into the same browser when its text is a path.
      await page.keyboard.press('Control+k');
      await app.byTestId(TEST_IDS.commandPaletteInput).fill(alphaDir.replace(/[^/]+$/, ''));
      await app.byTestId(TEST_IDS.folderPickerEntry).first().waitFor();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await shot('palette-browse');
      await page.keyboard.press('Escape');

      // The sidebar filter: `/` opens the dropdown; one project picked, searching worktrees.
      const alphaProject = findWorktree(fixtures.manifest, 'alpha').project;
      await page.keyboard.press('/');
      await app.byTestId(TEST_IDS.sidebarFilterSearch).waitFor();
      await app.byTestId(TEST_IDS.onlyDirtyToggle).click();
      await app
        .byTestId(TEST_IDS.sidebarFilterOption)
        .and(page.locator(`[data-project-id="${alphaProject.id}"]`))
        .click();
      await shot('sidebar-filter');
      await page.keyboard.press('Escape');
      await app.byTestId(TEST_IDS.sidebarFilterClear).click();
      await app.focusApp();

      await page.keyboard.press('?');
      if (await app.byTestId(TEST_IDS.helpDialog).isVisible()) {
        await shot('help');
        await page.keyboard.press('Escape');
      }
      await context.close();
    }
  } finally {
    await browser.close();
    await daemon.close();
    await fixtures.cleanup();
  }
  for (const file of written) process.stdout.write(`${file}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `[screenshots] FAILED: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
