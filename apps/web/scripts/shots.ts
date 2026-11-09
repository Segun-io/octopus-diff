/**
 * Design review screenshots against a running server (default http://127.0.0.1:4173, see
 * `preview:mock`). Every registered theme at 1440×900 and 960×700, plus named states.
 *
 *   BASE_URL=http://127.0.0.1:4173 OUT=/tmp/shots pnpm --filter @octopus-diff/web shots
 */
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { THEMES } from '../src/theme/themes/index.ts';

const LIBS = path.join(homedir(), '.cache/octopus-diff-dev/chromium-libs/usr/lib/x86_64-linux-gnu');
if (existsSync(LIBS)) {
  process.env.LD_LIBRARY_PATH = [LIBS, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
}
const base = process.env.BASE_URL ?? 'http://127.0.0.1:4173';
const out = process.env.OUT ?? '/tmp/octopus-diff-shots';
const only = process.env.ONLY?.split(',').filter(Boolean);

type Step = (page: Page) => Promise<void>;

const ready = async (page: Page) => {
  await page.locator('[data-testid="app"][data-ready="true"]').waitFor({ timeout: 30_000 });
  await page.waitForTimeout(400);
};

/** Named states; each starts from a fresh load with the theme preset in localStorage. */
const STATES: Record<string, Step> = {
  inbox: async () => {},
  worktree: async (page) => {
    await page.locator('[data-testid="worktree-item"][data-branch="feat/auth"]').click();
    await page.waitForTimeout(400);
  },
  settings: async (page) => {
    await page.keyboard.press(',');
    await page.waitForTimeout(300);
  },
  'settings-review': async (page) => {
    await page.keyboard.press(',');
    await page.locator('[data-testid="settings-section"][data-section="review"]').click();
    await page.waitForTimeout(300);
  },
  'settings-appearance': async (page) => {
    await page.keyboard.press(',');
    await page.locator('[data-testid="settings-section"][data-section="appearance"]').click();
    await page.waitForTimeout(300);
  },
  'settings-about': async (page) => {
    await page.keyboard.press(',');
    await page.locator('[data-testid="settings-section"][data-section="about"]').click();
    await page.getByRole('heading', { name: 'Open-source software' }).scrollIntoViewIfNeeded();
    await page.locator('li[data-package="@pierre/diffs"] summary').click();
    await page.locator('li[data-package="@pierre/diffs"]').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
  },
  palette: async (page) => {
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(300);
  },
  'commit-scope': async (page) => {
    await page.locator('[data-testid="worktree-item"][data-branch="feat/auth"]').click();
    // The commit option stays disabled until the commit list has loaded, and selectOption does
    // not wait for an option to become enabled: the select would revert to the default scope.
    const scope = page.locator('[data-testid="scope-select"]');
    await scope.locator('option[value="commit"]:not([disabled])').waitFor({ state: 'attached' });
    await scope.selectOption('commit');
    const value = await scope.inputValue();
    if (value !== 'commit') throw new Error(`commit-scope: the scope is "${value}", not "commit"`);
    await page.waitForTimeout(400);
  },
  'policy-menu': async (page) => {
    await page.locator('[data-testid="worktree-item"][data-branch="feat/auth"]').click();
    await page.locator('[data-testid="review-policy-chip"]').click();
    await page.waitForTimeout(300);
  },
  folder: async (page) => {
    await page.locator('[data-folder-id] button[title^="/home/dev/code"]').first().click();
    await page.waitForTimeout(400);
  },
  project: async (page) => {
    await page
      .locator('[data-testid="project-item"][data-project-name="octopus-api"] button[title]')
      .first()
      .click();
    await page.waitForTimeout(400);
  },
  'project-branches': async (page) => {
    await STATES.project?.(page);
    await page.locator('[data-testid="overview-tab"][data-tab="branches"]').click();
    await page.waitForTimeout(300);
  },
  'project-requests': async (page) => {
    await STATES.project?.(page);
    await page.locator('[data-testid="overview-tab"][data-tab="requests"]').click();
    await page.waitForTimeout(300);
  },
  'context-menu': async (page) => {
    await page
      .locator('[data-testid="worktree-item"][data-branch="feat/auth"]')
      .click({ button: 'right' });
    await page.waitForTimeout(300);
  },
  request: async (page) => {
    await page.locator('[data-testid="worktree-item"][data-branch="feat/auth"]').click();
    await page.locator('[data-testid="worktree-tab"][data-tab="request"]').click();
    await page.locator('[data-testid="request-view"][data-status="ok"]').waitFor();
    await page.waitForTimeout(500);
  },
  'request-conversation': async (page) => {
    await STATES.request?.(page);
    await page.getByRole('button', { name: 'Description' }).click();
    await page.locator('[data-testid="request-conversation-item"]').first().waitFor();
    await page.waitForTimeout(400);
  },
  'request-timeline': async (page) => {
    await STATES.request?.(page);
    await page.locator('[data-testid="request-tab"][data-tab="timeline"]').click();
    await page.locator('[data-testid="request-timeline-item"]').first().waitFor();
    await page.waitForTimeout(400);
  },
  'request-files': async (page) => {
    await STATES.request?.(page);
    await page.locator('[data-testid="request-tab"][data-tab="files"]').click();
    await page.waitForTimeout(300);
  },
  'hover-card': async (page) => {
    await page.locator('[data-testid="worktree-item"][data-branch="feat/auth"]').hover();
    await page.locator('[data-testid="change-request-hover-block"]').waitFor();
    await page.waitForTimeout(300);
  },
  help: async (page) => {
    await page.keyboard.press('?');
    await page.waitForTimeout(300);
  },
};

async function main() {
  await mkdir(out, { recursive: true });
  const browser = await chromium.launch();
  const states = process.env.STATES?.split(',').filter(Boolean) ?? ['inbox', 'worktree'];
  const sizes = [
    { w: 1440, h: 900 },
    { w: 960, h: 700 },
  ];
  for (const theme of THEMES) {
    if (only && !only.includes(theme.id)) continue;
    for (const size of sizes) {
      for (const state of states) {
        const step = STATES[state];
        if (!step) throw new Error(`unknown state ${state}`);
        const context = await browser.newContext({
          viewport: { width: size.w, height: size.h },
          colorScheme: theme.kind,
          reducedMotion: 'reduce',
        });
        await context.addInitScript(
          (prefs: string) => {
            localStorage.setItem('octopus-diff:prefs', prefs);
          },
          JSON.stringify({ version: 2, theme: { mode: theme.kind, [theme.kind]: theme.id } }),
        );
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));
        page.on('console', (m) => {
          if (m.type() === 'error') errors.push(m.text());
        });
        await page.goto(base);
        await ready(page);
        try {
          await step(page);
        } catch (err) {
          console.warn(`state ${state} failed on ${theme.id}: ${String(err).split('\n')[0]}`);
        }
        const file = path.join(out, `${theme.id}-${size.w}-${state}.png`);
        await page.screenshot({ path: file });
        console.log(file, errors.length ? `errors: ${errors.join(' | ')}` : '');
        await context.close();
      }
    }
  }
  await browser.close();
}

await main();
