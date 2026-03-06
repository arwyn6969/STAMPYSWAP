import { test, expect } from '@playwright/test';

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
});

test.describe('Order Book Touch Flow', () => {
  test('prefills a buy order from the mobile order book and opens the signer', async ({ page }) => {
    await page.route('**/api.counterparty.io:4000/v2/orders/XCP/PEPECASH?**', async route => {
      await route.fulfill({
        json: {
          result: [
            {
              tx_hash: 'a'.repeat(64),
              source: '1SellerAddressxxxxxxxxxxxxxxxxxx',
              give_asset: 'XCP',
              give_quantity: '100000000',
              give_remaining: '100000000',
              get_asset: 'PEPECASH',
              get_quantity: '25000000000',
              get_remaining: '25000000000',
              expiration: 100,
              expire_index: 0,
              status: 'open',
              give_price: 0.004,
              get_price: 250,
              block_time: 1700000000,
              give_quantity_normalized: '1',
              get_quantity_normalized: '250',
              give_remaining_normalized: '1',
              get_remaining_normalized: '250',
            },
          ],
        },
      });
    });

    await page.route('**/api.counterparty.io:4000/v2/orders?**', async route => {
      await route.fulfill({ json: { result: [] } });
    });

    await page.route('**/api.counterparty.io:4000/v2/addresses/*/balances*', async route => {
      await route.fulfill({
        json: {
          result: [
            {
              address: '1AwS3wRFNCoymKs69BXjAA4VfgWvuKvx4j',
              asset: 'PEPECASH',
              quantity: '50000000000',
              quantity_normalized: '500',
            },
            {
              address: '1AwS3wRFNCoymKs69BXjAA4VfgWvuKvx4j',
              asset: 'XCP',
              quantity: '100000000',
              quantity_normalized: '1',
            },
          ],
        },
      });
    });

    await page.route('**/api.counterparty.io:4000/v2/addresses/*/orders*', async route => {
      await route.fulfill({ json: { result: [] } });
    });

    await page.route('**/api.counterparty.io:4000/v2/addresses/*/compose/order*', async route => {
      await route.fulfill({
        json: {
          result: {
            rawtransaction: '0100000000010100000...',
            params: {},
            name: 'create_order',
            psbt: 'cHNidP8BAQ...',
          },
        },
      });
    });

    await page.route('**/api.counterparty.io:4000/v2/assets/*', async route => {
      const asset = route.request().url().split('/assets/')[1]?.split('?')[0] ?? 'UNKNOWN';
      await route.fulfill({
        json: {
          result: {
            asset,
            divisible: true,
          },
        },
      });
    });

    await page.goto('/');

    await page.getByRole('button', { name: /Connect Wallet/i }).click();
    await page.getByPlaceholder('bc1q...').fill('1AwS3wRFNCoymKs69BXjAA4VfgWvuKvx4j');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();

    const mobileOrderBook = page.locator('.order-book-mobile-list');
    await expect(mobileOrderBook.getByRole('button', { name: 'Fill' }).first()).toBeVisible();
    await mobileOrderBook.getByRole('button', { name: 'Fill' }).first().click();

    await expect(page.getByText(/Fill the selected ask/i)).toBeVisible();
    await expect(page.getByPlaceholder('Asset (e.g. XCP)')).toHaveValue('PEPECASH');
    await expect(page.getByPlaceholder('Asset (e.g. PEPECASH)')).toHaveValue('XCP');

    const amountInputs = page.locator('.trade-form-card input[placeholder="0.00000000"]');
    await expect(amountInputs.nth(0)).toHaveValue('250');
    await expect(amountInputs.nth(1)).toHaveValue('1');

    const reviewButton = page.getByRole('button', { name: /Review XCP Buy Order/i });
    await expect(reviewButton).toBeEnabled();
    await reviewButton.click();

    await expect(page.getByRole('heading', { name: /Sign Transaction/i })).toBeVisible();
  });
});
