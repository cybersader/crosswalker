import { test, expect } from '@playwright/test';

const BASE = '/Crosswalker';

test.describe('Smoke tests', () => {
  test('homepage loads', async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page).toHaveTitle(/crosswalker/);
  });

  test('homepage has hero content', async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page.locator('h2:has-text("What is Crosswalker")')).toBeVisible();
  });

  test('Nova top nav renders', async ({ page }) => {
    await page.goto(`${BASE}/`);
    const nav = page.locator('header nav');
    await expect(nav).toBeVisible();
    await expect(nav.locator('a:has-text("Docs")')).toBeVisible();
  });

  test('sidebar navigation present on content pages', async ({ page }) => {
    await page.goto(`${BASE}/getting-started/installation/`);
    const sidebar = page.locator('sl-sidebar-state-persist, nav ul, aside nav');
    await expect(sidebar.first()).toBeVisible();
  });

  test('search button is present', async ({ page }) => {
    await page.goto(`${BASE}/`);
    const searchButton = page.locator('site-search button, button[data-open-modal]');
    await expect(searchButton.first()).toBeVisible();
  });
});

test.describe('Content pages', () => {
  test('getting started loads', async ({ page }) => {
    await page.goto(`${BASE}/getting-started/installation/`);
    await expect(page.locator('h1')).toContainText('Installation');
  });

  test('features page loads', async ({ page }) => {
    await page.goto(`${BASE}/features/import-wizard/`);
    await expect(page.locator('h1')).toContainText('Import wizard');
  });

  test('agent context section loads', async ({ page }) => {
    await page.goto(`${BASE}/agent-context/`);
    await expect(page.locator('h1')).toContainText('Agent context');
  });

  test('blog post loads', async ({ page }) => {
    await page.goto(`${BASE}/blog/v01-release/`);
    await expect(page.locator('h1')).toContainText('v0.1.0');
  });

  test('design architecture page loads', async ({ page }) => {
    await page.goto(`${BASE}/design/architecture/`);
    await expect(page.locator('h1')).toContainText('Architecture');
  });
});
