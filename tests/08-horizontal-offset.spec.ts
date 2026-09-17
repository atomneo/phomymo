import { test, expect } from '@playwright/test';
import { waitForAppReady, dismissInfoDialog } from './helpers/app';

/**
 * Tests for the per-printer "Horizontal Offset (px)" calibration field.
 *
 * Logic tests (shiftRasterHorizontal / normalizeHorizontalOffset /
 * getPrinterHorizontalOffset) run inside the page via a dynamic import of
 * printer.js, since these are plain ES module functions with no DOM
 * dependency. Bit patterns are represented as strings of '0'/'1' (MSB-first,
 * left pixel = leftmost character) and packed/unpacked to match the raster's
 * 1-bit-per-pixel, byte-packed format.
 */

const CUSTOM_PRINTERS_KEY = 'phomymo_custom_printers';

declare global {
  interface Window {
    __printerModule?: any;
  }
}

async function loadPrinterModule(page: import('@playwright/test').Page) {
  return page.evaluate(async () => {
    const mod = await import('/printer.js');
    await mod.loadPrinterDefinitions();
    (window as any).__printerModule = mod;
    return true;
  });
}

/** Pack a bit-string ('0'/'1', length a multiple of 8) into a raster-format array of byte values. */
function packBits(bits: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let bit = 0; bit < 8; bit++) {
      if (bits[i + bit] === '1') byte |= (1 << (7 - bit));
    }
    bytes.push(byte);
  }
  return bytes;
}

/** Unpack an array of byte values back into a bit-string. */
function unpackBits(bytes: number[], widthPx: number): string {
  let out = '';
  for (let x = 0; x < widthPx; x++) {
    const byteIdx = Math.floor(x / 8);
    const bitIdx = 7 - (x % 8);
    out += ((bytes[byteIdx] >> bitIdx) & 1) ? '1' : '0';
  }
  return out;
}

async function shift(page: import('@playwright/test').Page, bits: string, widthBytes: number, heightLines: number, offset: number): Promise<number[]> {
  const bytes = packBits(bits);
  const result = await page.evaluate(({ bytes, widthBytes, heightLines, offset }) => {
    const mod = (window as any).__printerModule;
    const data = new Uint8Array(bytes);
    const shifted = mod.shiftRasterHorizontal(data, widthBytes, heightLines, offset);
    return Array.from(shifted);
  }, { bytes, widthBytes, heightLines, offset });
  return result;
}

test.describe.serial('Horizontal Offset', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    await waitForAppReady(page);
    await dismissInfoDialog(page);
    await page.evaluate((key) => localStorage.removeItem(key), CUSTOM_PRINTERS_KEY);
    await loadPrinterModule(page);
  });

  test('offset 0 leaves raster unchanged', async ({ page }) => {
    const bits = '10101101';
    const result = await shift(page, bits, 1, 1, 0);
    expect(unpackBits(result, 8)).toBe(bits);
    expect(result.length).toBe(1);
  });

  test('offset +2 shifts content right, clipping the right edge', async ({ page }) => {
    // "ABCDEFGH" -> "..ABCDEF": 2 blank pixels prepended, last 2 pixels dropped
    const bits = '10101101';
    const result = await shift(page, bits, 1, 1, 2);
    expect(unpackBits(result, 8)).toBe('00101011');
    expect(result.length).toBe(1);
  });

  test('offset -2 shifts content left, clipping the left edge', async ({ page }) => {
    // "ABCDEFGH" -> "CDEFGH..": first 2 pixels dropped, 2 blank pixels appended
    const bits = '10101101';
    const result = await shift(page, bits, 1, 1, -2);
    expect(unpackBits(result, 8)).toBe('10110100');
    expect(result.length).toBe(1);
  });

  test('offset not a multiple of 8 shifts bits across byte boundaries', async ({ page }) => {
    const bits = '1100110011001100'; // widthBytes = 2 (16px)
    const result = await shift(page, bits, 2, 1, 3);
    // dst[x] = src[x-3]; first 3 px blank, last 3 px of source dropped
    expect(unpackBits(result, 16)).toBe('000' + bits.slice(0, 13));
    expect(result.length).toBe(2);
  });

  test('clipping: offset beyond raster width blanks everything, same buffer size', async ({ page }) => {
    const bits = '1111111111111111'; // widthBytes = 2 (16px), all black
    const resultRight = await shift(page, bits, 2, 1, 16);
    const resultLeft = await shift(page, bits, 2, 1, -16);
    expect(resultRight).toEqual([0, 0]);
    expect(resultLeft).toEqual([0, 0]);
  });

  test('rows do not bleed into each other', async ({ page }) => {
    // widthBytes = 1 (8px), 2 rows: row0 blank, row1 solid black
    const bits = '00000000' + '11111111';
    const result = await shift(page, bits, 1, 2, 4);
    const row0 = unpackBits(result.slice(0, 1), 8);
    const row1 = unpackBits(result.slice(1, 2), 8);
    expect(row0).toBe('00000000'); // stays blank - no bits leaked in from row1
    expect(row1).toBe('00001111'); // row1 shifted right by 4 on its own
  });

  test('getPrinterHorizontalOffset: missing field on saved profile behaves as 0', async ({ page }) => {
    await page.evaluate((key) => {
      const def = {
        id: 'test-hoffset', name: 'Test HOffset', group: 'Custom', description: '',
        protocol: 'm-series', widthBytes: 48, dpi: 203, alignment: 'center',
        rotated: false, tape: false, tapeWidths: null, defaultTapeWidth: null,
        namePatterns: [], labelPresets: 'm-series', builtin: false,
        // no horizontalOffset field - simulates a profile saved before this feature existed
      };
      localStorage.setItem(key, JSON.stringify([def]));
    }, CUSTOM_PRINTERS_KEY);
    await loadPrinterModule(page);

    const offset = await page.evaluate(() => {
      const mod = (window as any).__printerModule;
      return mod.getPrinterHorizontalOffset('', 'test-hoffset');
    });
    expect(offset).toBe(0);
  });

  test('getPrinterHorizontalOffset: reads a saved value and clamps/sanitizes invalid ones', async ({ page }) => {
    const cases: Array<{ value: any; expected: number }> = [
      { value: 4, expected: 4 },
      { value: -6, expected: -6 },
      { value: 999, expected: 64 },   // clamped to max
      { value: -999, expected: -64 }, // clamped to min
      { value: 'abc', expected: 0 },  // garbage -> 0
      { value: 3.9, expected: 3 },    // truncated, not rounded
    ];

    for (const { value, expected } of cases) {
      await page.evaluate(({ key, value }) => {
        const def = {
          id: 'test-hoffset', name: 'Test HOffset', group: 'Custom', description: '',
          protocol: 'm-series', widthBytes: 48, dpi: 203, alignment: 'center',
          horizontalOffset: value,
          rotated: false, tape: false, tapeWidths: null, defaultTapeWidth: null,
          namePatterns: [], labelPresets: 'm-series', builtin: false,
        };
        localStorage.setItem(key, JSON.stringify([def]));
      }, { key: CUSTOM_PRINTERS_KEY, value });
      await loadPrinterModule(page);

      const offset = await page.evaluate(() => {
        const mod = (window as any).__printerModule;
        return mod.getPrinterHorizontalOffset('', 'test-hoffset');
      });
      expect(offset).toBe(expected);
    }
  });

  test('getPrinterHorizontalOffset: unrecognized device/model defaults to 0', async ({ page }) => {
    const offset = await page.evaluate(() => {
      const mod = (window as any).__printerModule;
      return mod.getPrinterHorizontalOffset('SOME-UNKNOWN-DEVICE', 'auto');
    });
    expect(offset).toBe(0);
  });

  test('editor: horizontal offset persists across reload', async ({ page }) => {
    await page.click('#print-settings-btn');
    await page.click('#manage-printers-btn');
    await expect(page.locator('#printer-defs-dialog')).toBeVisible();

    // M110 built-in should default to 0
    await page.locator('.pdef-edit-btn[data-id="m110"]').click();
    await expect(page.locator('#printer-def-editor')).toBeVisible();
    await expect(page.locator('#pdef-hoffset')).toHaveValue('0');

    // Set it to 4 and save
    await page.locator('#pdef-hoffset').fill('4');
    await page.click('#printer-def-save');
    await page.waitForTimeout(300);

    // Verify persisted in localStorage
    const stored = await page.evaluate((key) => localStorage.getItem(key), CUSTOM_PRINTERS_KEY);
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!);
    const m110 = parsed.find((d: any) => d.id === 'm110');
    expect(m110.horizontalOffset).toBe(4);

    // Reload and confirm the editor shows the persisted value
    await page.goto('/', { waitUntil: 'networkidle' });
    await waitForAppReady(page);
    await dismissInfoDialog(page);
    await page.click('#print-settings-btn');
    await page.click('#manage-printers-btn');
    await page.locator('.pdef-edit-btn[data-id="m110"]').click();
    await expect(page.locator('#pdef-hoffset')).toHaveValue('4');
  });
});
