import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { serveApp } from '../../lib/serve.mjs';
import { bindServedBodies } from '../../lib/identity.mjs';
import { installVault, seedVault, readWitness } from '../../lib/vault.mjs';

if (process.argv.length !== 2) throw new Error('Use environment configuration only');
const mode = process.env.BME_MODE ?? 'production';
if (!['dev', 'production'].includes(mode)) throw new Error('BME_MODE must be dev or production');
const port = Number(process.env.BME_PORT ?? 6404), dpr = Number(process.env.BME_DPR ?? 1), theme = process.env.BME_THEME ?? 'dark';
const focus = process.env.BME_FOCUS ?? 'viewer', portfolioArm = process.env.BME_PORTFOLIO ?? '0', inspectQuality = process.env.BME_QUALITY ?? '0';
if (!['viewer', 'header'].includes(focus) || !['0', '1'].includes(portfolioArm) || !['0', '1'].includes(inspectQuality)) throw new Error('Invalid focus/portfolio/quality arm');
if (!Number.isInteger(port) || port < 6400 || port > 6419 || ![1, 2].includes(dpr) || !['dark', 'light'].includes(theme)) throw new Error('Invalid assigned port/theme/DPR');
const root = resolve(process.env.BME_ROOT ?? '.'), scratch = resolve(process.env.BME_SCRATCH ?? '/Users/adham/Developer/bme-impl/scratch/p-b/p07b1-app');
const out = resolve(process.env.BME_OUT ?? '/Users/adham/Developer/bme-impl/scratch/p-b/p07b1-baseline');
const fixtures = resolve(process.env.BME_FIXTURES ?? '/Users/adham/Developer/bme-impl/scratch/p-b/textbook876-v2');
const catalog = JSON.parse(await readFile(process.env.BME_FIXTURE_MANIFEST ?? new URL('../../fixtures/pdf/manifest.json', import.meta.url), 'utf8'));
const pdfRecord = catalog.fixtures.find(entry => entry.id === 'GEN-18-876');
const oracleRecord = catalog.fixtures.find(entry => entry.id === 'GEN-18-876-oracle');
if (!pdfRecord || !oracleRecord) throw new Error('GEN-18 PDF and independent oracle must be admitted in the supplied manifest');
const pdf = await readFile(resolve(fixtures, pdfRecord.file)), oracleBytes = await readFile(resolve(fixtures, oracleRecord.file));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
for (const [record, bytes] of [[pdfRecord, pdf], [oracleRecord, oracleBytes]]) if (record.sha256 !== hash(bytes) || record.bytes !== bytes.length) throw new Error(`Fixture identity mismatch: ${record.file}`);
let portfolio, portfolioRecord;
if (portfolioArm === '1') {
    portfolioRecord = catalog.fixtures.find(entry => entry.id === 'GEN-25/portfolio');
    if (!portfolioRecord) throw new Error('Portfolio fixture is not admitted');
    portfolio = await readFile(resolve(process.env.BME_ROLE_FIXTURES ?? '/Users/adham/Developer/bme-impl/scratch/p-b/p07b2-role-fixtures', portfolioRecord.file));
    if (hash(portfolio) !== portfolioRecord.sha256 || portfolio.length !== portfolioRecord.bytes) throw new Error('Portfolio fixture differs');
}
const oracle = JSON.parse(oracleBytes.toString('utf8'));
const queries = oracle.expected.queries.filter(item => item.neverBuiltOnOpen);
if (queries.length !== 4 || !queries.some(item => item.pages[0] === 450)) throw new Error('Expected four independent remote sentinel arms');
const pin = JSON.parse(await readFile(new URL('../../browser-pin.json', import.meta.url), 'utf8'));
const chrome = resolve('/Users/adham/Developer/bme-impl/scratch/browsers', pin.version, pin.executable);
const driver = JSON.parse(await readFile(new URL('../../../node_modules/playwright/package.json', import.meta.url), 'utf8'));
if (`playwright@${driver.version}` !== pin.driver) throw new Error('Driver is not pinned');
await mkdir(out, { recursive: true });
const result = { pass: false, phase: 'setup', identity: { fixtures: [pdfRecord, oracleRecord, ...(portfolioRecord ? [portfolioRecord] : [])], browser: pin.version, driver: driver.version, mode, dpr, theme, focus }, observations: [], errors: [],
    loss: ['Generated source only; no authorised originals or native disk.', 'R7/R8 reference timing is separate; raw-route binding disables HTTP cache.'] };
let app, browser, page, binding;
async function witness(value, name) {
    await binding.check();
    if (!value) { result.namedFailure = name; throw new Error(name); }
}
try {
    app = await serveApp({ root, scratch, port, mode, build: false }); result.identity.build = app.identity;
    if (!app.identity.treeClean) throw new Error('Prepare from committed app source');
    browser = await chromium.launch({ headless: true, executablePath: chrome });
    if (browser.version() !== pin.version) throw new Error('Browser is not pinned');
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: dpr, permissions: ['clipboard-read', 'clipboard-write'] });
    binding = await bindServedBodies(context, { identity: app.identity, origin: app.url, mode: 'raw-route', buildMode: mode, report: { data: result } });
    await installVault(context, { name: 'Original find vault' });
    await context.addInitScript(theme => {
        localStorage.setItem('theme', theme);
        window.__findKeys = []; window.__findText = [];
        window.addEventListener('keydown', event => {
            if (!(event.metaKey || event.ctrlKey) || !['f', 'g'].includes(event.key.toLowerCase())) return;
            // Native dispatch may checkpoint microtasks between listeners.
            // Keep the event, then read its final defaultPrevented from Node
            // after the real press, even if the viewer stopped propagation.
            window.__findKeys.push(event);
        }, true);
        const post = Worker.prototype.postMessage;
        Worker.prototype.postMessage = function (message, ...args) {
            if (message?.action === 'GetTextContent') {
                const stack = new Error().stack ?? '';
                window.__findText.push({ page: message.data?.pageIndex, raw: message.data?.disableNormalization === true,
                    origin: stack.includes('/src/utils/pdfReadingText.ts') ? 'index' : stack.includes('/src/components/PdfViewer.tsx') ? 'layer' : 'bundled', at: performance.now() });
            }
            return post.call(this, message, ...args);
        };
    }, theme);
    page = await context.newPage(); page.on('pageerror', error => result.errors.push(String(error)));
    await page.goto(app.url);
    await seedVault(page, { name: 'Original find vault', files: { [pdfRecord.file]: pdf, 'Pause.md': '# Pause\n\nOriginal find is hidden.\n', ...(portfolio ? { [portfolioRecord.file]: portfolio } : {}) } });
    const seeded = await readWitness(page, { name: 'Original find vault', path: pdfRecord.file, binary: true, report: { data: result } });
    await witness(hash(seeded) === pdfRecord.sha256, 'Seeded PDF identity');
    await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
    await page.locator('.tree-item').filter({ hasText: pdfRecord.file }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.pdf-viewer-page canvas')].some(canvas => canvas.width > 0));
    await witness(await page.locator('.pdf-viewer-page').count() === 876, 'Actual 876-page Original viewer mounted');
    await witness(await page.locator('.pdf-viewer-page').nth(449).locator('.textLayer span').count() === 0, 'Page 450 was not already built');
    const input = page.getByRole('textbox', { name: 'Find in PDF', exact: true });
    await witness(await input.count() === 0, 'Find bar starts closed');
    await page.locator('.pdf-viewer-scroll').click({ position: { x: 25, y: 25 } });
    if (focus === 'header') {
        await page.getByRole('button', { name: 'More options', exact: true }).click();
        await page.keyboard.press('Escape');
        await witness(await page.evaluate(() => !!document.activeElement?.closest('.editor-slot-header') && !document.activeElement?.closest('.pdf-viewer') && !document.querySelector('[role="menu"]')), 'Header owns focus outside the viewer before Meta+F');
    }
    await page.keyboard.press('Meta+f');
    await page.waitForFunction(() => window.__findKeys.length > 0);
    const key = await page.evaluate(() => { const event = window.__findKeys.at(-1); return { key: event.key.toLowerCase(), shift: event.shiftKey, prevented: event.defaultPrevented, trusted: event.isTrusted }; });
    result.route = { key, inputCount: await input.count(), active: await page.evaluate(() => ({ tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label') })) };
    result.phase = 'functional';
    await witness(key.trusted && key.prevented && result.route.inputCount === 1, 'R1: Original Meta+F must open the app-owned find bar');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Find in PDF');
    await witness(await input.evaluate(element => element === document.activeElement), 'R1: Find input owns focus');
    for (const probe of queries) {
        await input.fill('P07b1-absent-sentinel');
        await page.waitForFunction(() => document.querySelector('.pdf-find-bar [role="status"]')?.textContent === 'No matches', undefined, { timeout: 120000 });
        await input.fill(probe.query);
        await page.waitForFunction(() => document.querySelector('.pdf-find-bar [role="status"]')?.textContent === '1 of 1', undefined, { timeout: 120000 });
        await page.waitForFunction(number => document.querySelector('.pdf-viewer-page-input')?.value === String(number), probe.pages[0]);
        // Search completion and the approximate page jump can precede both
        // TextLayer completion and the offscreen-canvas blit. Wait for the
        // actual user-visible result, not the unrelated status update.
        try {
            await page.waitForFunction(({ query, number }) => {
                const ranges = [...(CSS.highlights.get('pdf-find-current') ?? [])];
                if (ranges.length !== 1 || ranges[0].toString() !== query) return false;
                const row = ranges[0].startContainer.parentElement?.closest('.pdf-viewer-page');
                const r = ranges[0].getBoundingClientRect(), box = document.querySelector('.pdf-viewer-scroll').getBoundingClientRect();
                return [...document.querySelectorAll('.pdf-viewer-page')].indexOf(row) + 1 === number && row?.querySelector('canvas')?.width > 0 &&
                    r.width > 0 && r.height > 0 && r.top >= box.top && r.bottom <= box.bottom && r.left >= box.left && r.right <= box.right;
            }, { query: probe.query, number: probe.pages[0] }, { timeout: 30000 });
        } catch (error) {
            result.pendingReveal = await page.evaluate(() => ({ ranges: [...(CSS.highlights.get('pdf-find-current') ?? [])].map(range => ({ text: range.toString(), rect: range.getBoundingClientRect().toJSON() })),
                box: document.querySelector('.pdf-viewer-scroll').getBoundingClientRect().toJSON(), canvasWidths: [...document.querySelectorAll('.pdf-viewer-page canvas')].flatMap((canvas, index) => canvas.width ? [{ page: index + 1, width: canvas.width }] : []) }));
            throw error;
        }
        const current = await page.evaluate(() => {
            const ranges = [...(CSS.highlights.get('pdf-find-current') ?? [])], box = document.querySelector('.pdf-viewer-scroll').getBoundingClientRect();
            return ranges.map(range => { const r = range.getBoundingClientRect(); return { text: range.toString(), page: [...document.querySelectorAll('.pdf-viewer-page')].indexOf(range.startContainer.parentElement.closest('.pdf-viewer-page')) + 1,
                visible: r.width > 0 && r.height > 0 && r.top >= box.top && r.bottom <= box.bottom && r.left >= box.left && r.right <= box.right }; });
        });
        await witness(current.length === 1 && current[0].text === probe.query && current[0].page === probe.pages[0] && current[0].visible, 'R1: Remote sentinel has one visible current range on its actual glyph layer');
        result.observations.push({ query: probe.query, page: probe.pages[0], current });
    }
    await witness(result.observations.length === 4, 'All four remote sentinel arms executed');
    const after = await readWitness(page, { name: 'Original find vault', path: pdfRecord.file, binary: true, report: { data: result } });
    await witness(hash(after) === pdfRecord.sha256, 'Read-only find preserves PDF bytes');
    await page.evaluate(async () => { await document.fonts.ready; });
    await page.screenshot({ path: resolve(out, 'original-find.png') });
    result.coverageWarning = await page.locator('.pdf-find-quality').textContent();
    if (inspectQuality === '1') {
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: 'More options', exact: true }).click();
        await page.getByRole('menuitemradio', { name: 'Read extracted text', exact: true }).click();
        await page.waitForFunction(() => [...document.querySelectorAll('.pdf-reading-quality')].some(node => node.textContent.includes('Possible columns')));
        result.qualityExplanation = await page.locator('.pdf-reading-quality').allTextContents();
        await witness(result.qualityExplanation.some(text => text.includes('Possible columns')) && !result.qualityExplanation.some(text => text.includes('Extraction stopped')), 'Book partial-quality witness is a reading-order caveat, not a safety limit');
        await page.screenshot({ path: resolve(out, 'quality-explanation.png') });
    }
    if (portfolioArm === '1') {
        await page.locator('.tree-item').filter({ hasText: portfolioRecord.file }).click();
        const pane = page.locator('.pdf-pane:not(.pdf-pane-hidden)');
        await pane.locator('.pdf-viewer-scroll').click({ position: { x: 25, y: 25 } });
        await page.keyboard.press('Meta+e');
        await pane.locator('.pdf-role-notice').waitFor({ state: 'visible' });
        await witness(await pane.locator('.tl-container').count() === 0, 'Portfolio Annotate is refused and remains a reader');
        await pane.locator('.pdf-viewer-scroll').click({ position: { x: 25, y: 25 } });
        const before = await page.evaluate(() => window.__findKeys.length);
        await page.keyboard.press('Meta+f');
        await witness(await page.evaluate(count => window.__findKeys.length === count + 1 && window.__findKeys.at(-1).defaultPrevented, before), 'Refused Annotate Meta+F is intercepted');
        const field = pane.getByRole('textbox', { name: 'Find in PDF', exact: true });
        await field.fill('OUTER MUST SURVIVE');
        await page.waitForFunction(() => document.querySelector('.pdf-pane:not(.pdf-pane-hidden) .pdf-find-status')?.textContent === '1 of 1');
        result.portfolio = await page.evaluate(() => ({ notice: document.querySelector('.pdf-pane:not(.pdf-pane-hidden) .pdf-role-notice')?.textContent,
            current: [...(CSS.highlights.get('pdf-find-current') ?? [])].map(range => range.toString()), focus: document.activeElement?.getAttribute('aria-label') }));
        await witness(result.portfolio.current.length === 1 && result.portfolio.current[0] === 'OUTER MUST SURVIVE' && result.portfolio.focus === 'Find in PDF', 'Read-only Annotate finds the outer PDF text');
        const bytes = await readWitness(page, { name: 'Original find vault', path: portfolioRecord.file, binary: true, report: { data: result } });
        await witness(hash(bytes) === portfolioRecord.sha256, 'Portfolio Find preserves the complete outer file');
        await page.screenshot({ path: resolve(out, 'refused-annotate-find.png') });
    }
    result.textRequests = await page.evaluate(() => window.__findText);
    await witness(result.errors.length === 0, 'No uncaught page errors');
    result.pass = true;
} catch (error) {
    result.failure = String(error); result.pass = false; process.exitCode = 1;
    if (page) await page.screenshot({ path: resolve(out, 'failure.png') }).catch(() => {});
} finally {
    try { if (binding) await binding.check(); } catch (error) { result.bindingFailure = String(error); result.pass = false; process.exitCode = 1; }
    try { if (binding) await binding.stop(); } finally { try { if (browser) await browser.close(); } finally { if (app) await app.stop(); } }
    await writeFile(resolve(out, 'results.json'), JSON.stringify(result, null, 2) + '\n');
}
console.log(JSON.stringify({ pass: result.pass, namedFailure: result.namedFailure, failure: result.failure, results: resolve(out, 'results.json') }));
