import { test } from '@playwright/test';
test('v3', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('http://localhost:4322/Crosswalker/');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: '/tmp/hero-v3.png', fullPage: false });
  await page.screenshot({ path: '/tmp/hero-v3-full.png', fullPage: true });
});
