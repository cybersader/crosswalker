import { test, expect } from '@playwright/test';

const BASE = '';

/**
 * Deployment verification tests
 * Run against live site: TEST_URL=https://crosswalker.io bun run test:deploy
 */

test.describe('Deployment verification', () => {
  test('site is accessible', async ({ page }) => {
    const response = await page.goto(`${BASE}/`);
    expect(response?.status()).toBe(200);
  });

  test('no console errors on homepage', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    await page.goto(`${BASE}/`);
    await page.waitForLoadState('networkidle');

    const criticalErrors = errors.filter(e => !e.includes('favicon'));
    expect(criticalErrors).toHaveLength(0);
  });

  test('critical assets load', async ({ page }) => {
    const failedRequests: string[] = [];

    page.on('response', response => {
      if (response.status() >= 400) failedRequests.push(`${response.status()} ${response.url()}`);
    });

    page.on('requestfailed', request => {
      failedRequests.push(request.url());
    });

    await page.goto(`${BASE}/`);
    await page.waitForLoadState('networkidle');

    expect(failedRequests).toHaveLength(0);
  });

  test('pages have proper meta tags', async ({ page }) => {
    await page.goto(`${BASE}/`);

    const description = await page.locator('meta[name="description"]').getAttribute('content');
    expect(description).toBeTruthy();

    const title = await page.title();
    expect(title).toContain('Crosswalker');
  });
});
