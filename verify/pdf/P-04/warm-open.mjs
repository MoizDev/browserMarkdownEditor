// D4-G1: a real warm-module first open versus a new byte-identical document.
// No app imports/hooks. Timestamps precede native getFile and follow native blit;
// pixel readback/hashing happens afterwards and is never the timestamp being timed.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { loadIdentityToolbox } from '../lib/identityToolbox.mjs';
import { pdfFixtureManifest, readPdfFixture } from '../lib/fixtures.mjs';

const [url, corpus, out, mode = 'verify'] = process.argv.slice(2);
if (process.argv.length > 6 || !url || !corpus || !out || !['record', 'verify'].includes(mode) || !process.env.CHROME || !process.env.BUILD_WORKTREE || !process.env.BUILD_DIST) throw new Error('URL corpus output [record|verify]; set CHROME, BUILD_WORKTREE, BUILD_DIST');
const driver = createRequire(import.meta.url)('playwright/package.json').version;
if (driver !== '1.63.0') throw new Error('Wrong Playwright');
const { buildIdentity, bindServedBodies, toolboxIdentity } = await loadIdentityToolbox();
const identity = await buildIdentity({ worktree: process.env.BUILD_WORKTREE, distDir: process.env.BUILD_DIST });
if (!identity.treeClean || !identity.files.length) throw new Error('Expected a clean production source identity');
const fixture = await readPdfFixture('GEN-P11-dense40', corpus, await pdfFixtureManifest());
const pane = identity.files.filter(file => /\/PdfPane-[^/]+\.js$/.test(file.path));
if (pane.length !== 1) throw new Error('Missing unique PdfPane chunk');
await mkdir(out, { recursive: true });
const report = { build: identity, toolbox: toolboxIdentity, driver, fixture: fixture.admission, mode, cases: [], failures: [], loss: 'Functional unlocked first-read/fallback reproduction. First-pixel timings are advisory; no calibrated open-path or sharpness claim.' };
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME });
try {
    report.browser = browser.version();
    if (report.browser !== '157.0.8103.39') throw new Error('Wrong Chrome');
    for (const dpr of [1, 2]) {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr });
        const page = await context.newPage(), errors = [], parsed = [];
        const binding = await bindServedBodies(context, { identity, origin: url, mode: 'raw-route', buildMode: 'production' });
        const cdp = await context.newCDPSession(page);
        await cdp.send('Debugger.enable');
        cdp.on('Debugger.scriptParsed', event => { if (event.url && new URL(event.url, url).pathname === `/${pane[0].path}`) parsed.push({ url: event.url, scriptId: event.scriptId, isModule: event.isModule }); });
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/*', route => new URL(route.request().url()).origin === new URL(url).origin ? route.fallback() : route.abort());
        await page.addInitScript(panePath => {
            const grant = handle => { handle.queryPermission = handle.requestPermission = async () => 'granted'; return handle; };
            const getDirectory = FileSystemDirectoryHandle.prototype.getDirectoryHandle;
            FileSystemDirectoryHandle.prototype.getDirectoryHandle = async function (...args) { return grant(await getDirectory.apply(this, args)); };
            window.showDirectoryPicker = async () => grant(await (await navigator.storage.getDirectory()).getDirectoryHandle('WarmPdfVault', { create: true }));
            window.openWitness = { clicks: [], reads: [], blits: [], fallbacks: [] };
            window.addEventListener('pointerdown', event => {
                const row = event.target instanceof Element ? event.target.closest('.tree-item') : null;
                const name = row?.textContent?.match(/(?:first|second)\.pdf/)?.[0];
                if (!name) return;
                window.activePdfOpen = name;
                window.openWitness.clicks.push({ file: name, t: event.timeStamp, trusted: event.isTrusted });
            }, true);
            const getFile = FileSystemFileHandle.prototype.getFile;
            FileSystemFileHandle.prototype.getFile = function (...args) {
                const documentRead = new Error().stack?.includes(panePath) === true;
                const t = performance.now();
                const value = getFile.apply(this, args);
                if (['first.pdf', 'second.pdf'].includes(this.name)) window.openWitness.reads.push({ file: this.name, t, active: window.activePdfOpen, documentRead });
                return value;
            };
            const drawImage = CanvasRenderingContext2D.prototype.drawImage;
            CanvasRenderingContext2D.prototype.drawImage = function (...args) {
                const value = drawImage.apply(this, args), t = performance.now();
                const canvas = this.canvas;
                if (!(canvas instanceof HTMLCanvasElement) || !canvas.matches('.pdf-viewer-page > canvas') || canvas.parentElement !== canvas.closest('.pdf-viewer')?.querySelector('.pdf-viewer-page') || !window.activePdfOpen || getComputedStyle(canvas).visibility === 'hidden') return value;
                const file = window.activePdfOpen;
                if (window.openWitness.blits.some(blit => blit.file === file && blit.inkPixels > 0)) return value;
                const pixels = this.getImageData(0, 0, canvas.width, canvas.height).data;
                let inkPixels = 0;
                for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 180 && pixels[i + 1] < 180 && pixels[i + 2] < 180 && pixels[i + 3] === 255) inkPixels++;
                const blit = { file, t, inkPixels, width: canvas.width, height: canvas.height, sha256: null };
                window.openWitness.blits.push(blit);
                crypto.subtle.digest('SHA-256', pixels).then(hash => { blit.sha256 = [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, '0')).join(''); });
                return value;
            };
            const seen = new WeakMap();
            new MutationObserver(() => {
                for (const element of document.querySelectorAll('.pdf-pane.pdf-pane-message')) if (!seen.has(element)) {
                    const row = { file: window.activePdfOpen, attach: performance.now(), remove: null, text: element.textContent, rect: element.getBoundingClientRect().toJSON() };
                    seen.set(element, row); window.openWitness.fallbacks.push(row);
                }
                for (const element of document.querySelectorAll('.pdf-pane.pdf-pane-message')) if (seen.has(element)) seen.get(element).stillPresent = true;
                // Removed roots cannot be rediscovered in the document; the
                // separate observer records their own retained DOM references.
            }).observe(document, { childList: true, subtree: true });
            new MutationObserver(records => {
                for (const record of records) for (const removed of record.removedNodes) if (removed instanceof Element) {
                    const roots = [removed, ...removed.querySelectorAll('.pdf-pane.pdf-pane-message')];
                    for (const root of roots) { const row = seen.get(root); if (row && row.remove === null) row.remove = performance.now(); }
                }
            }).observe(document, { childList: true, subtree: true });
        }, `/${pane[0].path}`);
        await page.goto(url);
        await binding.check();
        await page.evaluate(async bytes => {
            const vault = await (await navigator.storage.getDirectory()).getDirectoryHandle('WarmPdfVault', { create: true });
            for (const name of ['first.pdf', 'second.pdf']) { const write = await (await vault.getFileHandle(name, { create: true })).createWritable(); await write.write(new Uint8Array(bytes)); await write.close(); }
            const note = await (await vault.getFileHandle('note.md', { create: true })).createWritable(); await note.write('# Warm module witness\n'); await note.close();
        }, [...fixture.bytes]);
        await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
        // Wait for the actual idle prefetch, not an app import from the run.
        const deadline = Date.now() + 15000;
        while (!parsed.length && Date.now() < deadline) await page.waitForTimeout(25);
        const prefetched = await binding.check();
        if (!parsed.length || !prefetched.modules.some(module => module.path === pane[0].path)) throw new Error('No fetched+compiled prefetch before click');
        if (await page.locator('.pdf-pane').count()) throw new Error('A PDF was mounted merely to prewarm it');
        await page.waitForTimeout(100);
        const pairs = [];
        for (const name of ['first.pdf', 'second.pdf']) {
            await page.locator('.tree-item').filter({ hasText: name }).click();
            await page.waitForFunction(name => window.openWitness.blits.some(blit => blit.file === name && blit.inkPixels > 100 && blit.sha256), name);
            await page.evaluate(() => document.fonts.ready);
            const frames = [];
            for (let frame = 0; frame < 3; frame++) {
                await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
                frames.push(await page.locator('.pdf-viewer:visible .pdf-viewer-page > canvas').first().evaluate(async canvas => {
                    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
                    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', pixels))].map(x => x.toString(16).padStart(2, '0')).join('');
                }));
            }
            const witness = await page.evaluate(name => {
                const all = window.openWitness;
                const click = all.clicks.find(row => row.file === name);
                const read = all.reads.find(row => row.file === name && row.documentRead && row.t >= click.t);
                const ink = all.blits.find(row => row.file === name && row.inkPixels > 100);
                return { click, read, ink, fallbacks: all.fallbacks.filter(row => row.file === name) };
            }, name);
            await binding.check();
            if (!witness.click?.trusted || !witness.read || !witness.ink || frames.some(hash => hash !== witness.ink.sha256)) throw new Error('Missing trusted click/read/ink/stable first-frame identity');
            pairs.push({ ...witness, frames, clickToReadMs: witness.read.t - witness.click.t, clickToInkMs: witness.ink.t - witness.click.t });
            await page.screenshot({ path: resolve(out, `dpr${dpr}-${name}.png`) });
        }
        const readDelta = pairs[0].clickToReadMs - pairs[1].clickToReadMs;
        const plateau = pairs[0].fallbacks.some(row => row.remove !== null && pairs[0].read.t - row.attach > 200);
        const pass = readDelta <= 50 && !plateau && pairs[0].fallbacks.length === 0;
        const servedBinding = await binding.check();
        if (errors.length) throw new Error(`Page errors: ${errors.join('; ')}`);
        report.cases.push({ dpr, parsedBeforeFirstClick: parsed, pairs, readDelta, plateau, pass, errors, servedBinding });
        if (!pass) report.failures.push(`D4-G1 DPR${dpr}`);
        await binding.stop(); await context.close();
    }
} catch (error) {
    report.executionError = error.message; throw error;
} finally {
    await browser.close();
    await writeFile(resolve(out, 'result.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report.cases.map(row => ({ dpr: row.dpr, readMs: row.pairs.map(pair => pair.clickToReadMs), inkMs: row.pairs.map(pair => pair.clickToInkMs), readDelta: row.readDelta, plateau: row.plateau, pass: row.pass })), null, 2));
if (mode !== 'record' && report.failures.length) process.exitCode = 1;
