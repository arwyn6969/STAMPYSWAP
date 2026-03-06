import { test, expect } from '@playwright/test';

test.describe('STAMPYSWAP Trading Flow', () => {
  test('Completes the watch-wallet and order composition flow', async ({ page }) => {
    // 1. Visit the homepage and mock Counterparty API
    await page.route('**/api.counterparty.io:4000/v2/addresses/*/compose/order*', async route => {
      await route.fulfill({
        json: {
          result: {
            rawtransaction: '0100000000010100000...',
            params: {},
            name: 'create_order',
            psbt: 'cHNidP8BAQ...'
          }
        }
      });
    });

    await page.goto('/');

    // 2. Click "Connect Wallet"
    // Since Playwright runs without browser extensions, this defaults directly to Watch Address Mode
    const connectBtn = page.getByRole('button', { name: /Connect Wallet/i });
    await expect(connectBtn).toBeVisible();
    await connectBtn.click();
    
    // 4. Input Watch Address
    const addressInput = page.getByPlaceholder('bc1q...');
    await expect(addressInput).toBeVisible();
    await addressInput.fill('1AwS3wRFNCoymKs69BXjAA4VfgWvuKvx4j');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();

    // Verify it connected by seeing the Disconnect button
    await expect(page.getByRole('button', { name: 'Disconnect' })).toBeVisible();

    // 5. Fill out the Trade Form
    const giveAssetInput = page.getByPlaceholder('Asset (e.g. XCP)');
    await giveAssetInput.fill('XCP');

    const giveAmountInput = page.locator('input[type="number"]').first();
    await giveAmountInput.fill('1');

    const getAssetInput = page.getByPlaceholder('Asset (e.g. PEPECASH)');
    await getAssetInput.fill('PEPECASH');

    const getAmountInput = page.locator('input[type="number"]').nth(1);
    await getAmountInput.fill('1000');

    // Wait a brief moment to ensure any debounce/state is settled
    await page.waitForTimeout(500);

    // 6. Submit the order
    const createOrderBtn = page.getByRole('button', { name: /Review .* Order/i });
    await expect(createOrderBtn).toBeEnabled();
    await createOrderBtn.click();

    // 7. Verify the Signing Modal/Drawer pops up
    // We look for the QRSigner component text
    const signHeading = page.getByRole('heading', { name: /Sign Transaction/i });
    // Or it might say 'Approve Transaction'
    const qrModalText = page.locator('text=counterparty:?action=signtx').or(page.getByText(/Sign with/i));
    
    await expect(signHeading.or(qrModalText).first()).toBeVisible({ timeout: 15000 });
  });
});
