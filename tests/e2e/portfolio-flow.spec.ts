import { test, expect } from '@playwright/test';

test.describe('Portfolio Workspace', () => {
  test('lets a watch-only user select assets and open the batch listing plan', async ({ page }) => {
    await page.route('**/api.counterparty.io:4000/v2/orders/**', async route => {
      await route.fulfill({ json: { result: [] } });
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
              quantity: '250000000000',
              quantity_normalized: '2500',
            },
            {
              address: '1AwS3wRFNCoymKs69BXjAA4VfgWvuKvx4j',
              asset: 'RAREPEPE',
              quantity: '125000000000',
              quantity_normalized: '1250',
            },
          ],
        },
      });
    });

    await page.route('**/api.counterparty.io:4000/v2/addresses/*/orders*', async route => {
      await route.fulfill({ json: { result: [] } });
    });

    await page.route('**/api.counterparty.io:4000/v2/assets/*', async route => {
      const asset = route.request().url().split('/assets/')[1]?.split('?')[0] ?? 'UNKNOWN';
      await route.fulfill({
        json: {
          result: {
            asset,
            divisible: asset !== 'RAREPEPE',
          },
        },
      });
    });

    await page.goto('/');

    await page.getByRole('button', { name: /Connect Wallet/i }).click();
    await page.getByPlaceholder('bc1q...').fill('1AwS3wRFNCoymKs69BXjAA4VfgWvuKvx4j');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();

    const reviewBatchPlan = page.getByRole('button', { name: /Review Batch Plan/i });
    await expect(reviewBatchPlan).toBeDisabled();

    await page.locator('.portfolio-grid').getByRole('button', { name: /PEPECASH/i }).click();
    await expect(reviewBatchPlan).toBeEnabled();

    await reviewBatchPlan.click();
    await expect(page.getByRole('heading', { name: 'Batch Listing Plan' })).toBeVisible();
  });
});
