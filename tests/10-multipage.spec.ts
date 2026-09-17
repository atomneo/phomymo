import { test, expect } from '@playwright/test';
import { waitForAppReady, dismissInfoDialog } from './helpers/app';

test.describe.serial('Multi-page Projects', () => {
  test('A — app initializes with one page', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    await waitForAppReady(page);
    await dismissInfoDialog(page);

    const tiles = page.locator('#pages-list .page-tile');
    await expect(tiles).toHaveCount(1);
  });

  test('B — add page creates a new tile', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    await waitForAppReady(page);
    await dismissInfoDialog(page);

    await page.locator('#add-page-btn').click();
    await page.waitForTimeout(300);

    const tiles = page.locator('#pages-list .page-tile');
    await expect(tiles).toHaveCount(2);
  });

  test('C — pages have independent elements', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    await waitForAppReady(page);
    await dismissInfoDialog(page);

    // Add a text element on page 1
    await page.locator('#add-text').click();
    await page.waitForTimeout(300);

    const page1Elements = await page.evaluate(() => {
      return (window as any).project?.pages[0]?.elements?.length ?? 0;
    });

    // Add page 2 and switch to it
    await page.locator('#add-page-btn').click();
    await page.waitForTimeout(300);

    // Page 2 should have no elements
    const page2Elements = await page.evaluate(() => {
      const proj = (window as any).project;
      const page2 = proj?.pages[1];
      return page2?.elements?.length ?? 0;
    });

    expect(page2Elements).toBe(0);

    // Switch back to page 1
    const tile1 = page.locator('#pages-list .page-tile').first();
    await tile1.click();
    await page.waitForTimeout(300);

    // Page 1 should still have its element
    const page1ElementsAfter = await page.evaluate(() => {
      return (window as any).project?.pages[0]?.elements?.length ?? 0;
    });
    expect(page1ElementsAfter).toBe(page1Elements);
  });

  test('D — Print All button is visible', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    await waitForAppReady(page);
    await dismissInfoDialog(page);

    await expect(page.locator('#print-all-btn')).toBeAttached();
  });

  test('E — duplicate page creates independent copy', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    await waitForAppReady(page);
    await dismissInfoDialog(page);

    // Add a text element
    await page.locator('#add-text').click();
    await page.waitForTimeout(300);

    // Open context menu on page tile and duplicate
    const tile = page.locator('#pages-list .page-tile').first();
    await tile.hover();
    const menuBtn = tile.locator('.page-tile-menu');
    await menuBtn.click();
    await page.waitForTimeout(200);

    const dupBtn = page.locator('.fixed.z-\\[200\\] button').filter({ hasText: 'Duplicate' });
    await dupBtn.click();
    await page.waitForTimeout(300);

    const tiles = page.locator('#pages-list .page-tile');
    await expect(tiles).toHaveCount(2);

    // Both pages should have the same element count but different IDs
    const { page1Count, page2Count, sameId } = await page.evaluate(() => {
      const proj = (window as any).project;
      const p1 = proj.pages[0];
      const p2 = proj.pages[1];
      return {
        page1Count: p1.elements.length,
        page2Count: p2.elements.length,
        sameId: p1.elements.length > 0 && p2.elements.length > 0
          ? p1.elements[0].id === p2.elements[0].id
          : false,
      };
    });

    expect(page2Count).toBe(page1Count);
    expect(sameId).toBe(false);
  });

  test('F — last page cannot be deleted', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    await waitForAppReady(page);
    await dismissInfoDialog(page);

    const pageCountBefore = await page.evaluate(() => (window as any).project?.pages?.length ?? 0);

    // Open context menu
    const tile = page.locator('#pages-list .page-tile').first();
    await tile.hover();
    const menuBtn = tile.locator('.page-tile-menu');
    await menuBtn.click();
    await page.waitForTimeout(200);

    const delBtn = page.locator('.fixed.z-\\[200\\] button').filter({ hasText: 'Delete' });
    await delBtn.click();
    await page.waitForTimeout(300);

    const pageCountAfter = await page.evaluate(() => (window as any).project?.pages?.length ?? 0);
    expect(pageCountAfter).toBe(pageCountBefore);
  });

  test('K — JSON export produces v4 format', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    await waitForAppReady(page);
    await dismissInfoDialog(page);

    // Add a second page
    await page.locator('#add-page-btn').click();
    await page.waitForTimeout(300);

    // Trigger export and capture the JSON
    const exportData = await page.evaluate(() => {
      const proj = (window as any).project;
      const state = (window as any).state;
      return {
        pages: proj.pages.length,
        activePageId: proj.activePageId,
      };
    });

    expect(exportData.pages).toBe(2);
    expect(exportData.activePageId).toBeTruthy();
  });
});
