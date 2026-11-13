import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

// Browser-only gate: no app-module imports, no product hooks, no synthetic
// selection events. The only selection writes clear the previous gesture.
const { chromium } = await import('playwright');
const [url, fixtureDir, outDir, mode = 'verify', gate = 'all'] = process.argv.slice(2);
if (!url || !fixtureDir || !outDir || !process.env.BUILD_COMMIT || !process.env.CHROME) {
  throw new Error('URL fixtureDir outputDir [record|verify] [all|R3a|R3b|R3c]; set CHROME and BUILD_COMMIT');
}
await mkdir(outDir, { recursive: true });
const manifest = JSON.parse(await readFile(new URL('../../fixtures/pdf/manifest.json', import.meta.url), 'utf8'));
const fixtureEntries = manifest.fixtures.filter(entry => entry.id.startsWith('GEN-P11-'));
for (const fixture of fixtureEntries) {
  const bytes = await readFile(resolve(fixtureDir, fixture.file));
  if (bytes.length !== fixture.bytes || createHash('sha256').update(bytes).digest('hex') !== fixture.sha256) throw new Error(`Manifest identity mismatch: ${fixture.id}`);
}
if (fixtureEntries.length !== 3) throw new Error('Missing P-11 fixture identities');
const oracle = JSON.parse(await readFile(resolve(fixtureDir, 'selection-geometry.json'), 'utf8'));
const driver = createRequire(import.meta.url)('playwright/package.json').version;
if (driver !== '1.63.0') throw new Error(`Wrong Playwright: ${driver}`);
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME });
const report = { commit: process.env.BUILD_COMMIT, browser: browser.version(), driver, mode, gate, fixtures: fixtureEntries, cases: [], failures: [] };
if (report.browser !== '157.0.8103.39') throw new Error(`Wrong Chrome: ${report.browser}`);
const normal = text => text.normalize('NFKC').replace(/\s+/g, ' ').trim();
const variants = mode === 'record' ? [{ theme: 'dark', dpr: 2 }] : [
  { theme: 'dark', dpr: 1 }, { theme: 'dark', dpr: 2 }, { theme: 'light', dpr: 1 }, { theme: 'light', dpr: 2 },
];
try {
  for (const { theme, dpr } of variants) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: dpr, permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    const errors = [];
    const chunks = {};
    page.on('pageerror', e => errors.push(e.message));
    page.on('response', async response => {
      if (/\.(?:js|css)(?:\?|$)/.test(response.url()) && response.ok()) {
        try { chunks[new URL(response.url()).pathname] = createHash('sha256').update(await response.body()).digest('hex'); } catch { /* Closed page. */ }
      }
    });
    // Keep generated fixture text and vault identity local: never contact fonts,
    // telemetry or any other off-origin service while the vault is mounted.
    await page.route('**/*', route => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
    await page.addInitScript(({ theme }) => {
      localStorage.setItem('theme', theme);
      const grant = handle => {
        handle.queryPermission = async () => 'granted';
        handle.requestPermission = async () => 'granted';
        return handle;
      };
      const getDir = FileSystemDirectoryHandle.prototype.getDirectoryHandle;
      FileSystemDirectoryHandle.prototype.getDirectoryHandle = async function (...args) { return grant(await getDir.apply(this, args)); };
      window.showDirectoryPicker = async () => grant(await (await navigator.storage.getDirectory()).getDirectoryHandle('SelectionVault', { create: true }));
      window.addEventListener('contextmenu', event => { queueMicrotask(() => { window.menuPrevented = event.defaultPrevented; }); });
      window.addEventListener('pointerdown', event => { window.pointerPrevented = event.defaultPrevented; });
    }, { theme });
    await page.goto(url);
    for (const fixture of oracle.fixtures) {
      const bytes = await readFile(resolve(fixtureDir, fixture.file));
      if (createHash('sha256').update(bytes).digest('hex') !== fixture.sha256 || bytes.length !== fixture.bytes) throw new Error('Fixture identity mismatch');
      await page.evaluate(async ({ file, bytes }) => {
        const vault = await (await navigator.storage.getDirectory()).getDirectoryHandle('SelectionVault', { create: true });
        const writable = await (await vault.getFileHandle(file, { create: true })).createWritable();
        await writable.write(new Uint8Array(bytes));
        await writable.close();
      }, { file: fixture.file, bytes: [...bytes] });
    }
    await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
    await page.locator('.tree-item').filter({ hasText: 'selection-page.pdf' }).click();
    const viewer = page.locator('.pdf-viewer:visible');
    await viewer.locator('.textLayer span').first().waitFor();
    await page.waitForFunction(() => document.querySelector('.pdf-viewer-page canvas')?.width > 0);
    await page.evaluate(() => document.fonts.ready);
    const actualTheme = await page.evaluate(() => document.documentElement.dataset.theme ?? 'dark');
    if (actualTheme !== theme) throw new Error(`Theme identity ${actualTheme} != ${theme}`);
    const caseResult = { theme, dpr, errors, chunks };
    report.cases.push(caseResult);
    const check = (id, condition, evidence) => {
      caseResult[id] = evidence;
      if (!condition) report.failures.push(`${theme}/${dpr} ${id}`);
    };
    const pageBox = await viewer.locator('.pdf-viewer-page').first().boundingBox();
    const scale = pageBox.width / oracle.page.width;
    // Assert the page geometry independently before using the strip or points.
    if (Math.abs(pageBox.height - oracle.page.height * scale) > 1 || pageBox.x < 0 || pageBox.y < 0) throw new Error(`Page rectangle identity ${JSON.stringify(pageBox)}`);
    caseResult.pageBox = pageBox;
    const point = p => ({ x: pageBox.x + p.x * scale, y: pageBox.y + p.y * scale });
    async function clear() {
      await page.evaluate(() => getSelection()?.removeAllRanges());
      if (await page.evaluate(() => getSelection()?.toString()) !== '') throw new Error('Selection was not empty before gesture');
    }
    async function drag(a, b) {
      await clear();
      const start = point(a), end = point(b);
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(end.x, end.y, { steps: 20 });
      await page.mouse.up();
      await page.keyboard.press('Meta+c');
      return page.evaluate(() => navigator.clipboard.readText());
    }
    if (gate === 'all' || gate === 'R3a') {
      const margin = await drag(oracle.marginStart, oracle.titleEnd);
      const native = await drag(oracle.nativeStart, oracle.titleEnd);
      const nativePrevented = await page.evaluate(() => window.pointerPrevented);
      check('R3a', margin === oracle.titlePrefix && native === oracle.nativeText && !nativePrevented, { margin, expected: oracle.titlePrefix, native, nativeExpected: oracle.nativeText, nativePrevented });
    }
    if (gate === 'all' || gate === 'R3c') {
      const multiline = await drag(oracle.multilineStart, oracle.multilineEnd);
      if (!multiline.includes('\n')) {
        await page.screenshot({ path: resolve(outDir, 'no-multiline.png') });
        throw new Error(`No multiline witness: ${multiline}; ${JSON.stringify(await viewer.locator('.textLayer span').allTextContents())}; selection=${await page.evaluate(() => getSelection()?.toString())}`);
      }
      const strip = { x: pageBox.x + 1, y: Math.max(pageBox.y + 1, 0), width: 14, height: Math.min(pageBox.height - 2, 1098 - pageBox.y) };
      const capture = await page.screenshot({ clip: strip });
      await writeFile(resolve(outDir, `${theme}-${dpr}-strip.png`), capture);
      const tinted = await page.evaluate(async bytes => {
        const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        const rgba = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
        bitmap.close();
        let count = 0;
        for (let i = 0; i < rgba.length; i += 4) if (Math.max(...rgba.slice(i, i + 3)) - Math.min(...rgba.slice(i, i + 3)) > 20) count++;
        return count;
      }, [...capture]);
      await page.screenshot({ path: resolve(outDir, `${theme}-${dpr}-selected.png`) });
      check('R3c', tinted === 0, { tinted, multiline, strip });
    }
    if (gate === 'all' || gate === 'R3b') {
      await page.locator('.tree-item').filter({ hasText: 'dense-40-selection.pdf' }).click();
      await page.waitForFunction(() => [...document.querySelectorAll('.pdf-viewer:has(.textLayer)')].filter(e => e.checkVisibility()).some(e => [...e.querySelectorAll('.textLayer')].filter(t => t.querySelector('span')).length === 40));
      const shownVault = await page.locator('.vault-switcher').innerText();
      if (!shownVault.includes('SelectionVault')) throw new Error('Missing vault identity');
      const textPoint = await page.locator('.pdf-viewer:visible .textLayer span').first().boundingBox();
      await page.mouse.click(textPoint.x + 10, textPoint.y + 5);
      await clear();
      await page.keyboard.press('Meta+a');
      await page.keyboard.press('Meta+c');
      const clipboard = await page.evaluate(() => navigator.clipboard.readText());
      const expected = Array.from({ length: 40 }, () => oracle.normalizedPageText).join(' ');
      const treeText = await page.locator('.tree-item').allTextContents();
      check('R3b', normal(clipboard) === expected && !clipboard.includes('SelectionVault') && !treeText.some(text => text.trim() && clipboard.includes(text.trim())), { clipboardLength: clipboard.length, normalizedLength: normal(clipboard).length, expectedLength: expected.length, prefix: clipboard.slice(0, 100), vault: shownVault });
      // Select-all must stand down in an input: retain the page-number editing
      // gesture rather than replacing it with a document selection.
      const input = page.locator('.pdf-viewer:visible .pdf-viewer-page-input');
      if (await input.count()) {
        await input.click();
        await page.keyboard.press('Meta+a');
        check('input', await input.evaluate(el => el.selectionStart === 0 && el.selectionEnd === el.value.length), { value: await input.inputValue() });
      }
    }
    if (gate === 'all' || gate === 'R3a') {
      // P-11 preserves the classic reader's documented native-menu exception.
      // D-PDF-contextmenu belongs to the tiled reader's P5, not this fix.
      const text = page.locator('.pdf-viewer:visible .textLayer span').first();
      await text.click({ button: 'right' });
      check('menuUnchanged', await page.evaluate(() => window.menuPrevented === false), { defaultPrevented: await page.evaluate(() => window.menuPrevented) });
      await page.keyboard.press('Escape');
    }
    check('pageErrors', errors.length === 0, errors);
    await context.close();
  }
} finally {
  await browser.close();
  await writeFile(resolve(outDir, 'result.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ failures: report.failures, result: resolve(outDir, 'result.json') }));
if (mode !== 'record' && report.failures.length) process.exitCode = 1;
