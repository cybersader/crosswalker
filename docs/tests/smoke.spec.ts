import { test, expect } from '@playwright/test';

const BASE = '';

test.describe('Smoke tests', () => {
  test('homepage loads', async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page).toHaveTitle(/crosswalker/i);
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

  // The Changelog is generated from CHANGELOG.md at build time; pin the
  // generator's output shape, not any one entry's wording.
  test('changelog lists posts generated from CHANGELOG.md', async ({ page }) => {
    await page.goto(`${BASE}/blog/changelog/2026-10-02-prerelease-0-1-6/`);
    await expect(page.locator('h1')).toContainText('Prerelease 0.1.6');
    await expect(page.locator('a[href$="CHANGELOG.md"]').first()).toBeVisible();
    await page.goto(`${BASE}/blog/`);
    await expect(page.locator('main a[href*="/blog/changelog/"]').first()).toBeVisible();
  });

  test('design architecture page loads', async ({ page }) => {
    await page.goto(`${BASE}/design/architecture/`);
    await expect(page.locator('h1')).toContainText('Architecture');
  });
});
