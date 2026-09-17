import { test, expect, Page, Route } from '@playwright/test';
import { waitForAppReady, dismissInfoDialog, screenshot } from './helpers/app';

const CH = '07-icons';
const PAGE_SIZE = 100; // must match ICON.PAGE_SIZE in constants.js

// =============================================================================
// Deterministic Iconify API stubs - no live network dependency.
// Shapes mirror the real API closely enough for icons.js/icon-picker.js to
// exercise every code path (search, browse-by-collection, categories,
// pagination) without depending on Iconify's actual current icon set.
// =============================================================================

function collectionsStub() {
  return {
    'material-symbols': { name: 'Material Symbols', total: 15642, palette: false, category: 'Material' },
    'mdi': { name: 'Material Design Icons', total: 7447, palette: false, category: 'Material' },
    'tabler': { name: 'Tabler Icons', total: 6184, palette: false, category: 'UI 24px' },
    'lucide': { name: 'Lucide', total: 1837, palette: false, category: 'UI' },
    'ph': { name: 'Phosphor', total: 9072, palette: false, category: 'UI' },
    'fa6-solid': { name: 'Font Awesome 6', total: 1402, palette: false, category: 'UI' },
    'fa6-brands': { name: 'Font Awesome 6 Brands', total: 495, palette: false, category: 'UI' },
    'bi': { name: 'Bootstrap Icons', total: 2078, palette: false, category: 'UI' },
    'heroicons': { name: 'Heroicons', total: 1288, palette: false, category: 'UI' },
    'ri': { name: 'Remix Icon', total: 3188, palette: false, category: 'UI' },
    'carbon': { name: 'Carbon', total: 2618, palette: false, category: 'UI' },
    'fluent': { name: 'Fluent UI', total: 19850, palette: false, category: 'UI' },
    'solar': { name: 'Solar', total: 7608, palette: false, category: 'UI' },
    'fontisto': { name: 'Fontisto', total: 615, palette: false, category: 'UI' },
    'logos': { name: 'SVG Logos', total: 1935, palette: true, category: 'Logos' },
  };
}

// mdi: 60 categorized ("Transport") + 60 uncategorized = 120 unique icons,
// plus a "hidden" one that must never appear, so browsing exercises both
// dedup and hidden-exclusion and yields more than one page (PAGE_SIZE=100).
function mdiCollectionStub() {
  return {
    prefix: 'mdi',
    total: 121,
    categories: {
      Transport: Array.from({ length: 60 }, (_, i) => `car-${i}`),
    },
    uncategorized: Array.from({ length: 60 }, (_, i) => `misc-${i}`),
    hidden: ['deprecated-icon'],
    aliases: {},
  };
}

// tabler: no categories at all (exercises the "hide category select" path).
function tablerCollectionStub() {
  return {
    prefix: 'tabler',
    total: 30,
    uncategorized: Array.from({ length: 30 }, (_, i) => `shape-${i}`),
    hidden: [],
    aliases: {},
  };
}

function collectionStubFor(prefix: string) {
  if (prefix === 'mdi') return mdiCollectionStub();
  if (prefix === 'tabler') return tablerCollectionStub();
  return { prefix, total: 0, uncategorized: [], aliases: {} };
}

async function handleSearch(route: Route) {
  const url = new URL(route.request().url());
  const query = (url.searchParams.get('query') || '').toLowerCase();
  const prefix = url.searchParams.get('prefix') || '';
  const start = parseInt(url.searchParams.get('start') || '0', 10);
  const limit = parseInt(url.searchParams.get('limit') || String(PAGE_SIZE), 10);

  if (query.includes('zzznotfound')) {
    await route.fulfill({ json: { icons: [], total: 0, start: 0, limit } });
    return;
  }

  // Mirrors a real, verified Iconify API quirk: `start` is only accepted
  // when the search is scoped to a `prefix` - a prefix-less ("All
  // libraries") search with `start` present returns HTTP 400. This is a
  // regression guard: the app must never send `start` without a prefix.
  if (!prefix && url.searchParams.has('start')) {
    await route.fulfill({ status: 400, body: 'Bad request' });
    return;
  }

  if (prefix) {
    // Single-library scoped search: everything comes back under that one
    // prefix. total(130) > PAGE_SIZE(100) so this also exercises Load more.
    const total = 130;
    const icons: string[] = [];
    for (let i = start; i < Math.min(start + limit, total); i++) icons.push(`${prefix}:${query}-${i}`);
    await route.fulfill({ json: { icons, total, start, limit } });
    return;
  }

  // "All libraries": a single best-effort batch mixed across several
  // distinct prefixes. Iconify's own `total` for this case just echoes back
  // whatever `limit` was requested (not a real match count), so the app is
  // expected to use the actual returned icon count instead - this stub
  // returns fewer than `limit` to make sure that distinction is exercised.
  const pool = ['mdi', 'material-symbols', 'tabler', 'lucide'];
  const actualMatches = 150;
  const count = Math.min(limit, actualMatches);
  const icons: string[] = Array.from({ length: count }, (_, i) => `${pool[i % pool.length]}:${query}-${i}`);
  await route.fulfill({ json: { icons, total: limit, start: 0, limit } });
}

async function handleIconSet(route: Route) {
  const url = new URL(route.request().url());
  const names = (url.searchParams.get('icons') || '').split(',').filter(Boolean);
  const icons: Record<string, { body: string }> = {};
  for (const name of names) icons[name] = { body: '<path d="M4 4h16v16H4z"/>' };
  await route.fulfill({ json: { prefix: 'stub', width: 24, height: 24, icons, aliases: {} } });
}

async function handleCollection(route: Route) {
  const url = new URL(route.request().url());
  const prefix = url.searchParams.get('prefix') || '';
  await route.fulfill({ json: collectionStubFor(prefix) });
}

async function stubIconifyApi(page: Page, { failSearch = false } = {}) {
  await page.route('**/api.iconify.design/search**', async (route) => {
    if (failSearch) {
      await route.abort('failed');
      return;
    }
    await handleSearch(route);
  });
  await page.route('**/api.iconify.design/collections**', async (route) => {
    await route.fulfill({ json: collectionsStub() });
  });
  await page.route('**/api.iconify.design/collection?**', handleCollection);
  await page.route('**/api.iconify.design/*.json**', handleIconSet);
}

/** Open the picker and the library dropdown panel, waiting for it to populate. */
async function openLibraryPanel(page: Page) {
  await page.click('#icon-picker-library-btn');
  await expect(page.locator('#icon-picker-library-panel')).toBeVisible();
  await expect(page.locator('.icon-picker-lib-row').first()).toBeVisible();
}

async function selectLibraryByName(page: Page, name: string) {
  await openLibraryPanel(page);
  await page.locator('.icon-picker-lib-row', { hasText: name }).first().click();
  await expect(page.locator('#icon-picker-library-panel')).toBeHidden();
}

test.describe.serial('Icon Picker', () => {
  test.beforeEach(async ({ page }) => {
    await stubIconifyApi(page);
    await page.goto('/', { waitUntil: 'networkidle' });
    await waitForAppReady(page);
    await dismissInfoDialog(page);
  });

  test('opens the icon picker from the toolbar', async ({ page }) => {
    await page.click('#add-icon');
    await expect(page.locator('#icon-picker-modal')).toBeVisible();
    await screenshot(page, CH, 1, 'picker-opened');
  });

  test('searches and shows results in a grid', async ({ page }) => {
    await page.click('#add-icon');
    await page.fill('#icon-picker-search', 'car');
    await page.waitForTimeout(500); // debounce + resolve

    const items = page.locator('#icon-picker-grid .icon-picker-item');
    await expect(items.first()).toBeVisible();
    expect(await items.count()).toBeGreaterThan(0);
    await screenshot(page, CH, 2, 'search-results');
  });

  test('shows an empty state for no results', async ({ page }) => {
    await page.click('#add-icon');
    await page.fill('#icon-picker-search', 'zzznotfound');
    await page.waitForTimeout(500);

    await expect(page.locator('#icon-picker-empty')).toBeVisible();
    await screenshot(page, CH, 3, 'empty-results');
  });

  test('shows an error state when the API is unreachable', async ({ page }) => {
    await page.unroute('**/api.iconify.design/search**');
    await stubIconifyApi(page, { failSearch: true });

    await page.click('#add-icon');
    await page.fill('#icon-picker-search', 'car');
    await page.waitForTimeout(500);

    await expect(page.locator('#icon-picker-error')).toBeVisible();
    await screenshot(page, CH, 4, 'error-state');

    // Retry button should be present and attempt the search again
    await expect(page.locator('#icon-picker-retry')).toBeVisible();
  });

  test('clicking an icon adds it to the canvas as an image element', async ({ page }) => {
    await page.click('#add-icon');
    await page.fill('#icon-picker-search', 'car');
    await page.waitForTimeout(500);

    await page.click('#icon-picker-grid .icon-picker-item >> nth=0');

    // Modal closes and the properties panel shows the image/icon controls
    await expect(page.locator('#icon-picker-modal')).toBeHidden();
    await expect(page.locator('#props-image')).toBeVisible();
    await expect(page.locator('#props-icon-info')).toBeVisible();
    // Raster-only controls should be hidden for a vector icon
    await expect(page.locator('#props-image-raster')).toBeHidden();

    const iconName = await page.locator('#prop-icon-name').textContent();
    expect(iconName).toContain(':');

    await screenshot(page, CH, 5, 'icon-added-to-canvas');
  });

  test('icon element supports scale, duplicate, undo and delete like other elements', async ({ page }) => {
    await page.click('#add-icon');
    await page.fill('#icon-picker-search', 'car');
    await page.waitForTimeout(500);
    await page.click('#icon-picker-grid .icon-picker-item >> nth=0');
    await expect(page.locator('#props-image')).toBeVisible();

    // Scale
    await page.fill('#prop-image-scale-input', '150');
    await page.locator('#prop-image-scale-input').dispatchEvent('change');
    await page.waitForTimeout(150);
    expect(await page.locator('#prop-image-scale-input').inputValue()).toBe('150');

    // Duplicate
    await page.keyboard.press('Control+d');
    await page.waitForTimeout(150);

    // Undo (duplicate)
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(150);

    // Delete the remaining icon element
    await page.click('#delete-btn');
    await page.waitForTimeout(150);
    await expect(page.locator('#props-empty')).toBeVisible();
  });

  test('saved and reloaded project keeps the icon without any network requests', async ({ page }) => {
    await page.click('#add-icon');
    await page.fill('#icon-picker-search', 'car');
    await page.waitForTimeout(500);
    await page.click('#icon-picker-grid .icon-picker-item >> nth=0');
    await expect(page.locator('#props-image')).toBeVisible();

    // Save design
    await page.click('#save-btn');
    await page.fill('#save-name', 'icon-test-design');
    await page.click('#save-confirm');
    await page.waitForTimeout(300);

    // Reload the page fresh
    await page.reload({ waitUntil: 'networkidle' });
    await waitForAppReady(page);
    await dismissInfoDialog(page);

    // Track any Iconify network calls after reload+load
    let iconifyCalled = false;
    page.on('request', (req) => {
      if (req.url().includes('api.iconify.design')) iconifyCalled = true;
    });

    // Load the saved design
    await page.click('#load-btn');
    await page.click('.design-item[data-name="icon-test-design"]');
    await page.waitForTimeout(400);

    await expect(page.locator('#props-empty')).toBeVisible(); // nothing selected after load, that's fine
    expect(iconifyCalled).toBe(false);

    await screenshot(page, CH, 6, 'reloaded-with-icon');
  });

  // ---------------------------------------------------------------------------
  // Library browsing, per-library search, "All libraries" breadth, pagination,
  // library picker search, and category filtering.
  // ---------------------------------------------------------------------------

  test('A: selecting a library with an empty search browses its full icon list, paginated', async ({ page }) => {
    await page.click('#add-icon');
    await selectLibraryByName(page, 'Material Design Icons');
    await page.waitForTimeout(600);

    const items = page.locator('#icon-picker-grid .icon-picker-item');
    // First page is capped at PAGE_SIZE even though the (deduped) library has 120 icons.
    expect(await items.count()).toBe(PAGE_SIZE);
    await expect(page.locator('#icon-picker-loadmore-wrap')).toBeVisible();
    await expect(page.locator('#icon-picker-loadmore')).toBeVisible();

    await page.click('#icon-picker-loadmore');
    await page.waitForTimeout(500);

    // The remaining 20 icons (categorized + uncategorized, deduplicated,
    // hidden icon excluded) load in on top of the first page.
    expect(await items.count()).toBe(120);
    await expect(page.locator('#icon-picker-loadmore')).toBeHidden();
    await screenshot(page, CH, 7, 'browse-library-full');
  });

  test('B: library=Material Design Icons + query=car returns only MDI results, paginated via Load more', async ({ page }) => {
    await page.click('#add-icon');
    await selectLibraryByName(page, 'Material Design Icons');
    await page.waitForTimeout(500);

    await page.fill('#icon-picker-search', 'car');
    await page.waitForTimeout(500);

    const items = page.locator('#icon-picker-grid .icon-picker-item');
    let count = await items.count();
    expect(count).toBe(PAGE_SIZE); // stub total=130, first page capped at PAGE_SIZE=100
    for (let i = 0; i < count; i++) {
      const title = await items.nth(i).getAttribute('title');
      expect(title?.startsWith('mdi:')).toBe(true);
    }

    // A single scoped library search DOES paginate via `start` (unlike "All libraries").
    await expect(page.locator('#icon-picker-loadmore')).toBeVisible();
    await page.click('#icon-picker-loadmore');
    await page.waitForTimeout(500);
    count = await items.count();
    expect(count).toBe(130);
    await expect(page.locator('#icon-picker-loadmore')).toBeHidden();
  });

  test('C: library=Material Symbols + query=car returns only Material Symbols results', async ({ page }) => {
    await page.click('#add-icon');
    await selectLibraryByName(page, 'Material Symbols');
    await page.waitForTimeout(500);

    await page.fill('#icon-picker-search', 'car');
    await page.waitForTimeout(500);

    const items = page.locator('#icon-picker-grid .icon-picker-item');
    const count = await items.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const title = await items.nth(i).getAttribute('title');
      expect(title?.startsWith('material-symbols:')).toBe(true);
    }
  });

  test('D: "All libraries" + query=car returns results from multiple libraries and supports Load more', async ({ page }) => {
    await page.click('#add-icon');
    await page.fill('#icon-picker-search', 'car');
    await page.waitForTimeout(500);

    const items = page.locator('#icon-picker-grid .icon-picker-item');
    let count = await items.count();
    // First rendered page is capped at PAGE_SIZE even though the stub's
    // single /search fetch already returned all 150 actual matches - well
    // beyond the old hardcoded 64-result ceiling this test guards against.
    expect(count).toBe(PAGE_SIZE);

    const prefixes = new Set<string>();
    for (let i = 0; i < count; i++) {
      const title = await items.nth(i).getAttribute('title');
      prefixes.add((title || '').split(':')[0]);
    }
    expect(prefixes.size).toBeGreaterThan(1);

    // Unlike a `start`-based API page, this "Load more" just resolves more
    // of the already-fetched 150-name list - no second /search request.
    await expect(page.locator('#icon-picker-loadmore')).toBeVisible();
    await page.click('#icon-picker-loadmore');
    await page.waitForTimeout(500);
    count = await items.count();
    expect(count).toBe(150);
    await expect(page.locator('#icon-picker-loadmore')).toBeHidden();
    await screenshot(page, CH, 8, 'all-libraries-load-more');
  });

  test('E: library picker search finds libraries by partial name match', async ({ page }) => {
    await page.click('#add-icon');
    await openLibraryPanel(page);
    await page.fill('#icon-picker-library-search', 'font');
    await page.waitForTimeout(150);

    const rows = page.locator('.icon-picker-lib-row');
    const texts = await rows.allTextContents();
    expect(texts.some((t) => t.includes('Font Awesome'))).toBe(true);
    expect(texts.some((t) => t.includes('Fontisto'))).toBe(true);
    await screenshot(page, CH, 9, 'library-search-font');
  });

  test('G: category dropdown appears only for libraries that have categories, and filters results', async ({ page }) => {
    await page.click('#add-icon');
    await selectLibraryByName(page, 'Material Design Icons');
    await page.waitForTimeout(600);

    const categorySelect = page.locator('#icon-picker-category');
    await expect(categorySelect).toBeVisible();
    await expect(categorySelect.locator('option', { hasText: 'Transport' })).toHaveCount(1);

    await categorySelect.selectOption({ label: 'Transport' });
    await page.waitForTimeout(500);

    const items = page.locator('#icon-picker-grid .icon-picker-item');
    expect(await items.count()).toBe(60); // only the "Transport" category's 60 icons
    await expect(page.locator('#icon-picker-loadmore')).toBeHidden();

    // Switching to a library with no categories hides the select again.
    await selectLibraryByName(page, 'Tabler Icons');
    await page.waitForTimeout(500);
    await expect(categorySelect).toBeHidden();
  });
});
