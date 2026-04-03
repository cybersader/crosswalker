import { test } from '@playwright/test';
const BASE = '/Crosswalker';
test('screenshot hero', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${BASE}/`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: '/tmp/hero-v1.png', fullPage: false });
  // Also scroll down slightly to capture the graph
  await page.evaluate(() => window.scrollTo(0, 100));
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/hero-v1-graph.png', fullPage: false });
  // Full page
  await page.screenshot({ path: '/tmp/hero-v1-full.png', fullPage: true });
});
