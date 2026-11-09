/**
 * README screenshot of the copy tools (docs/COPY-TOOLS.md): two diff lines selected with the Copy
 * bar showing, in light and dark. Same fixtures and daemon as `scripts/screenshots.ts`; kept apart
 * so the copy round did not have to edit the shared script.
 *
 * Usage (after `pnpm build`): pnpm --filter @octopus-diff/e2e exec tsx support/copy-screenshots.ts
 * Options: --out <dir> (default docs/screenshots), --extra <dir> (also the tree and header menus).
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { findWorktree, generateFixtures } from '@octopus-diff/fixtures';
import { chromium, type Page } from '@playwright/test';
import { AppPage } from './app.js';
import { TestDaemon } from './daemon.js';
import {
  applyChromiumLibraryPath,
  assertBuilt,
  E2ePreflightError,
  REPO_ROOT,
  scrubGitEnvironment,
  webUiProblem,
} from './env.js';

const { values: args } = parseArgs({
  options: {
    out: { type: 'string', default: join(REPO_ROOT, 'docs', 'screenshots') },
    extra: { type: 'string' },
  },
});

/** Drags over the first `count` added line numbers. */
async function dragLines(page: Page, count: number): Promise<void> {
  const boxes = await page.locator('[data-diff-scroller] [data-column-number]').evaluateAll((els) =>
    els
      .filter((e) => e.getAttribute('data-line-type') === 'change-addition')
      .map((e) => {
        const r = e.getBoundingClientRect();
        return {
          n: Number(e.getAttribute('data-column-number')),
          x: r.x + 6,
          y: r.y + r.height / 2,
        };
      }),
  );
  const a = boxes[0];
  const b = boxes[Math.min(count, boxes.length) - 1];
  if (!a || !b) throw new Error('no added lines');
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await page.mouse.up();
}

async function main() {
  scrubGitEnvironment();
  assertBuilt();
  const problem = webUiProblem();
  if (problem) throw new E2ePreflightError(problem);
  applyChromiumLibraryPath();
  await mkdir(args.out, { recursive: true });
  if (args.extra) await mkdir(args.extra, { recursive: true });

  const fixtures = await generateFixtures({ seed: 1 });
  const daemon = await TestDaemon.start({ manifest: fixtures.manifest });
  const browser = await chromium.launch();
  const written: string[] = [];
  try {
    await daemon.waitForProjects();
    for (const theme of ['light', 'dark'] as const) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        colorScheme: theme,
      });
      const page = await context.newPage();
      const app = new AppPage(page);
      await app.open(daemon.authUrl, { prefs: {} });
      const shot = async (dir: string, name: string) => {
        await page.waitForTimeout(300); // let highlighting / fonts settle
        const file = join(dir, `${name}-${theme}.png`);
        await page.screenshot({ path: file });
        written.push(file);
      };

      const login = findWorktree(fixtures.manifest, 'alpha-login').worktree;
      await app.selectWorktree(login.id);
      await app.openFile('src/login.ts');
      await app.setDiffMode('unified');
      await page.locator('[data-diff-scroller] [data-column-number]').first().waitFor();
      await dragLines(page, 3);
      await app.byTestId('copy-selection-bar').waitFor();
      await page.mouse.move(1000, 860);
      await shot(args.out, 'copy-selection');

      if (args.extra) {
        await page.keyboard.press('Escape');
        await app.byTestId('diff-header-menu').click();
        await shot(args.extra, 'copy-header-menu');
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: 'Tree view' }).click();
        await page
          .getByRole('treeitem', { name: /login\.ts/ })
          .first()
          .click({ button: 'right' });
        await page.waitForTimeout(300);
        await shot(args.extra, 'copy-tree-menu');
        const menu = page.getByTestId('file-tree-menu');
        process.stdout.write(`tree menu visible: ${await menu.isVisible()}\n`);
        if (await menu.isVisible()) {
          await page.getByTestId('copy-absolute-path').click();
          process.stdout.write(
            `toast: ${await page
              .getByTestId('copy-toast')
              .textContent()
              .catch(() => 'none')}\n`,
          );
        }
        await page.getByRole('button', { name: 'Tree view' }).click();
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
    `[copy-screenshots] FAILED: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
