import { expect, test } from '@playwright/test';

test('browser launches (WS4 replaces this with the acceptance specs)', async ({ page }) => {
  await page.setContent('<h1>octopus-diff</h1>');
  await expect(page.locator('h1')).toHaveText('octopus-diff');
});
