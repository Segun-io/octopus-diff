/**
 * UX-4 / UX-5 / UX-6 in the browser: the Settings screen (six sections, keyboard, overrides
 * table), themes (picker, `data-theme` / `.dark`, system mode, persistence, no flash, prefs
 * v1 → v2 migration), served assets, `theme-color`, the title count and the favicon dot. The
 * console/CSP guard in `support/ui.ts` fails any test that logs an error or a CSP violation.
 */
import { TEST_IDS } from '@octopus-diff/contracts';
import { findProject, findWorktree } from '@octopus-diff/fixtures';
import { reviewedPaths } from '../support/api.js';
import { expect, expectTitle, FIRST_RENDER_PROBE, test, titleCount } from '../support/ui.js';

const SECTIONS = ['general', 'review', 'appearance', 'folders', 'forges', 'keyboard', 'about'];

test.describe('UX-4/5/6 settings, themes and assets (UI)', () => {
  test('settings: `,` opens, seven sections by keyboard, Esc closes; Review lists overrides and can remove one', async ({
    manifest,
    daemon,
    ui,
  }) => {
    const live = findProject(manifest, 'live');
    await daemon.client.setReviewPolicy({
      target: { kind: 'project', projectId: live.id },
      enabled: false,
    });
    await ui.open(daemon.authUrl);
    await ui.openSettings();
    const sections = ui.byTestId(TEST_IDS.settingsSection);
    await expect(sections).toHaveCount(SECTIONS.length);
    expect(
      await sections.evaluateAll((els) => els.map((e) => e.getAttribute('data-section'))),
    ).toEqual(SECTIONS);
    await expect(ui.settingsSection('general')).toHaveAttribute('aria-current', 'true');
    await expect(ui.settingsSection('general')).toBeFocused();
    for (const next of SECTIONS.slice(1)) {
      await ui.press('ArrowDown');
      await expect(ui.settingsSection(next)).toHaveAttribute('aria-current', 'true');
      await expect(ui.settingsSection(next)).toBeFocused();
    }
    await ui.press('ArrowDown');
    await expect(ui.settingsSection('general')).toHaveAttribute('aria-current', 'true');
    await ui.closeSettings();

    await ui.openSettings('review');
    await expect(ui.reviewDefaultSwitch).toHaveAttribute('aria-checked', 'true');
    const rows = ui.settings.locator('tbody tr');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('live');
    await expect(rows.first()).toContainText('off');
    await rows.first().getByRole('button', { name: 'Inherit' }).click();
    await expect(rows).toHaveCount(0);
    await expect(ui.settings).toContainText('No overrides');
    expect((await daemon.client.getSettings()).overrides).toEqual([]);
    await ui.closeSettings();
    await expect(ui.settings).toBeHidden();
  });

  test('themes: system mode follows prefers-color-scheme, the picker sets data-theme/.dark and theme-color, choice survives reload', async ({
    daemon,
    ui,
    page,
  }) => {
    await page.addInitScript(FIRST_RENDER_PROBE);
    await page.emulateMedia({ colorScheme: 'dark' });
    await ui.open(daemon.authUrl);
    await ui.expectTheme('octopus-dark', true);
    // No flash: the pre-paint script set the theme before React rendered anything.
    expect(await page.evaluate(() => window.__octopusFirstRender)).toEqual({
      theme: 'octopus-dark',
      dark: true,
    });
    const dark = await ui.themeState();
    expect(dark.themeColors).toHaveLength(2);
    expect(new Set(dark.themeColors).size).toBe(1);

    await page.emulateMedia({ colorScheme: 'light' });
    await ui.expectTheme('octopus-light', false);
    const light = await ui.themeState();
    expect(light.themeColors[0]).not.toBe(dark.themeColors[0]);

    await ui.openSettings('appearance');
    await expect(ui.byTestId(TEST_IDS.themePicker)).toBeVisible();
    await expect(ui.byTestId(TEST_IDS.themeOption)).toHaveCount(3);
    await expect(ui.themeOption('octopus-light')).toHaveAttribute('aria-pressed', 'true');
    await ui.themeOption('octopus-contrast').click();
    await ui.expectTheme('octopus-contrast', true);
    await expect(ui.themeOption('octopus-contrast')).toHaveAttribute('aria-pressed', 'true');
    const contrast = await ui.themeState();
    expect(contrast.themeColors[0]).toMatch(/^#[0-9a-f]{6}$/i);
    expect(contrast.themeColors[0]).not.toBe(light.themeColors[0]);
    expect(new Set(contrast.themeColors).size).toBe(1);
    await ui.closeSettings();

    // Reload: still the picked theme, and still no flash (prefs read by theme-init.js).
    await page.reload();
    await ui.waitReady();
    await ui.expectTheme('octopus-contrast', true);
    expect(await page.evaluate(() => window.__octopusFirstRender)).toEqual({
      theme: 'octopus-contrast',
      dark: true,
    });
    const stored = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('octopus-diff:prefs') ?? '{}'),
    );
    expect(stored.version).toBe(2);
    expect(stored.theme).toEqual({
      mode: 'dark',
      light: 'octopus-light',
      dark: 'octopus-contrast',
    });

    // `t` toggles the mode: the light slot.
    await ui.focusApp();
    await ui.press('t');
    await ui.expectTheme('octopus-light', false);
  });

  test('prefs v1 are migrated to v2 and honoured before the first paint', async ({
    daemon,
    ui,
    page,
  }) => {
    await page.addInitScript(FIRST_RENDER_PROBE);
    await page.addInitScript(() => {
      // Seed once per tab (reloads must see the migrated value, not the seed again).
      if (sessionStorage.getItem('octopus-e2e-seeded')) return;
      sessionStorage.setItem('octopus-e2e-seeded', '1');
      localStorage.setItem(
        'octopus-diff:prefs',
        JSON.stringify({ theme: 'light', diffMode: 'unified', showReviewed: false }),
      );
    });
    await page.emulateMedia({ colorScheme: 'dark' });
    await ui.open(daemon.authUrl);
    // The v1 string theme wins over the dark OS scheme, already in the first frame.
    expect(await page.evaluate(() => window.__octopusFirstRender)).toEqual({
      theme: 'octopus-light',
      dark: false,
    });
    await ui.expectTheme('octopus-light', false);
    await expect(ui.byTestId(TEST_IDS.diffModeToggle)).toHaveAttribute('data-mode', 'unified');
    // The eye lives only in scopes that can hide reviewed files (not All on branch or To review).
    await ui.setScope('working');
    await expect(ui.byTestId(TEST_IDS.showReviewedToggle)).toHaveAttribute('aria-pressed', 'false');
    const migrated = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('octopus-diff:prefs') ?? '{}'),
    );
    expect(migrated).toMatchObject({
      version: 2,
      theme: { mode: 'light', light: 'octopus-light', dark: 'octopus-dark' },
      diffMode: 'unified',
      showReviewed: false,
      density: 'compact',
      titleCount: true,
    });
    await page.reload();
    await ui.waitReady();
    await ui.expectTheme('octopus-light', false);
    await expect(ui.byTestId(TEST_IDS.diffModeToggle)).toHaveAttribute('data-mode', 'unified');
  });

  test('assets are served with the right types; title count and favicon dot follow review marks', async ({
    manifest,
    daemon,
    ui,
    page,
  }) => {
    // Since #10 review states are computed on demand (a project is opened), not at startup. The To
    // review inbox computes every one of them, so this test starts with them all in place.
    await daemon.client.inbox({ scope: { kind: 'review' } });
    await ui.open(daemon.authUrl);
    const expected: Array<[string, RegExp]> = [
      ['/favicon.svg', /^image\/svg\+xml/],
      ['/favicon.ico', /^image\/x-icon/],
      ['/apple-touch-icon.png', /^image\/png/],
      ['/icon-192.png', /^image\/png/],
      ['/icon-512.png', /^image\/png/],
      ['/icon-maskable-192.png', /^image\/png/],
      ['/icon-maskable-512.png', /^image\/png/],
      ['/site.webmanifest', /^application\/manifest\+json/],
      ['/theme-init.js', /^text\/javascript/],
    ];
    for (const [path, type] of expected) {
      const res = await page.request.get(`${daemon.url}${path}`);
      expect(res.status(), path).toBe(200);
      expect(res.headers()['content-type'] ?? '', path).toMatch(type);
      expect((await res.body()).byteLength, path).toBeGreaterThan(0);
    }
    const manifestRes = await page.request.get(`${daemon.url}/site.webmanifest`);
    const webmanifest = (await manifestRes.json()) as {
      name?: string;
      icons?: Array<{ src: string; sizes: string; type?: string; purpose?: string }>;
      theme_color?: string;
    };
    expect(webmanifest.name).toBe('octopus-diff');
    expect(webmanifest.icons?.length ?? 0).toBeGreaterThanOrEqual(2);
    for (const icon of webmanifest.icons ?? []) {
      const res = await page.request.get(
        `${daemon.url}${icon.src.startsWith('/') ? icon.src : `/${icon.src}`}`,
      );
      expect(res.status(), icon.src).toBe(200);
    }
    expect(await page.locator('link[rel="icon"]').count()).toBe(2);
    expect(await page.locator('link[rel="apple-touch-icon"]').count()).toBe(1);
    expect(await page.locator('link[rel="manifest"]').count()).toBe(1);
    expect(await page.locator('meta[name="theme-color"]').count()).toBe(2);

    // Title shows the unreviewed count and reacts to marking; the favicon carries a dot meanwhile.
    const total = await expectTitle(page, daemon.client);
    expect(total).toBeGreaterThan(0);
    const svgIcon = page.locator('link[rel="icon"][type="image/svg+xml"]');
    await expect(svgIcon).toHaveAttribute('href', /^data:image\/svg\+xml/);
    const live = findWorktree(manifest, 'live').worktree;
    await ui.selectWorktree(live.id);
    const [first] = await ui.filePaths();
    if (!first) throw new Error('no files');
    await ui.openFile(first);
    await ui.focusApp();
    await ui.press('r');
    await expect.poll(() => reviewedPaths(daemon.client, live.id)).toEqual([first]);
    expect(await expectTitle(page, daemon.client)).toBe(total - 1);
    await ui.press('r');
    expect(await expectTitle(page, daemon.client)).toBe(total);
    expect(await titleCount(daemon.client)).toBe(total);

    // Title count is a device pref: off → plain title.
    await ui.openSettings('general');
    const titleSwitch = ui.settings.getByRole('switch', {
      name: 'Unreviewed count in the tab title',
    });
    await titleSwitch.click();
    await expect(titleSwitch).toHaveAttribute('aria-checked', 'false');
    await ui.closeSettings();
    await expect(page).toHaveTitle('octopus-diff');
    await expect(svgIcon).toHaveAttribute('href', '/favicon.svg');
  });
});
