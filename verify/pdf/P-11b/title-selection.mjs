import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { loadIdentityToolbox } from '../lib/identityToolbox.mjs';
import { pdfFixtureManifest, readPdfFixture } from '../lib/fixtures.mjs';
const { buildIdentity, bindServedBodies, toolboxIdentity } = await loadIdentityToolbox();

const [url, bookDirectory, fontDirectory, out] = process.argv.slice(2);
const mutant = process.env.BUILD_MUTANT ?? 'none';
if (process.argv.length !== 6 || !url || !bookDirectory || !fontDirectory || !out || !process.env.CHROME || !process.env.BUILD_WORKTREE || !process.env.BUILD_DIST || !['none', 'omit-remeasure'].includes(mutant)) throw new Error('URL book-corpus first-font-corpus output; set CHROME, BUILD_WORKTREE, BUILD_DIST, optional BUILD_MUTANT=omit-remeasure');
const manifest = await pdfFixtureManifest();
const bookManifest = process.env.PDF_BOOK_MANIFEST_COMMIT ? await pdfFixtureManifest(process.env.PDF_BOOK_MANIFEST_COMMIT) : manifest;
const patch = mutant === 'none' ? undefined : await readFile(resolve(process.env.BUILD_WORKTREE, 'verify/pdf/P-11b/mutants/omit-remeasure.patch'));
const identity = await buildIdentity({ worktree: process.env.BUILD_WORKTREE, distDir: process.env.BUILD_DIST, patch });
if (!identity.files.length || (mutant === 'none' ? !identity.treeClean : identity.treeClean || !identity.patchSha256)) throw new Error('Missing clean/named-mutant build identity');
const html = await readFile(resolve(process.env.BUILD_DIST, 'index.html'), 'utf8');
const requiredBodies = [...html.matchAll(/<script\b[^>]*src="([^"]+)"/g)].map(match => match[1].replace(/^\//, ''));
for (const pattern of [/\/PdfPane-[^/]+\.js$/, /\/pdfWorker-[^/]+\.js$/, /\/pdf\.worker[^/]+\.mjs$/]) {
    const entries = identity.files.filter(file => pattern.test(file.path));
    if (entries.length !== 1) throw new Error(`Missing unique emitted module ${pattern}`);
    requiredBodies.push(entries[0].path);
}
if (requiredBodies.length !== 4) throw new Error('Missing unique main entry');
const fixtures = [];
for (const [id, directory, slug] of [['GEN-18-876', bookDirectory, 'unique-textbook-876'], ['GEN-P11b-first-font-30', fontDirectory, 'first-font-title']]) {
    const fixture = await readPdfFixture(id, directory, id === 'GEN-18-876' ? bookManifest : manifest);
    const { oracle } = fixture;
    if (fixture.file !== `${slug}.pdf`) throw new Error(`Unexpected admitted file for ${id}`);
    const line = oracle.expected.pageModels[0].lines[0];
    const gesture = oracle.expected.title ?? { text: oracle.expected.gestures.title.correct, from: oracle.expected.gestures.title.from, to: oracle.expected.gestures.title.to, x: line.x, width: line.text.length * line.size * .6 };
    fixtures.push({ ...fixture, gesture });
}
const driver = createRequire(import.meta.url)('playwright/package.json').version;
if (driver !== '1.63.0') throw new Error('Wrong Playwright');
await mkdir(out, { recursive: true });
const report = { build: identity, toolbox: toolboxIdentity, driver, mutant, requiredBodies, cases: [], failures: [] };
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME });
try {
    report.browser = browser.version();
    if (report.browser !== '157.0.8103.39') throw new Error('Wrong Chrome');
    for (const theme of ['dark', 'light']) for (const dpr of [1, 2]) for (const fixture of fixtures) {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr, permissions: ['clipboard-read', 'clipboard-write'] });
        const page = await context.newPage(), errors = [];
        const binding = await bindServedBodies(context, { identity, origin: url, mode: 'raw-route', buildMode: 'production' });
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/*', route => new URL(route.request().url()).origin === new URL(url).origin ? route.fallback() : route.abort());
        await page.addInitScript(theme => {
            localStorage.setItem('theme', theme);
            const grant = handle => { handle.queryPermission = handle.requestPermission = async () => 'granted'; return handle; };
            const getDirectory = FileSystemDirectoryHandle.prototype.getDirectoryHandle;
            FileSystemDirectoryHandle.prototype.getDirectoryHandle = async function (...args) { return grant(await getDirectory.apply(this, args)); };
            window.showDirectoryPicker = async () => grant(await (await navigator.storage.getDirectory()).getDirectoryHandle('TitleSelectionVault', { create: true }));
            window.removedTextNodes = 0;
            new MutationObserver(records => {
                for (const record of records) if (record.target instanceof Element && record.target.closest('.textLayer')) window.removedTextNodes += record.removedNodes.length;
            }).observe(document, { childList: true, subtree: true });
        }, theme);
        await page.goto(url);
        await binding.check();
        await page.evaluate(async ({ file, bytes }) => {
            const vault = await (await navigator.storage.getDirectory()).getDirectoryHandle('TitleSelectionVault', { create: true });
            const writer = await (await vault.getFileHandle(file, { create: true })).createWritable();
            await writer.write(new Uint8Array(bytes)); await writer.close();
        }, { file: fixture.oracle.file, bytes: [...fixture.bytes] });
        await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
        await page.locator('.tree-item').filter({ hasText: fixture.oracle.file }).click();
        await binding.check();
        await page.waitForFunction(({ count, lastLine }) => document.querySelectorAll('.pdf-viewer-page').length === count && document.querySelector('.pdf-viewer-page .textLayer')?.textContent.endsWith(lastLine) && document.querySelector('.pdf-viewer-page canvas')?.width > 1, { count: fixture.oracle.pages, lastLine: fixture.oracle.expected.pageModels[0].lines.at(-1).text });
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const screen = await page.evaluate(() => ({ dpr: devicePixelRatio, theme: document.documentElement.dataset.theme ?? 'dark' }));
        await binding.check();
        if (screen.dpr !== dpr || screen.theme !== theme) throw new Error('Screen identity mismatch');
        const geometry = await page.locator('.pdf-viewer:visible').evaluate((root, gesture) => {
            const box = root.querySelector('.pdf-viewer-page').getBoundingClientRect(), scale = box.width / 612;
            const span = root.querySelector('.textLayer span'), rect = span.getBoundingClientRect();
            const points = [gesture.from, gesture.to].map((p, i) => ({ x: box.left + p[0] * scale + (i ? -.75 : .5), y: box.top + p[1] * scale }));
            return { box: box.toJSON(), span: rect.toJSON(), expectedWidth: gesture.width * scale, expectedLeft: box.left + gesture.x * scale,
                points: points.map(point => { const hit = document.elementFromPoint(point.x, point.y), caret = document.caretPositionFromPoint(point.x, point.y); return { ...point, hit: hit?.tagName, hitText: hit?.textContent, caretOffset: caret?.offset, caretText: caret?.offsetNode?.textContent }; }), scaleX: getComputedStyle(span).getPropertyValue('--scale-x') };
        }, fixture.gesture);
        await binding.check();
        if (Math.abs(geometry.box.height - geometry.box.width * 792 / 612) > 1 || geometry.box.y < 0 || geometry.points.some(point => point.y < 70 || point.y > 880)) throw new Error('Page/gesture rectangle identity mismatch');
        const sentinel = `UNTOUCHED-P11b:${identity.manifestSha256}:${theme}:${dpr}:${fixture.id}`;
        await page.evaluate(value => { getSelection()?.removeAllRanges(); return navigator.clipboard.writeText(value); }, sentinel);
        await binding.check();
        if (await page.evaluate(() => getSelection().toString()) !== '' || await page.evaluate(() => navigator.clipboard.readText()) !== sentinel) throw new Error('Pre-action empty-selection/sentinel witness failed');
        const [a, b] = geometry.points;
        await page.mouse.move(a.x, a.y); await page.mouse.down();
        await page.mouse.move(b.x, b.y, { steps: 18 }); await page.mouse.up();
        const live = await page.locator('.pdf-viewer:visible').evaluate(root => {
            const span = root.querySelector('.textLayer span'), selection = getSelection();
            return { text: selection.toString(), rangeCount: selection.rangeCount, noncollapsed: !selection.isCollapsed, anchorInTitle: span.contains(selection.anchorNode), focusInTitle: span.contains(selection.focusNode), anchor: selection.anchorOffset, focus: selection.focusOffset, removedTextNodes: window.removedTextNodes };
        });
        await page.keyboard.press('Meta+c');
        await page.waitForFunction(sentinel => navigator.clipboard.readText().then(text => text !== sentinel), sentinel, { timeout: 2500 }).catch(error => { if (error.name !== 'TimeoutError') throw error; });
        const clipboard = await page.evaluate(() => navigator.clipboard.readText());
        const servedBinding = await binding.check();
        for (const required of requiredBodies) if (!servedBinding.modules.some(module => module.path === required)) throw new Error(`Required served body not observed: ${required}`);
        const geometryCorrect = Math.abs(geometry.span.width - geometry.expectedWidth) <= 2 && Math.abs(geometry.span.left - geometry.expectedLeft) <= 1 && geometry.points[0].caretOffset === 0 && geometry.points[1].caretOffset === fixture.gesture.text.length && geometry.points.every(point => point.hitText === fixture.gesture.text && point.caretText === fixture.gesture.text);
        const pass = geometryCorrect && live.rangeCount > 0 && live.noncollapsed && live.anchorInTitle && live.focusInTitle && live.text === fixture.gesture.text && live.anchor === 0 && live.focus === fixture.gesture.text.length && live.removedTextNodes === 0 && clipboard !== sentinel && clipboard === fixture.gesture.text && errors.length === 0;
        const row = { theme, dpr, fixture: { id: fixture.id, sha256: fixture.admission.sha256, admission: fixture.admission.manifest }, expected: fixture.gesture.text, geometry, geometryCorrect, live, clipboard, replacedSentinel: clipboard !== sentinel, errors, servedBinding, executed: true, pass };
        report.cases.push(row);
        if (!pass) report.failures.push(`${theme}/${dpr}/${fixture.id}`);
        await page.screenshot({ path: resolve(out, `${theme}-${dpr}-${fixture.id}-selected.png`) });
        await binding.check();
        await binding.stop(); await context.close();
    }
    report.requestedCasesComplete = report.cases.length === 8;
    report.mutantRejected = mutant === 'none' ? null : report.requestedCasesComplete && report.failures.length === 4 && report.cases.every(row => row.pass === !(row.fixture.id === 'GEN-18-876' ? row.dpr === 2 : row.dpr === 1));
} catch (error) {
    report.executionError = error.message;
    throw error;
} finally {
    await browser.close();
    await writeFile(resolve(out, 'result.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ failures: report.failures, mutantRejected: report.mutantRejected, result: resolve(out, 'result.json') }));
if (report.failures.length) process.exitCode = 1;
