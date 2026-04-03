---
name: docs-testing
description: Run Playwright E2E tests against the Crosswalker Starlight docs site. Use when building docs, changing themes/plugins, or verifying deployments.
---

# Docs Testing Skill

Run Playwright tests against the Crosswalker documentation site (Astro Starlight).

## Quick Reference

| Command | What it does |
|---------|-------------|
| `cd docs && bun run test:local` | Run all tests against local preview server |
| `cd docs && bun run test:deploy` | Run deployment tests only |
| `cd docs && bun run test:e2e` | Run in headed mode (see the browser) |
| `cd docs && bun run test:e2e:ui` | Playwright UI mode (interactive) |

### Test against live site
```bash
cd docs && TEST_URL=https://cybersader.github.io bun run test:deploy
```

## Prerequisites

```bash
cd docs
bun install
npx playwright install chromium
bun run build  # Must build before testing
```

## Test Structure

```
docs/tests/
├── smoke.spec.ts        # 10 tests — UI, nav, content pages
└── deployment.spec.ts   # 4 tests — accessibility, errors, assets, meta
```

### Smoke Tests (smoke.spec.ts)

Tests that the site renders correctly:

- **Homepage loads** — title contains "Crosswalker"
- **Hero content** — "What is Crosswalker?" heading visible
- **Nova top nav** — header nav with "Docs" link renders
- **Sidebar** — navigation present on content pages
- **Search** — search button accessible
- **Content pages** — installation, features, agent-context, blog, architecture all load with correct h1

### Deployment Tests (deployment.spec.ts)

Tests for production readiness:

- **Site accessible** — returns 200
- **No console errors** — no JS errors on homepage
- **Assets load** — no failed network requests
- **Meta tags** — description and title present

## How to Use Screenshots

Playwright captures screenshots on failure automatically. View them in:
```
docs/test-results/
```

### Manual screenshot in a test
```typescript
await page.screenshot({ path: 'docs/test-results/my-screenshot.png' });
```

### View the screenshot as an agent
```bash
# Read the PNG file — Claude Code can view images directly
```

## Configuration

- **Config**: `docs/playwright.config.ts`
- **Base path**: All test URLs use `/Crosswalker` prefix (Astro base path)
- **Preview server**: Auto-starts `bun run preview` on port 4321
- **Browser**: Chromium only (sufficient for docs)

## Adding New Tests

```typescript
import { test, expect } from '@playwright/test';

const BASE = '/Crosswalker';

test('my new page loads', async ({ page }) => {
  await page.goto(`${BASE}/my-section/my-page/`);
  await expect(page.locator('h1')).toContainText('My Page');
});
```

## Common Issues

| Issue | Fix |
|-------|-----|
| 404 on all pages | Did you `bun run build` first? Preview serves from `dist/` |
| Chromium not found | Run `npx playwright install chromium` |
| Tailwind classes not applied | Check `docs/src/styles/global.css` has `@source` directives |
| Base path 404s | All `page.goto()` must use `${BASE}/path/` prefix |
