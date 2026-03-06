import { test, expect } from '@playwright/test';

test.describe('Testnet Toggle', () => {
  test('persists testnet state through localStorage', async ({ page }) => {
    await page.goto('/');

    // Verify testnet toggle exists
    const testnetLabel = page.getByText('Testnet');
    await expect(testnetLabel).toBeVisible();

    // The checkbox should start unchecked (mainnet)
    const testnetCheckbox = page.locator('input[type="checkbox"]').first();
    await expect(testnetCheckbox).not.toBeChecked();

    // Intercept the reload that happens when toggling testnet
    // We set localStorage directly and reload manually to test persistence
    await page.evaluate(() => {
      window.localStorage.setItem('STAMPYSWAP_TESTNET', 'true');
    });

    // Reload the page
    await page.reload();

    // After reload, the checkbox should be checked because localStorage has testnet=true
    const testnetCheckboxAfter = page.locator('input[type="checkbox"]').first();
    await expect(testnetCheckboxAfter).toBeChecked();

    // Clean up: reset to mainnet
    await page.evaluate(() => {
      window.localStorage.removeItem('STAMPYSWAP_TESTNET');
    });
  });

  test('watch-only connect button is visible when no wallet extensions are present', async ({ page }) => {
    await page.goto('/');

    // Playwright runs without browser extensions, so it should show the Connect Wallet button
    // which goes directly to watch-only mode
    const connectBtn = page.getByRole('button', { name: /Connect Wallet/i });
    await expect(connectBtn).toBeVisible();
    await connectBtn.click();

    // Should show the address input for manual/watch-only entry
    const addressInput = page.getByPlaceholder('bc1q...');
    await expect(addressInput).toBeVisible();
  });
});
