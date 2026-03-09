import { test, expect } from '@playwright/test';

test.describe('Batch Compose Failure Flow', () => {
  test('surfaces batch compose failures in-app and allows a clean retry', async ({ page }) => {
    let dialogSeen = false;
    let composeAttemptCount = 0;
    const attemptedAssets: string[] = [];

    page.on('dialog', async (dialog) => {
      dialogSeen = true;
      await dialog.dismiss();
    });

    await page.route('**/api.counterparty.io:4000/v2/orders/**', async (route) => {
      await route.fulfill({ json: { result: [] } });
    });

    await page.route('**/api.counterparty.io:4000/v2/orders?**', async (route) => {
      await route.fulfill({ json: { result: [] } });
    });

    await page.route('**/api.counterparty.io:4000/v2/addresses/*/balances*', async (route) => {
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

    await page.route('**/api.counterparty.io:4000/v2/addresses/*/orders*', async (route) => {
      await route.fulfill({ json: { result: [] } });
    });

    await page.route('**/api.counterparty.io:4000/v2/assets/*', async (route) => {
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

    await page.route('**/api.counterparty.io:4000/v2/addresses/*/compose/order*', async (route) => {
      composeAttemptCount += 1;
      const url = new URL(route.request().url());
      const giveAsset = url.searchParams.get('give_asset') ?? 'UNKNOWN';
      attemptedAssets.push(giveAsset);

      if (composeAttemptCount <= 3) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'compose failed for test' }),
        });
        return;
      }

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

    await page.goto('/');

    await page.getByRole('button', { name: /Connect Wallet/i }).click();
    await page.getByPlaceholder('bc1q...').fill('1AwS3wRFNCoymKs69BXjAA4VfgWvuKvx4j');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();

    const portfolioGrid = page.locator('.portfolio-grid');
    await portfolioGrid.getByRole('button', { name: /PEPECASH/i }).click();
    await portfolioGrid.getByRole('button', { name: /RAREPEPE/i }).click();

    await page.getByRole('button', { name: /Review Batch Plan/i }).click();
    await expect(page.getByRole('heading', { name: 'Batch Listing Plan' })).toBeVisible();

    const buildButton = page.getByRole('button', { name: 'Build 2 Orders' });
    await expect(buildButton).toBeVisible();
    await buildButton.click();

    const batchBanner = page.locator('.batch-status-banner');
    await expect(batchBanner).toBeVisible();
    await expect(batchBanner).toContainText('Batch listing stopped');
    await expect(batchBanner).toContainText('compose failed for test');
    expect(dialogSeen).toBe(false);
    expect(composeAttemptCount).toBeGreaterThan(0);
    expect(attemptedAssets.every((asset) => asset === 'PEPECASH')).toBe(true);
    const attemptsAfterFailure = composeAttemptCount;

    await batchBanner.getByRole('button', { name: /Review Batch Plan/i }).click();
    const inlineError = page.locator('.drawer-inline-feedback');
    await expect(inlineError).toBeVisible();
    await expect(inlineError).toContainText('Previous batch attempt failed');

    await inlineError.getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.locator('.batch-status-banner')).toHaveCount(0);
    await expect(page.locator('.drawer-inline-feedback')).toHaveCount(0);

    await page.getByRole('button', { name: 'Build 2 Orders' }).click();
    await expect(page.getByRole('heading', { name: /Sign Transaction/i })).toBeVisible();
    expect(composeAttemptCount).toBeGreaterThan(attemptsAfterFailure);
  });
});
