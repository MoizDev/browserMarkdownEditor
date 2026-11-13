import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { buildIdentity, bindServedBodies } from '../../lib/identity.mjs';

// Browser-only gate: no app-module imports, no product hooks, no synthetic
// selection events. The only selection writes clear the previous gesture.
const { chromium } = await import('playwright');
const [url, fixtureDir, outDir, mode = 'verify', gate = 'all'] = process.argv.slice(2);
const mutant = process.env.BUILD_MUTANT ?? 'none';
if (!url || !fixtureDir || !outDir || !process.env.BUILD_WORKTREE || !process.env.BUILD_DIST || !process.env.CHROME || process.argv.length > 7 || !['record', 'verify'].includes(mode) || !['all', 'R3a', 'R3b', 'R3c'].includes(gate) || !['none', 'R3a', 'R3b', 'R3c'].includes(mutant) || (mutant !== 'none' && gate !== 'all' && gate !== mutant)) {
  throw new Error('URL fixtureDir outputDir [record|verify] [all|R3a|R3b|R3c]; set CHROME, BUILD_WORKTREE, BUILD_DIST, optional BUILD_MUTANT=R3a|R3b|R3c');
}
const patch = mutant === 'none' ? undefined : await readFile(resolve(process.env.BUILD_WORKTREE, `verify/pdf/P-11/mutants/${mutant}.patch`));
const identity = await buildIdentity({ worktree: process.env.BUILD_WORKTREE, distDir: process.env.BUILD_DIST, patch });
if (!identity.files.length || (mutant === 'none' && !identity.treeClean) || (mutant !== 'none' && (identity.treeClean || !identity.patchSha256))) throw new Error('Build source/patch identity is incomplete');
const requiredBodies = [
  ...[...String(await readFile(resolve(process.env.BUILD_DIST, 'index.html'))).matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(match => match[1].replace(/^\//, '')),
  ...[/\/PdfPane-[^/]+\.js$/, /\/pdfWorker-[^/]+\.js$/, /\/pdf\.worker[^/]+\.mjs$/].map(pattern => {
    const files = identity.files.filter(file => pattern.test(file.path));
    if (files.length !== 1) throw new Error(`Missing unique required emitted module: ${pattern}`);
    return files[0].path;
  }),
];
if (requiredBodies.length !== 4) throw new Error('Missing unique main app script');
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
const report = { build: identity, mutant, requiredBodies, browser: browser.version(), driver, mode, gate, fixtures: fixtureEntries, cases: [], failures: [] };
const requiredArms = gate === 'all' ? ['R3a', 'R3b', 'R3c'] : [gate];
const normal = text => text.normalize('NFKC').replace(/\s+/g, ' ').trim();
const variants = mode === 'record' ? [{ theme: 'dark', dpr: 2 }] : [
  { theme: 'dark', dpr: 1 }, { theme: 'dark', dpr: 2 }, { theme: 'light', dpr: 1 }, { theme: 'light', dpr: 2 },
];
try {
  if (report.browser !== '157.0.8103.39') throw new Error(`Wrong Chrome: ${report.browser}`);
  for (const { theme, dpr } of variants) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: dpr, permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    const errors = [];
    const binding = await bindServedBodies(context, { identity, origin: url, mode: 'raw-route', buildMode: 'production' });
    page.on('pageerror', e => errors.push(e.message));
    // Keep generated fixture text and vault identity local: never contact fonts,
    // telemetry or any other off-origin service while the vault is mounted.
    await page.route('**/*', route => new URL(route.request().url()).origin === new URL(url).origin ? route.fallback() : route.abort());
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
    await binding.check();
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
    await binding.check();
    const viewer = page.locator('.pdf-viewer:visible');
    await viewer.locator('.textLayer span').first().waitFor();
    await page.waitForFunction(() => document.querySelector('.pdf-viewer-page canvas')?.width > 0);
    await page.evaluate(() => document.fonts.ready);
    const actualTheme = await page.evaluate(() => document.documentElement.dataset.theme ?? 'dark');
    await binding.check();
    if (actualTheme !== theme) throw new Error(`Theme identity ${actualTheme} != ${theme}`);
    const caseResult = { theme, dpr, errors, executed: [] };
    report.cases.push(caseResult);
    const check = async (id, condition, evidence) => {
      caseResult.servedBinding = await binding.check();
      caseResult[id] = evidence;
      if (!condition) report.failures.push(`${theme}/${dpr} ${id}`);
    };
    const pageBox = await viewer.locator('.pdf-viewer-page').first().boundingBox();
    const scale = pageBox.width / oracle.page.width;
    // Assert the page geometry independently before using the strip or points.
    await binding.check();
    if (Math.abs(pageBox.height - oracle.page.height * scale) > 1 || pageBox.x < 0 || pageBox.y < 0) throw new Error(`Page rectangle identity ${JSON.stringify(pageBox)}`);
    caseResult.pageBox = pageBox;
    const point = p => ({ x: pageBox.x + p.x * scale, y: pageBox.y + p.y * scale });
    async function clear() {
      await page.evaluate(() => getSelection()?.removeAllRanges());
      await binding.check();
      if (await page.evaluate(() => getSelection()?.toString()) !== '') throw new Error('Selection was not empty before gesture');
    }
    let action = 0;
    async function seedClipboard(label) {
      const sentinel = `P11-UNTOUCHED:${identity.manifestSha256}:${theme}:${dpr}:${gate}:${++action}:${label}`;
      await page.evaluate(value => navigator.clipboard.writeText(value), sentinel);
      await binding.check();
      if (await page.evaluate(() => navigator.clipboard.readText()) !== sentinel) throw new Error('Clipboard sentinel was not written');
      return sentinel;
    }
    async function liveSelection() {
      return page.locator('.pdf-viewer:visible').evaluate(root => {
        const selection = getSelection();
        const inLayer = node => {
          const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
          const layer = element?.closest('.textLayer');
          return !!layer && root.contains(layer);
        };
        const witness = { ranges: selection?.rangeCount ?? 0, collapsed: selection?.isCollapsed ?? true, text: selection?.toString() ?? '', anchorInViewer: inLayer(selection?.anchorNode), focusInViewer: inLayer(selection?.focusNode) };
        return { ...witness, valid: witness.ranges > 0 && !witness.collapsed && !!witness.text && witness.anchorInViewer && witness.focusInViewer };
      });
    }
    async function drag(a, b, label) {
      const sentinel = await seedClipboard(label);
      await clear();
      const start = point(a), end = point(b);
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(end.x, end.y, { steps: 20 });
      await page.mouse.up();
      const selection = await liveSelection();
      await page.keyboard.press('Meta+c');
      const clipboard = await page.evaluate(() => navigator.clipboard.readText());
      return { selection, clipboard, replacedSentinel: clipboard !== sentinel };
    }
    if (gate === 'all' || gate === 'R3a') {
      caseResult.executed.push('R3a');
      const margin = await drag(oracle.marginStart, oracle.titleEnd, 'margin');
      const native = await drag(oracle.nativeStart, oracle.titleEnd, 'native');
      const nativePrevented = await page.evaluate(() => window.pointerPrevented);
      await check('R3a', margin.selection.valid && margin.selection.text === oracle.titlePrefix && margin.replacedSentinel && margin.clipboard === oracle.titlePrefix && native.selection.valid && native.selection.text === oracle.nativeText && native.replacedSentinel && native.clipboard === oracle.nativeText && !nativePrevented, { margin, expected: oracle.titlePrefix, native, nativeExpected: oracle.nativeText, nativePrevented });
    }
    if (gate === 'all' || gate === 'R3c') {
      caseResult.executed.push('R3c');
      const multiline = await drag(oracle.multilineStart, oracle.multilineEnd, 'multiline');
      const expectedMultiline = `${oracle.lines[1].text}\n${oracle.lines[2].text.slice(0, 12)}`;
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
      const activeSelection = await liveSelection();
      await check('R3c', multiline.selection.valid && multiline.selection.text === expectedMultiline && activeSelection.valid && activeSelection.text === expectedMultiline && multiline.replacedSentinel && multiline.clipboard === expectedMultiline && tinted === 0, { tinted, multiline, activeSelection, expectedMultiline, strip });
    }
    if (gate === 'all' || gate === 'R3b') {
      caseResult.executed.push('R3b');
      await page.locator('.tree-item').filter({ hasText: 'dense-40-selection.pdf' }).click();
      await page.waitForFunction(() => [...document.querySelectorAll('.pdf-viewer:has(.textLayer)')].filter(e => e.checkVisibility()).some(e => [...e.querySelectorAll('.textLayer')].filter(t => t.querySelector('span')).length === 40));
      const shownVault = await page.locator('.vault-switcher').innerText();
      await binding.check();
      if (!shownVault.includes('SelectionVault')) throw new Error('Missing vault identity');
      const textPoint = await page.locator('.pdf-viewer:visible .textLayer span').first().boundingBox();
      await page.mouse.click(textPoint.x + 10, textPoint.y + 5);
      const sentinel = await seedClipboard('select-all');
      await clear();
      await page.keyboard.press('Meta+a');
      const selection = await liveSelection();
      await page.keyboard.press('Meta+c');
      const clipboard = await page.evaluate(() => navigator.clipboard.readText());
      const expected = Array.from({ length: 40 }, () => oracle.normalizedPageText).join(' ');
      const treeText = await page.locator('.tree-item').allTextContents();
      await check('R3b', selection.valid && normal(selection.text) === expected && clipboard !== sentinel && normal(clipboard) === expected && !clipboard.includes('SelectionVault') && !treeText.some(text => text.trim() && clipboard.includes(text.trim())), { selection: { ...selection, text: undefined, textLength: selection.text.length, normalizedLength: normal(selection.text).length }, replacedSentinel: clipboard !== sentinel, clipboardLength: clipboard.length, normalizedLength: normal(clipboard).length, expectedLength: expected.length, prefix: clipboard.slice(0, 100), vault: shownVault });
      // Select-all must stand down in an input: retain the page-number editing
      // gesture rather than replacing it with a document selection.
      const input = page.locator('.pdf-viewer:visible .pdf-viewer-page-input');
      await input.waitFor();
      const value = await input.inputValue();
      await binding.check();
      if (!value) throw new Error('Page-number input has no current value');
      await seedClipboard('input-select-all');
      await input.click();
      await page.keyboard.press('Meta+a');
      await check('input', await input.evaluate(el => el.selectionStart === 0 && el.selectionEnd === el.value.length), { value });
    }
    if (gate === 'all' || gate === 'R3a') {
      // P-11 preserves the classic reader's documented native-menu exception.
      // D-PDF-contextmenu belongs to the tiled reader's P5, not this fix.
      const text = page.locator('.pdf-viewer:visible .textLayer span').first();
      await text.click({ button: 'right' });
      await check('menuUnchanged', await page.evaluate(() => window.menuPrevented === false), { defaultPrevented: await page.evaluate(() => window.menuPrevented) });
      await page.keyboard.press('Escape');
    }
    caseResult.servedBinding = await binding.check();
    if (caseResult.executed.length !== requiredArms.length || requiredArms.some(arm => caseResult.executed.filter(executed => executed === arm).length !== 1)) throw new Error(`Required arms did not execute exactly once: ${caseResult.executed}`);
    await check('pageErrors', errors.length === 0, errors);
    caseResult.servedBinding = await binding.check();
    for (const required of requiredBodies) {
      if (!caseResult.servedBinding.modules.some(module => module.path === required)) throw new Error(`Required served body not observed: ${required}`);
    }
    await binding.stop();
    await context.close();
  }
  report.requestedCasesComplete = report.cases.length === variants.length;
  report.mutantRejected = mutant === 'none' ? null : report.requestedCasesComplete && report.failures.length === variants.length && report.cases.every(result => result.executed.filter(arm => arm === mutant).length === 1 && report.failures.includes(`${result.theme}/${result.dpr} ${mutant}`));
} catch (error) {
  report.executionError = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  await browser.close();
  await writeFile(resolve(outDir, 'result.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ failures: report.failures, result: resolve(outDir, 'result.json') }));
if (mode !== 'record' && report.failures.length) process.exitCode = 1;
