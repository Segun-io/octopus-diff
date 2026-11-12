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

/**
 * The sidebar gallery (#14): every look a row has, from the mock's `gallery` dataset. Start the
 * server with it, e.g. `MOCK_DATASET=gallery MOCK_INTERVAL_MS=0 WEB_PORT=5391 pnpm --filter @octopus-diff/web dev:mock`
 * (`MOCK_INTERVAL_MS=0` stops the mock's random edits, which would change counts and ages mid-shot),
 * then `BASE_URL=http://127.0.0.1:5391 STATES=sidebar-gallery,sidebar-gallery-narrow,... pnpm shots`.
 * These states screenshot the sidebar alone (see `CLIPS`) in a tall viewport so the whole list shows.
 */
const GALLERY_HEIGHT = 1500;

const galleryReady = async (page: Page) => {
  await page.setViewportSize({ width: page.viewportSize()?.width ?? 1440, height: GALLERY_HEIGHT });
  const row = page.locator('[data-testid="worktree-item"][data-branch="feat/one-thousand-files"]');
  await row.waitFor({ timeout: 10_000 }).catch(() => {
    throw new Error('the gallery states need the mock with MOCK_DATASET=gallery');
  });
  await page.waitForTimeout(300);
};

/** Sets the width of the sidebar's grid cell (the app gives it 200 to 260 px). */
const sidebarWidth = (page: Page, px: number) =>
  page.addStyleTag({
    content: `[data-testid="sidebar"] { width: ${px}px; }`,
  });

/** The `activity` state seeds the agent's changes once (see the state). */
let activitySeeded = false;
let activityWorktree: string | null = null;

/** Named states; each starts from a fresh load with the theme preset in localStorage. */
const STATES: Record<string, Step> = {
  inbox: async () => {},
  worktree: async (page) => {
    await page.locator('[data-testid="worktree-item"][data-branch="feat/auth"]').click();
    await page.waitForTimeout(400);
  },
  // Merge noise (#34): To review of feat/auth, the "From origin/main" group collapsed, then open.
  'merge-noise': async (page) => {
    await page.locator('[data-testid="worktree-item"][data-branch="feat/auth"]').click();
    await page.locator('[data-testid="scope-select"]').selectOption('review');
    await page.locator('[data-testid="from-main-group"]').waitFor();
    await page.waitForTimeout(400);
  },
  'merge-noise-open': async (page) => {
    await STATES['merge-noise']?.(page);
    await page.locator('[data-testid="from-main-group"]').click();
    await page.locator('[data-testid="file-item"][data-origin="base"]').first().waitFor();
    await page.locator('[data-testid="from-main-group"]').scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
  },
  'merge-noise-chip': async (page) => {
    await STATES['merge-noise']?.(page);
    await page.locator('[data-testid="from-main-chip"]').click();
    await page.waitForTimeout(400);
  },
  // Live view (#39): a simulated agent edits, deletes (tracked and untracked) and commits in
  // feat/auth; the strip is opened and the deleted file's content shown. The agent changes the
  // mock's shared worktree, so the state is in `MUTATING_STATES`: it runs after every other shot
  // (so none inherits its changes) and seeds the changes once, not once per theme and size.
  activity: async (page) => {
    const id = await page
      .locator('[data-testid="worktree-item"][data-branch="feat/auth"]')
      .getAttribute('data-worktree-id');
    await page.locator('[data-testid="worktree-item"][data-branch="feat/auth"]').click();
    await page.locator('[data-testid="activity-strip"]').waitFor();
    const act = async (action: string, path = '') => {
      const q = `worktreeId=${id}&action=${action}${path ? `&path=${encodeURIComponent(path)}` : ''}`;
      await page.request.post(`${base}/api/__mock/mutate?${q}`);
      await page.waitForTimeout(250);
    };
    if (!activitySeeded) {
      activitySeeded = true;
      activityWorktree = id;
      await act('edit', 'src/auth/token.ts');
      await act('delete-untracked', 'notes/todo.md');
      await act('delete', 'src/auth/session.ts');
      await page.request.post(
        `${base}/api/__mock/activity?worktreeId=${id}&mode=polling&pollMs=5000`,
      );
      await act('edit', 'src/auth/token.ts');
    }
    await page.locator('[data-testid="activity-toggle"]').click();
    await page.locator('[data-testid="activity-view-content"]').first().click();
    await page.locator('[data-testid="activity-content"]').waitFor();
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
  // The sidebar has no folder or project headers (#13): the Overviews open from a row's menu.
  folder: async (page) => {
    await page
      .locator('[data-testid="worktree-item"][data-project-name="octopus-api"]')
      .first()
      .click({ button: 'right' });
    await page.getByRole('menuitem', { name: /^Overview of folder / }).click();
    await page.waitForTimeout(400);
  },
  project: async (page) => {
    await page
      .locator('[data-testid="worktree-item"][data-project-name="octopus-api"]')
      .first()
      .click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Overview of octopus-api' }).click();
    await page.waitForTimeout(400);
  },
  // The flat sidebar (#13): one worktree hidden by hand, the closed "Hidden" section opened.
  'sidebar-hidden': async (page) => {
    const row = page.locator('[data-testid="worktree-item"][data-branch="fix/cache"]');
    await row.hover();
    await row.locator('xpath=..').getByRole('button', { name: 'Hide until it changes' }).click();
    await page.getByRole('button', { name: 'Expand hidden' }).click();
    await page.waitForTimeout(300);
  },
  // The filter picker with its Folders group (#13).
  'sidebar-filter': async (page) => {
    await page.locator('[data-testid="sidebar-filter"]').click();
    await page.waitForTimeout(300);
  },
  'sidebar-gallery': async (page) => {
    await galleryReady(page);
  },
  'sidebar-gallery-narrow': async (page) => {
    await galleryReady(page);
    await sidebarWidth(page, 200);
  },
  // Hover (the hide action shows), keyboard focus (the same) and selection, on three rows.
  'sidebar-gallery-states': async (page) => {
    await galleryReady(page);
    await page.locator('[data-testid="worktree-item"][data-branch="feat/nine"]').click();
    await page.locator('[data-testid="worktree-item"][data-branch="feat/ninety-nine"]').focus();
    await page.keyboard.press('Tab');
    await page.locator('[data-testid="worktree-item"][data-branch="feat/pr-open"]').hover();
    await page.waitForTimeout(200);
  },
  'sidebar-gallery-hidden': async (page) => {
    await galleryReady(page);
    const row = page.locator('[data-testid="worktree-item"][data-branch="feat/reviewed"]');
    await row.hover();
    await row.locator('xpath=..').getByRole('button', { name: 'Hide until it changes' }).click();
    await page.getByRole('button', { name: 'Expand hidden' }).click();
    await page.waitForTimeout(300);
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
  // Loading states (#11). `wait-forge` needs the server started with MOCK_FORGE_LATENCY_MS=60000
  // (the forge never answers); the others change the mock's forge state through its control endpoint.
  'wait-forge': async (page) => {
    await page.locator('[data-testid="worktree-item"][data-branch="feat/auth"]').click();
    await page.locator('[data-testid="worktree-tab"][data-tab="request"]').click();
    await page.locator('[data-testid="request-view"][data-status="loading"]').waitFor();
    await page
      .getByText(/Waiting for Git(Hub|Lab)…/)
      .first()
      .waitFor({ timeout: 5000 });
  },
  'rate-limit': async (page) => {
    await simulate(page, 'pending=1&budget=backoff');
    await page.locator('[data-testid="sidebar-status"][data-state="waiting"]').waitFor();
    await page.waitForTimeout(300);
  },
  'rate-limit-stale': async (page) => {
    await simulate(page, 'budget=backoff&fetchedAgoMs=180000');
    await page.locator('[data-testid="sidebar-status"][data-state="stale"]').waitFor();
    await page.waitForTimeout(300);
  },
  'stale-request': async (page) => {
    await simulate(page, 'error=GraphQL%3A%20timeout&fetchedAgoMs=180000');
    await page.locator('[data-testid="worktree-item"][data-branch="feat/auth"]').click();
    await page.locator('[data-testid="worktree-tab"][data-tab="request"]').click();
    await page.locator('[data-testid="request-view"][data-status="ok"]').waitFor();
    await page.locator('[data-testid="stale-note"]').first().waitFor();
    await page.waitForTimeout(300);
  },
};

/**
 * States that change the mock's shared worktree data (no reset exists for it): run after all
 * the others, so no other shot starts from their changes.
 */
const MUTATING_STATES = new Set(['activity']);

/** States whose shot is one element, not the page (a selector). */
const CLIPS: Record<string, string> = {
  'sidebar-gallery': '[data-testid="sidebar"]',
  'sidebar-gallery-narrow': '[data-testid="sidebar"]',
  'sidebar-gallery-states': '[data-testid="sidebar"]',
  'sidebar-gallery-hidden': '[data-testid="sidebar"]',
};

/** States that change the mock's shared forge state (each resets it when its shot is done). */
const SIMULATED_STATES = new Set(['rate-limit', 'rate-limit-stale', 'stale-request']);

/** Sets the mock's forge state (`POST /api/__mock/forge-sim`, see mock/server.ts); no query resets it. */
async function simulate(page: Page, query: string): Promise<void> {
  const response = await page.request.post(`${base}/api/__mock/forge-sim?${query}`);
  if (!response.ok()) throw new Error(`forge-sim failed: ${response.status()}`);
}

async function main() {
  await mkdir(out, { recursive: true });
  const browser = await chromium.launch();
  const requested = process.env.STATES?.split(',').filter(Boolean) ?? ['inbox', 'worktree'];
  // Passes: the states that leave the mock as it was, then the ones that change it.
  const passes = [
    requested.filter((state) => !MUTATING_STATES.has(state)),
    requested.filter((state) => MUTATING_STATES.has(state)),
  ];
  const sizes = [
    { w: 1440, h: 900 },
    { w: 960, h: 700 },
  ];
  for (const states of passes) {
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
            try {
              await step(page);
            } catch (err) {
              console.warn(`state ${state} failed on ${theme.id}: ${String(err).split('\n')[0]}`);
            }
            const file = path.join(out, `${theme.id}-${size.w}-${state}.png`);
            const clip = CLIPS[state];
            if (clip) await page.locator(clip).screenshot({ path: file });
            else await page.screenshot({ path: file });
            console.log(file, errors.length ? `errors: ${errors.join(' | ')}` : '');
          } finally {
            // The mock server is shared by every shot and a fresh browser context does not reset it:
            // put the forge knobs back (also when the shot failed) so the next image shows the
            // plain fixture, not this one's rate limit or error.
            if (SIMULATED_STATES.has(state)) {
              await simulate(page, '').catch((err) =>
                console.warn(`could not reset the forge simulation: ${String(err).split('\n')[0]}`),
              );
            }
            await context.close();
          }
        }
      }
    }
  }
  if (activityWorktree) {
    // The watch note is the only thing the seeding set that a later run of the script could see
    // (the feed itself goes with the server).
    await fetch(`${base}/api/__mock/activity?worktreeId=${activityWorktree}&mode=native`, {
      method: 'POST',
    }).catch(() => {});
  }
  await browser.close();
}

await main();
