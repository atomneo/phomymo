import { test, expect } from '@playwright/test';
import { waitForAppReady, dismissInfoDialog } from './helpers/app';

/**
 * Tests for the per-printer "Vertical Offset (px)" calibration field.
 * Mirrors 08-horizontal-offset.spec.ts, but shiftRasterVertical operates on
 * whole rows (feed direction) rather than individual pixels within a row.
 *
 * Rasters are represented as an array of per-row bit-strings ('0'/'1',
 * length a multiple of 8, MSB-first) and packed/unpacked to match the
 * raster's 1-bit-per-pixel, byte-packed format.
 */

const CUSTOM_PRINTERS_KEY = 'phomymo_custom_printers';

async function loadPrinterModule(page: import('@playwright/test').Page) {
  return page.evaluate(async () => {
    const mod = await import('/printer.js');
    await mod.loadPrinterDefinitions();
    (window as any).__printerModule = mod;
    return true;
  });
}

/** Pack an array of per-row bit-strings into a raster-format array of byte values. */
function packRows(rows: string[]): number[] {
  const bytes: number[] = [];
  for (const bits of rows) {
    for (let i = 0; i < bits.length; i += 8) {
      let byte = 0;
      for (let bit = 0; bit < 8; bit++) {
        if (bits[i + bit] === '1') byte |= (1 << (7 - bit));
      }
      bytes.push(byte);
    }
  }
  return bytes;
}

/** Unpack a flat array of byte values back into an array of per-row bit-strings. */
function unpackRows(bytes: number[], widthBytes: number, heightLines: number): string[] {
  const rows: string[] = [];
  for (let y = 0; y < heightLines; y++) {
    let out = '';
    for (let x = 0; x < widthBytes * 8; x++) {
      const byteIdx = y * widthBytes + Math.floor(x / 8);
      const bitIdx = 7 - (x % 8);
      out += ((bytes[byteIdx] >> bitIdx) & 1) ? '1' : '0';
    }
    rows.push(out);
  }
  return rows;
}

async function shift(page: import('@playwright/test').Page, rows: string[], widthBytes: number, offset: number): Promise<number[]> {
  const bytes = packRows(rows);
  const heightLines = rows.length;
  const result = await page.evaluate(({ bytes, widthBytes, heightLines, offset }) => {
    const mod = (window as any).__printerModule;
    const data = new Uint8Array(bytes);
    const shifted = mod.shiftRasterVertical(data, widthBytes, heightLines, offset);
    return Array.from(shifted);
  }, { bytes, widthBytes, heightLines, offset });
  return result;
}

test.describe.serial('Vertical Offset', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    await waitForAppReady(page);
    await dismissInfoDialog(page);
    await page.evaluate((key) => localStorage.removeItem(key), CUSTOM_PRINTERS_KEY);
    await loadPrinterModule(page);
  });

  test('offset 0 leaves raster unchanged', async ({ page }) => {
    const rows = ['00000001', '00000010', '00000011'];
    const result = await shift(page, rows, 1, 0);
    expect(unpackRows(result, 1, 3)).toEqual(rows);
    expect(result.length).toBe(3);
  });

  test('offset +2 shifts content down, clipping the bottom edge', async ({ page }) => {
    const rows = ['00000001', '00000010', '00000011', '00000100', '00000101'];
    const result = await shift(page, rows, 1, 2);
    // 2 blank rows prepended, last 2 rows dropped
    expect(unpackRows(result, 1, 5)).toEqual(['00000000', '00000000', '00000001', '00000010', '00000011']);
    expect(result.length).toBe(5);
  });

  test('offset -2 shifts content up, clipping the top edge', async ({ page }) => {
    const rows = ['00000001', '00000010', '00000011', '00000100', '00000101'];
    const result = await shift(page, rows, 1, -2);
    // first 2 rows dropped, 2 blank rows appended
    expect(unpackRows(result, 1, 5)).toEqual(['00000011', '00000100', '00000101', '00000000', '00000000']);
    expect(result.length).toBe(5);
  });

  test('multi-byte-wide rows move as whole rows, not split across byte boundaries', async ({ page }) => {
    const rows = ['1111000011110000', '0000111100001111', '1010101001010101'];
    const result = await shift(page, rows, 2, 1);
    expect(unpackRows(result, 2, 3)).toEqual(['0000000000000000', rows[0], rows[1]]);
    expect(result.length).toBe(6);
  });

  test('clipping: offset beyond raster height blanks everything, same buffer size', async ({ page }) => {
    const rows = ['11111111', '11111111', '11111111'];
    const resultDown = await shift(page, rows, 1, 3);
    const resultUp = await shift(page, rows, 1, -3);
    expect(resultDown).toEqual([0, 0, 0]);
    expect(resultUp).toEqual([0, 0, 0]);
  });

  test('columns do not bleed into each other within a row', async ({ page }) => {
    // widthBytes = 2, single row: left byte solid, right byte blank
    const rows = ['1111111100000000'];
    const result = await shift(page, rows, 2, 0);
    expect(unpackRows(result, 2, 1)).toEqual(rows);
  });

  test('getPrinterVerticalOffset: missing field on saved profile behaves as 0', async ({ page }) => {
    await page.evaluate((key) => {
      const def = {
        id: 'test-voffset', name: 'Test VOffset', group: 'Custom', description: '',
        protocol: 'm-series', widthBytes: 48, dpi: 203, alignment: 'center',
        rotated: false, tape: false, tapeWidths: null, defaultTapeWidth: null,
        namePatterns: [], labelPresets: 'm-series', builtin: false,
        // no verticalOffset field - simulates a profile saved before this feature existed
      };
      localStorage.setItem(key, JSON.stringify([def]));
    }, CUSTOM_PRINTERS_KEY);
    await loadPrinterModule(page);

    const offset = await page.evaluate(() => {
      const mod = (window as any).__printerModule;
      return mod.getPrinterVerticalOffset('', 'test-voffset');
    });
    expect(offset).toBe(0);
  });

  test('getPrinterVerticalOffset: reads a saved value and clamps/sanitizes invalid ones', async ({ page }) => {
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
          id: 'test-voffset', name: 'Test VOffset', group: 'Custom', description: '',
          protocol: 'm-series', widthBytes: 48, dpi: 203, alignment: 'center',
          verticalOffset: value,
          rotated: false, tape: false, tapeWidths: null, defaultTapeWidth: null,
          namePatterns: [], labelPresets: 'm-series', builtin: false,
        };
        localStorage.setItem(key, JSON.stringify([def]));
      }, { key: CUSTOM_PRINTERS_KEY, value });
      await loadPrinterModule(page);

      const offset = await page.evaluate(() => {
        const mod = (window as any).__printerModule;
        return mod.getPrinterVerticalOffset('', 'test-voffset');
      });
      expect(offset).toBe(expected);
    }
  });

  test('getPrinterVerticalOffset: unrecognized device/model defaults to 0', async ({ page }) => {
    const offset = await page.evaluate(() => {
      const mod = (window as any).__printerModule;
      return mod.getPrinterVerticalOffset('SOME-UNKNOWN-DEVICE', 'auto');
    });
    expect(offset).toBe(0);
  });

  test('editor: vertical offset persists across reload, independent of horizontal', async ({ page }) => {
    await page.click('#print-settings-btn');
    await page.click('#manage-printers-btn');
    await expect(page.locator('#printer-defs-dialog')).toBeVisible();

    // M110 built-in should default to 0 for both offsets
    await page.locator('.pdef-edit-btn[data-id="m110"]').click();
    await expect(page.locator('#printer-def-editor')).toBeVisible();
    await expect(page.locator('#pdef-hoffset')).toHaveValue('0');
    await expect(page.locator('#pdef-voffset')).toHaveValue('0');

    // Set only vertical offset and save
    await page.locator('#pdef-voffset').fill('-5');
    await page.click('#printer-def-save');
    await page.waitForTimeout(300);

    // Verify persisted in localStorage, horizontal stays 0
    const stored = await page.evaluate((key) => localStorage.getItem(key), CUSTOM_PRINTERS_KEY);
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!);
    const m110 = parsed.find((d: any) => d.id === 'm110');
    expect(m110.verticalOffset).toBe(-5);
    expect(m110.horizontalOffset).toBe(0);

    // Reload and confirm the editor shows the persisted value
    await page.goto('/', { waitUntil: 'networkidle' });
    await waitForAppReady(page);
    await dismissInfoDialog(page);
    await page.click('#print-settings-btn');
    await page.click('#manage-printers-btn');
    await page.locator('.pdef-edit-btn[data-id="m110"]').click();
    await expect(page.locator('#pdef-voffset')).toHaveValue('-5');
    await expect(page.locator('#pdef-hoffset')).toHaveValue('0');
  });
});
