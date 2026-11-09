import { type ScopeKind, TEST_IDS } from '@octopus-diff/contracts';
import type { WorktreeFixture } from '@octopus-diff/fixtures';
import { expect, type Locator, type Page } from '@playwright/test';
import { cssValue } from './css.js';

export { cssValue };

/**
 * Page object for the octopus-diff UI. Every selector comes from `TEST_IDS` (contracts), so if
 * the UI changes how something is rendered, this is the one file to adjust.
 */

const tid = (id: string) => `[data-testid="${id}"]`;

export interface FileItemInfo {
  path: string;
  oldPath: string | null;
  status: string | null;
  reviewed: boolean;
  worktreeId: string | null;
  selected: boolean;
}

export interface OpenOptions {
  /** Per-device prefs seeded into a fresh profile before the first load; `{}` seeds nothing. */
  prefs?: Record<string, unknown>;
}

export class AppPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  byTestId(id: string): Locator {
    return this.page.locator(tid(id));
  }

  get app() {
    return this.byTestId(TEST_IDS.app);
  }
  get inbox() {
    return this.byTestId(TEST_IDS.inboxItem);
  }
  get diffViewer() {
    return this.byTestId(TEST_IDS.diffViewer);
  }
  get fileList() {
    return this.byTestId(TEST_IDS.fileList);
  }

  /**
   * Opens the `#token=` URL (the app moves the token into localStorage and strips it from the
   * address bar) and waits for the first render.
   */
  async open(authUrl: string, opts: OpenOptions = {}): Promise<void> {
    // The Settled shelf is closed by default (DECISIONS "UX round 4"); the specs read settled
    // rows directly, so a fresh profile starts with it open. A test that stored prefs itself
    // keeps them.
    const prefs = opts.prefs ?? { settledOpen: true };
    await this.page.addInitScript((seed: Record<string, unknown>) => {
      if (Object.keys(seed).length === 0 || localStorage.getItem('octopus-diff:prefs')) return;
      localStorage.setItem('octopus-diff:prefs', JSON.stringify({ version: 2, ...seed }));
    }, prefs);
    await this.page.goto(authUrl);
    await this.waitReady();
  }

  async waitReady(timeout = 20_000): Promise<void> {
    await expect(this.app).toHaveAttribute('data-ready', 'true', { timeout });
  }

  /** Blurs any focused input so global keyboard shortcuts reach the app. */
  async focusApp(): Promise<void> {
    await this.page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      active?.blur?.();
    });
  }

  async press(key: string): Promise<void> {
    await this.page.keyboard.press(key);
  }

  // --- sidebar -----------------------------------------------------------------------------

  worktreeItem(worktreeId: string): Locator {
    return this.page.locator(
      `${tid(TEST_IDS.worktreeItem)}[data-worktree-id="${cssValue(worktreeId)}"]`,
    );
  }

  projectItem(name: string): Locator {
    return this.page.locator(`${tid(TEST_IDS.projectItem)}[data-project-name="${cssValue(name)}"]`);
  }

  allWorktreeItems(): Locator {
    return this.byTestId(TEST_IDS.worktreeItem);
  }

  async selectInbox(): Promise<void> {
    await this.inbox.click();
    await expect(this.inbox).toHaveAttribute('aria-current', 'true');
  }

  async selectWorktree(worktreeId: string): Promise<void> {
    const item = this.worktreeItem(worktreeId);
    // No explicit scrollIntoViewIfNeeded: click scrolls itself and retries when the row remounts
    // (a card moving between its project and the Settled shelf as a new scope's inbox lands).
    await item.click();
    await expect(item).toHaveAttribute('aria-current', 'true');
  }

  async currentWorktreeId(): Promise<string | null> {
    const current = this.page.locator(`${tid(TEST_IDS.worktreeItem)}[aria-current="true"]`);
    if ((await current.count()) === 0) return null;
    return current.first().getAttribute('data-worktree-id');
  }

  /** Asserts a sidebar worktree item shows the manifest's branch, ahead/behind and counts. */
  async expectWorktreeItem(worktree: WorktreeFixture): Promise<void> {
    const item = this.worktreeItem(worktree.id);
    await expect(item, `sidebar item for ${worktree.name}`).toHaveCount(1);
    await expect(item).toHaveAttribute('data-branch', worktree.branch ?? '');
    await expect(item).toHaveAttribute('data-dirty', String(worktree.dirty));
    if (worktree.ahead !== undefined) {
      await expect(item).toHaveAttribute(
        'data-ahead',
        worktree.ahead === null ? '' : String(worktree.ahead),
      );
    }
    if (worktree.behind !== undefined) {
      await expect(item).toHaveAttribute(
        'data-behind',
        worktree.behind === null ? '' : String(worktree.behind),
      );
    }
    for (const key of ['staged', 'unstaged', 'untracked', 'conflicted'] as const) {
      await expect(item, `${worktree.name} ${key}`).toHaveAttribute(
        `data-${key}`,
        String(worktree.counts[key]),
      );
    }
  }

  /** Sets an `aria-pressed` toggle to the wanted state. */
  async setToggle(testId: string, pressed: boolean): Promise<void> {
    const toggle = this.byTestId(testId);
    if ((await toggle.getAttribute('aria-pressed')) !== String(pressed)) await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', String(pressed));
  }

  // --- file list ---------------------------------------------------------------------------

  fileItem(path: string, worktreeId?: string): Locator {
    const wt = worktreeId ? `[data-worktree-id="${cssValue(worktreeId)}"]` : '';
    return this.page.locator(`${tid(TEST_IDS.fileItem)}[data-path="${cssValue(path)}"]${wt}`);
  }

  get selectedFile(): Locator {
    return this.page.locator(`${tid(TEST_IDS.fileItem)}[aria-selected="true"]`);
  }

  /** File items in DOM (= visual) order. */
  async fileItems(): Promise<FileItemInfo[]> {
    return this.page.locator(tid(TEST_IDS.fileItem)).evaluateAll((nodes) =>
      nodes.map((node) => ({
        path: node.getAttribute('data-path') ?? '',
        oldPath: node.getAttribute('data-old-path') || null,
        status: node.getAttribute('data-status'),
        reviewed: node.getAttribute('data-reviewed') === 'true',
        worktreeId: node.getAttribute('data-worktree-id'),
        selected: node.getAttribute('aria-selected') === 'true',
      })),
    );
  }

  async filePaths(): Promise<string[]> {
    return (await this.fileItems()).map((f) => f.path);
  }

  /**
   * Every file item the list can render, found by scrolling the (virtualized) file list from top
   * to bottom. `fileItems()` only sees rows near the viewport; use this when asserting on the
   * whole list. Restores the original scroll position afterwards.
   */
  async allFileItems(): Promise<FileItemInfo[]> {
    const list = this.fileList;
    const original = await list.evaluate((el) => el.scrollTop);
    const seen = new Map<string, FileItemInfo>();
    await list.evaluate((el) => {
      el.scrollTop = 0;
    });
    for (let step = 0; step < 1000; step++) {
      // Wait a frame so the virtualized list re-renders for the new scroll position.
      await this.page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => resolve(null))),
      );
      for (const item of await this.fileItems()) {
        seen.set(`${item.worktreeId ?? ''}\u0000${item.path}`, item);
      }
      const atBottom = await list.evaluate((el) => {
        const before = el.scrollTop;
        el.scrollTop = before + Math.max(1, Math.floor(el.clientHeight / 2));
        return el.scrollTop === before;
      });
      if (atBottom) break;
    }
    await list.evaluate((el, top) => {
      el.scrollTop = top;
    }, original);
    return [...seen.values()];
  }

  /** Clicks a file and waits until the diff viewer shows it. */
  async openFile(path: string, worktreeId?: string): Promise<void> {
    const item = this.fileItem(path, worktreeId).first();
    await item.scrollIntoViewIfNeeded();
    await item.click();
    await expect(item).toHaveAttribute('aria-selected', 'true');
    await expect(this.diffViewer).toHaveAttribute('data-path', path);
    await this.waitDiffSettled();
  }

  async waitDiffSettled(): Promise<string> {
    await expect(this.diffViewer).toHaveAttribute('data-state', /^(ready|empty|error)$/, {
      timeout: 15_000,
    });
    return (await this.diffViewer.getAttribute('data-state')) ?? '';
  }

  placeholder(kind?: string): Locator {
    const k = kind ? `[data-kind="${kind}"]` : '';
    return this.page.locator(`${tid(TEST_IDS.diffPlaceholder)}${k}`);
  }

  // --- toolbar -----------------------------------------------------------------------------

  /** Picks a scope kind in the scope selector (native <select> or a custom listbox). */
  async setScope(kind: Exclude<ScopeKind, 'commit'>): Promise<void> {
    const select = this.byTestId(TEST_IDS.scopeSelect);
    const tag = await select.evaluate((el) => el.tagName.toLowerCase());
    if (tag === 'select') {
      await select.selectOption(kind);
    } else {
      await select.click();
      await this.page
        .getByRole('option', { name: new RegExp(`^${kind}`, 'i') })
        .first()
        .click();
    }
    await expect(select).toHaveAttribute('data-scope', new RegExp(`^${kind}`));
  }

  async setDiffMode(mode: 'split' | 'unified'): Promise<void> {
    const toggle = this.byTestId(TEST_IDS.diffModeToggle);
    if ((await toggle.getAttribute('data-mode')) !== mode) await toggle.click();
    await expect(toggle).toHaveAttribute('data-mode', mode);
    await expect(this.diffViewer).toHaveAttribute('data-mode', mode);
  }

  /** Text rendered by the diff viewer (pierces open shadow roots). */
  async expectDiffText(text: string, timeout?: number): Promise<void> {
    await expect(this.diffViewer.getByText(text, { exact: false }).first()).toBeVisible(
      timeout === undefined ? undefined : { timeout },
    );
  }

  /** Installs a marker that a full page reload would erase, and counts navigations. */
  async armReloadDetector(): Promise<() => Promise<{ reloaded: boolean; navigations: number }>> {
    let navigations = 0;
    const onNav = (frame: import('@playwright/test').Frame) => {
      if (frame === this.page.mainFrame()) navigations++;
    };
    this.page.on('framenavigated', onNav);
    await this.page.evaluate(() => {
      (window as unknown as { __octopusE2eMarker?: string }).__octopusE2eMarker = 'alive';
    });
    return async () => {
      this.page.off('framenavigated', onNav);
      const marker = await this.page.evaluate(
        () => (window as unknown as { __octopusE2eMarker?: string }).__octopusE2eMarker,
      );
      return { reloaded: marker !== 'alive', navigations };
    };
  }
}
