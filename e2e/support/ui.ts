import type { ApiClient } from '@octopus-diff/contracts';
import { TEST_IDS } from '@octopus-diff/contracts';
import type { FixtureManifest, IsolatedGitEnv } from '@octopus-diff/fixtures';
import {
  expect,
  type Locator,
  type Page,
  type PlaywrightTestArgs,
  type PlaywrightTestOptions,
  type PlaywrightWorkerArgs,
  type PlaywrightWorkerOptions,
  type TestInfo,
  type TestType,
} from '@playwright/test';
import { AppPage } from './app.js';
import type { TestDaemon } from './daemon.js';
import { test as base, type FileEdits } from './test.js';

/**
 * UI round 1 page object (settings, review policy, bulk review) plus a console/CSP guard: every
 * test using `ui` fails when the page logged an error or warning or reported a CSP violation,
 * unless the test explicitly allowed a pattern (e.g. connection errors while the daemon restarts).
 */

const tid = (id: string) => `[data-testid="${id}"]`;

export interface ConsoleGuard {
  readonly errors: string[];
  readonly warnings: string[];
  readonly csp: string[];
  /** Accept messages matching any pattern (recorded in the report). */
  allow(...patterns: RegExp[]): void;
  /** Also watch another page of the same test (second tab). */
  watch(page: Page): void;
}

declare global {
  interface Window {
    __octopusCsp?: string[];
    __octopusFirstRender?: { theme: string | null; dark: boolean } | null;
  }
}

const CSP_LISTENER = () => {
  window.__octopusCsp = [];
  document.addEventListener('securitypolicyviolation', (e) => {
    window.__octopusCsp?.push(
      `${e.violatedDirective} blocked ${e.blockedURI} at ${e.sourceFile}:${e.lineNumber}:${e.columnNumber}` +
        (e.sample ? ` sample=${e.sample.slice(0, 80)}` : ''),
    );
  });
};

/** Records `data-theme` / `.dark` of `<html>` the moment the React root gets its first child. */
export const FIRST_RENDER_PROBE = () => {
  window.__octopusFirstRender = null;
  const observer = new MutationObserver(() => {
    const root = document.getElementById('root');
    if (root && root.childElementCount > 0) {
      window.__octopusFirstRender = {
        theme: document.documentElement.getAttribute('data-theme'),
        dark: document.documentElement.classList.contains('dark'),
      };
      observer.disconnect();
    }
  });
  // Init scripts run before <html> exists: observe the document itself.
  observer.observe(document, { childList: true, subtree: true });
};

function createGuard(testInfo: TestInfo): ConsoleGuard & { finish(): Promise<void> } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const csp: string[] = [];
  const allowed: RegExp[] = [];
  const pages = new Set<Page>();
  const guard = {
    errors,
    warnings,
    csp,
    allow: (...patterns: RegExp[]) => {
      allowed.push(...patterns);
    },
    watch(page: Page) {
      if (pages.has(page)) return;
      pages.add(page);
      page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(msg.text());
        else if (msg.type() === 'warning') warnings.push(msg.text());
      });
      page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
      void page.addInitScript(CSP_LISTENER);
    },
    async finish() {
      for (const page of pages) {
        if (page.isClosed()) continue;
        const list = await page.evaluate(() => window.__octopusCsp ?? []).catch(() => []);
        csp.push(...list);
      }
      const keep = (m: string) => !allowed.some((p) => p.test(m));
      const summary = `${errors.length} console errors, ${warnings.length} warnings, ${csp.length} CSP violations${
        allowed.length ? ` (allowed: ${allowed.map(String).join(' ')})` : ''
      }`;
      testInfo.annotations.push({ type: 'console-guard', description: summary });
      expect.soft(errors.filter(keep), 'console errors').toEqual([]);
      expect.soft(warnings.filter(keep), 'console warnings').toEqual([]);
      expect(csp.filter(keep), 'CSP violations').toEqual([]);
    },
  };
  return guard;
}

export class UiPage extends AppPage {
  get markAll(): Locator {
    return this.byTestId(TEST_IDS.markAllButton);
  }
  get toast(): Locator {
    return this.byTestId(TEST_IDS.bulkReviewToast);
  }
  get undoButton(): Locator {
    return this.byTestId(TEST_IDS.bulkReviewUndo);
  }
  get chip(): Locator {
    return this.byTestId(TEST_IDS.reviewPolicyChip);
  }
  get policyMenu(): Locator {
    return this.byTestId(TEST_IDS.reviewPolicyMenu);
  }
  get confirmDialog(): Locator {
    return this.page.getByRole('alertdialog');
  }
  get contextMenu(): Locator {
    return this.page.getByRole('menu', { name: 'Actions' });
  }
  get settings(): Locator {
    return this.byTestId(TEST_IDS.settingsDialog);
  }
  get reviewDefaultSwitch(): Locator {
    return this.byTestId(TEST_IDS.settingsReviewDefault);
  }

  reviewOffBadge(worktreeId: string): Locator {
    return this.worktreeItem(worktreeId).locator(tid(TEST_IDS.reviewOffBadge));
  }

  /** The sidebar's unreviewed count badge of a worktree row (absent when 0 or review is off). */
  unreviewedBadge(worktreeId: string): Locator {
    return this.worktreeItem(worktreeId).locator('[title$=" unreviewed"]');
  }

  policyItem(
    target: 'worktree' | 'branch' | 'project' | 'folder',
    state: 'on' | 'off' | 'inherit',
  ): Locator {
    return this.page.locator(
      `${tid(TEST_IDS.reviewPolicyItem)}[data-target="${target}"][data-state="${state}"]`,
    );
  }

  /** Opens the chip menu and picks On / Off / Inherit for a level; waits for the menu to close. */
  async setPolicyViaChip(
    target: 'worktree' | 'branch' | 'project' | 'folder',
    state: 'on' | 'off' | 'inherit',
  ): Promise<void> {
    await this.chip.click();
    await expect(this.policyMenu).toBeVisible();
    await this.policyMenu.locator(`[data-target="${target}"][data-state="${state}"]`).click();
    await this.page.keyboard.press('Escape');
    await expect(this.policyMenu).toBeHidden();
  }

  async expectChip(enabled: boolean, source: string): Promise<void> {
    await expect(this.chip).toHaveAttribute('data-enabled', String(enabled));
    await expect(this.chip).toHaveAttribute('data-source', source);
  }

  /** Confirms the "Mark N files reviewed/unreviewed?" dialog. */
  async confirmBulk(): Promise<void> {
    await expect(this.confirmDialog).toBeVisible();
    await this.confirmDialog.getByRole('button', { name: /^Mark (reviewed|unreviewed)$/ }).click();
    await expect(this.confirmDialog).toBeHidden();
  }

  /** Right-clicks a sidebar row's name button and waits for the actions menu. */
  async openRowMenu(row: Locator): Promise<Locator> {
    await row.scrollIntoViewIfNeeded();
    await row.click({ button: 'right' });
    await expect(this.contextMenu).toBeVisible();
    return this.contextMenu;
  }

  projectNameButton(name: string): Locator {
    return this.projectItem(name).locator('button[title]').first();
  }

  folderNameButton(scanRootId: string): Locator {
    return this.page.locator(`li[data-folder-id="${scanRootId}"] button[title]`).first();
  }

  async openSettings(
    section?: 'general' | 'review' | 'appearance' | 'folders' | 'keyboard' | 'about',
  ): Promise<void> {
    await this.focusApp();
    await this.press(',');
    await expect(this.settings).toBeVisible();
    if (section) {
      await this.settingsSection(section).click();
      await expect(this.settingsSection(section)).toHaveAttribute('aria-current', 'true');
    }
  }

  settingsSection(id: string): Locator {
    return this.page.locator(`${tid(TEST_IDS.settingsSection)}[data-section="${id}"]`);
  }

  async closeSettings(): Promise<void> {
    await this.press('Escape');
    await expect(this.settings).toBeHidden();
  }

  async setReviewDefault(on: boolean): Promise<void> {
    if ((await this.reviewDefaultSwitch.getAttribute('aria-checked')) !== String(on)) {
      await this.reviewDefaultSwitch.click();
    }
    await expect(this.reviewDefaultSwitch).toHaveAttribute('aria-checked', String(on));
  }

  themeOption(id: string): Locator {
    return this.page.locator(`${tid(TEST_IDS.themeOption)}[data-theme-id="${id}"]`);
  }

  /** `<html data-theme>`, `.dark`, and the `theme-color` meta contents. */
  themeState(): Promise<{ theme: string | null; dark: boolean; themeColors: string[] }> {
    return this.page.evaluate(() => ({
      theme: document.documentElement.getAttribute('data-theme'),
      dark: document.documentElement.classList.contains('dark'),
      themeColors: [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map(
        (m) => m.content,
      ),
    }));
  }

  async expectTheme(theme: string, dark: boolean): Promise<void> {
    await expect(this.page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect
      .poll(() => this.page.evaluate(() => document.documentElement.classList.contains('dark')))
      .toBe(dark);
  }
}

interface UiFixtures {
  ui: UiPage;
  guard: ConsoleGuard;
}

/** The base suite's fixtures (support/test.ts does not export its fixture types). */
interface BaseTestArgs {
  manifest: FixtureManifest;
  daemon: TestDaemon;
  app: AppPage;
  edits: FileEdits;
}
interface BaseWorkerArgs {
  manifest: FixtureManifest;
  gitEnv: IsolatedGitEnv;
}

export const test: TestType<
  PlaywrightTestArgs & PlaywrightTestOptions & BaseTestArgs & UiFixtures,
  PlaywrightWorkerArgs & PlaywrightWorkerOptions & BaseWorkerArgs
> = base.extend<UiFixtures>({
  guard: [
    // Depends on `daemon` so it is torn down (and asserts) before the daemon closes: late
    // requests from a dying page would otherwise show up as connection errors.
    async ({ page, daemon: _daemon }, use, testInfo) => {
      const guard = createGuard(testInfo);
      guard.watch(page);
      await use(guard);
      await guard.finish();
    },
    { auto: true },
  ],
  ui: async ({ page, guard }, use) => {
    guard.watch(page);
    await use(new UiPage(page));
  },
});

export { expect };

/** Unreviewed files per the daemon (only worktrees whose review is enabled count). */
export async function unreviewedTotal(client: ApiClient): Promise<number> {
  const inbox = await client.inbox({ onlyUnreviewed: true });
  return inbox.entries.reduce((n, e) => n + e.files.length, 0);
}
