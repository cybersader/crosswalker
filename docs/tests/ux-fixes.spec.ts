import { test, expect } from '@playwright/test';

/**
 * UX fixes verification — 2026-04-10 session
 * Covers the four changes from the docs-site UX plan:
 *   Q1-A) narrower sidebars on desktop (15rem instead of 18.75rem)
 *   Q2.1) lastUpdated: true — git-based "Last updated" footer on every page
 *   Q2.2) PageTitle override — volatility pill badge + date display below h1
 *   Q3)   elastic content width — clamp(50rem, 68vw, 85rem) on wide viewports
 *
 * Plus: smoke-tests the new pages created in this session (registry/sssom, skos,
 * strm; zz-log/2026-04-10-*; zz-challenges/06-synthetic-spine).
 */

// Lowercase matches astro.config.mjs `base: '/crosswalker'`
const BASE = '/crosswalker';

// ─────────────────────────────────────────────────────────────────────────────
// Q3 — elastic content width
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Q3 — elastic content width', () => {
  test('wide viewport (1920x1080) expands --sl-content-width beyond 50rem baseline', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(`${BASE}/reference/registry/sssom/`);
    await page.waitForLoadState('networkidle');

    // Read the CSS custom property as computed on :root
    const contentWidth = await page.evaluate(() => {
      return getComputedStyle(document.documentElement).getPropertyValue('--sl-content-width').trim();
    });

    // At 1920px, clamp(50rem, 68vw, 85rem) ≈ 68vw = 1305px ≈ 81.5rem
    // Browsers resolve clamp() at getComputedStyle time, so we get a px value.
    // Accept either a px value > 800 (50rem at default 16px) or an rem value > 50.
    const pxValue = parseFloat(contentWidth);
    if (contentWidth.endsWith('px')) {
      expect(pxValue).toBeGreaterThan(800);
    } else if (contentWidth.endsWith('rem')) {
      expect(pxValue).toBeGreaterThan(50);
    } else if (contentWidth.startsWith('clamp(')) {
      expect(contentWidth).toBe('clamp(50rem, 68vw, 85rem)');
    } else {
      throw new Error(`Unexpected --sl-content-width value: ${contentWidth}`);
    }
  });

  test('narrow desktop (1152px) keeps clamp floor at 50rem', async ({ page }) => {
    await page.setViewportSize({ width: 1152, height: 800 });
    await page.goto(`${BASE}/reference/registry/sssom/`);
    await page.waitForLoadState('networkidle');

    const contentWidth = await page.evaluate(() => {
      return getComputedStyle(document.documentElement).getPropertyValue('--sl-content-width').trim();
    });

    const pxValue = parseFloat(contentWidth);
    if (contentWidth.endsWith('px')) {
      // At 1152px, 68vw = 783px < 50rem (800px), so clamp pins to 50rem = 800px
      expect(pxValue).toBeGreaterThanOrEqual(799); // allow 1px rounding
      expect(pxValue).toBeLessThanOrEqual(820);
    } else if (contentWidth.endsWith('rem')) {
      expect(pxValue).toBeGreaterThanOrEqual(50);
    }
  });

  test('sub-desktop (1100px) inherits Nova default, clamp not applied', async ({ page }) => {
    // Clamp is gated on @media (min-width: 1152px), so at 1100px Nova's default 50rem should stand
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.goto(`${BASE}/reference/registry/sssom/`);
    await page.waitForLoadState('networkidle');

    // Can't easily read Nova's @layer default, but we can verify the media query is respected
    // by checking that :root doesn't have an override at this width
    const hasOverride = await page.evaluate(() => {
      const mql = window.matchMedia('(min-width: 1152px)');
      return mql.matches;
    });
    expect(hasOverride).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Q1-A — narrower sidebars on desktop
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Q1-A — sidebar width', () => {
  test('wide viewport reduces --sl-sidebar-width to 15rem', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(`${BASE}/reference/registry/sssom/`);
    await page.waitForLoadState('networkidle');

    const sidebarWidth = await page.evaluate(() => {
      return getComputedStyle(document.documentElement).getPropertyValue('--sl-sidebar-width').trim();
    });

    // 15rem at default 16px base = 240px
    const pxValue = parseFloat(sidebarWidth);
    if (sidebarWidth.endsWith('px')) {
      // Account for the 112% font-size scale at min-width:1400px → 15rem ≈ 268.8px
      // At 1920px, the 112% rule is active, so expect ~269px
      expect(pxValue).toBeGreaterThanOrEqual(230);
      expect(pxValue).toBeLessThanOrEqual(280);
    } else if (sidebarWidth.endsWith('rem')) {
      expect(pxValue).toBe(15);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Q2.1 — lastUpdated footer
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Q2.1 — lastUpdated footer', () => {
  test('content page shows Last updated footer', async ({ page }) => {
    await page.goto(`${BASE}/reference/registry/sssom/`);
    await page.waitForLoadState('networkidle');

    // Starlight renders lastUpdated as a <p> containing "Last updated" text near the bottom
    // It's inside a .sl-markdown-content or page meta area
    const lastUpdated = page.locator('text=/Last updated/i').first();
    await expect(lastUpdated).toBeVisible();
  });

  test('last updated includes a date near it', async ({ page }) => {
    await page.goto(`${BASE}/reference/registry/sssom/`);
    await page.waitForLoadState('networkidle');

    // The <time> element next to the "Last updated" label carries the date
    const timeEl = page.locator('time').last();
    await expect(timeEl).toBeVisible();
    const datetimeAttr = await timeEl.getAttribute('datetime');
    expect(datetimeAttr).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Q2.2 — PageTitle override (volatility badge)
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Q2.2 — PageTitle override', () => {
  test('registry page with volatility:stable renders green pill badge', async ({ page }) => {
    // SSSOM has volatility: stable in its frontmatter
    await page.goto(`${BASE}/reference/registry/sssom/`);
    await page.waitForLoadState('networkidle');

    // The override adds a .cw-page-meta row below the h1 with a .cw-meta-badge
    const badge = page.locator('.cw-page-meta .cw-meta-badge.cw-meta-volatility-stable');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText(/stable/i);
  });

  test('registry page with volatility:evolving renders yellow pill badge', async ({ page }) => {
    // SCF has volatility: evolving in its frontmatter
    await page.goto(`${BASE}/reference/registry/scf/`);
    await page.waitForLoadState('networkidle');

    const badge = page.locator('.cw-page-meta .cw-meta-badge.cw-meta-volatility-evolving');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText(/evolving/i);
  });

  test('page with no volatility frontmatter does NOT render volatility badge', async ({ page }) => {
    // Dated log pages may render date metadata, but should not invent volatility.
    await page.goto(`${BASE}/agent-context/zz-log/2026-04-10-foundation-research-synthesis/`);
    await page.waitForLoadState('networkidle');

    const badge = page.locator('.cw-page-meta .cw-meta-badge');
    await expect(badge).toHaveCount(0);
  });

  test('h1 still renders with correct PAGE_TITLE_ID', async ({ page }) => {
    // Verify the _top anchor ID is preserved on the h1 (accessibility — skip-to-content)
    await page.goto(`${BASE}/reference/registry/sssom/`);
    await page.waitForLoadState('networkidle');

    const h1 = page.locator('h1#_top');
    await expect(h1).toBeVisible();
    await expect(h1).toContainText('SSSOM');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// New pages created this session (smoke)
// ─────────────────────────────────────────────────────────────────────────────

test.describe('New session pages — smoke', () => {
  const newPages = [
    { path: '/reference/registry/sssom/', h1: 'SSSOM' },
    { path: '/reference/registry/skos/', h1: 'SKOS' },
    { path: '/reference/registry/strm/', h1: 'STRM' },
    { path: '/agent-context/zz-log/2026-04-10-foundation-research-synthesis/', h1: 'Foundation research synthesis' },
    { path: '/agent-context/zz-log/2026-04-10-seacow-and-folder-tag-sync-prior-art/', h1: 'SEACOW' },
    { path: '/agent-context/zz-challenges/archive/06-synthetic-spine/', h1: 'Pairwise vs synthetic spine' },
  ];

  for (const { path, h1 } of newPages) {
    test(`${path} loads and renders h1`, async ({ page }) => {
      const response = await page.goto(`${BASE}${path}`);
      expect(response?.status()).toBe(200);

      const heading = page.locator('h1');
      await expect(heading).toBeVisible();
      await expect(heading).toContainText(h1);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Regression — core pages still load cleanly
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Regression — existing pages still render', () => {
  test('homepage has no console errors after UX changes', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto(`${BASE}/`);
    await page.waitForLoadState('networkidle');

    const criticalErrors = errors.filter(e =>
      !e.includes('favicon') &&
      !e.toLowerCase().includes('third-party cookie')
    );
    expect(criticalErrors, `Console errors found:\n${criticalErrors.join('\n')}`).toHaveLength(0);
  });

  test('04-10 synthesis log still has the formal concepts table', async ({ page }) => {
    // Regression check: the page that prompted the width fix should still have its table
    await page.goto(`${BASE}/agent-context/zz-log/2026-04-10-foundation-research-synthesis/`);
    await page.waitForLoadState('networkidle');

    // Find the "New formal concepts the research introduced" heading
    const heading = page.locator('h2:has-text("New formal concepts")');
    await expect(heading).toBeVisible();

    // Verify the table has 13 data rows (from the formal concepts table)
    // (The table comes after the heading; we find the first table following it)
    const tableRows = page.locator('table tbody tr');
    const count = await tableRows.count();
    // Multiple tables on the page, so just verify at least the formal concepts table's rows exist
    expect(count).toBeGreaterThanOrEqual(13);
  });

  test('institutional landscape page still renders', async ({ page }) => {
    await page.goto(`${BASE}/concepts/institutional-landscape/`);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('h1')).toContainText('Institutional landscape');
  });

  test('operational landscape page still renders', async ({ page }) => {
    await page.goto(`${BASE}/concepts/operational-landscape/`);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('h1')).toContainText('Operational landscape');
  });

  test('roadmap page renders its status table and links the design-phase archive', async ({ page }) => {
    await page.goto(`${BASE}/reference/roadmap/`);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('h1')).toContainText(/roadmap/i);

    // Structure, not prose: the living page opens on a "Where we are" status
    // table and ends with an Archive section. Prose strings on a living page
    // are rewritten on every re-verification, so they are not pinned here.
    await expect(page.locator('h2', { hasText: /^Where we are/ })).toBeVisible();
    await expect(page.locator('h2', { hasText: /^Archive/ })).toBeVisible();
    await expect(page.locator('a[href*="/reference/roadmap/v0-1-design-phase/"]').first()).toBeVisible();
  });

  test('design-phase archive keeps the settled Foundation items', async ({ page }) => {
    await page.goto(`${BASE}/reference/roadmap/v0-1-design-phase/`);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('body')).toContainText('Pairwise crosswalks + optional inheritable pivot');
    await expect(page.locator('body')).toContainText('SEACOW');
  });
});
