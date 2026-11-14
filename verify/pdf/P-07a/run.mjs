import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { serveApp } from '../../lib/serve.mjs';
import { bindServedBodies } from '../../lib/identity.mjs';
import { installVault, seedVault, readWitness } from '../../lib/vault.mjs';

const port = Number(process.env.BME_PORT ?? 6401);
if (!Number.isInteger(port) || port < 6400 || port > 6419) throw new Error('Use the p-b assigned port range');
const sourceRoot = resolve(process.env.BME_ROOT ?? '.');
const out = resolve(process.env.BME_OUT ?? '/Users/adham/Developer/bme-impl/scratch/p-b/P-07a');
const fixtureDir = resolve(process.env.BME_FIXTURES ?? '/Users/adham/Developer/bme-impl/scratch/p-b/fixtures');
if (process.argv.length !== 2) throw new Error('This gate accepts environment configuration only');
for (const flag of ['BME_CORRUPT', 'BME_TEXTBOOK', 'BME_LIFECYCLE', 'BME_HIDE', 'BME_CAP']) if (process.env[flag] !== undefined && !['0', '1'].includes(process.env[flag])) throw new Error(`Invalid ${flag}`);
const mode = process.env.BME_MODE ?? 'production';
if (!['production', 'dev'].includes(mode)) throw new Error('BME_MODE must be production or dev');
if (process.env.BME_BASELINE !== undefined) throw new Error('Baseline is historical evidence, not an acceptance bypass');
const mutant = process.env.BME_MUTANT;
if (mutant !== undefined && !['hyphen', 'abort'].includes(mutant)) throw new Error('Unknown BME_MUTANT');
const serverScratch = resolve(process.env.BME_SCRATCH ?? `/Users/adham/Developer/bme-impl/scratch/p-b/${mode}`);
const browserPin = JSON.parse(await readFile(new URL('../../browser-pin.json', import.meta.url), 'utf8'));
const chrome = resolve('/Users/adham/Developer/bme-impl/scratch/browsers', browserPin.version, browserPin.executable);
const corrupt = process.env.BME_CORRUPT === '1', textbook = process.env.BME_TEXTBOOK === '1', cap = process.env.BME_CAP === '1', refine = process.env.BME_LIFECYCLE === '1', hide = process.env.BME_HIDE === '1';
if (Number(corrupt) + Number(textbook) + Number(cap) > 1) throw new Error('Choose one fixture role per fresh context');
if (refine && hide) throw new Error('Refine and hide require separate fresh sessions');
if ((refine || hide) && (!textbook || corrupt)) throw new Error('Lifecycle arm requires the textbook role, not corrupt corpus');
const dpr = Number(process.env.BME_DPR ?? 1), theme = process.env.BME_THEME ?? 'dark';
if (![1, 2].includes(dpr) || !['dark', 'light'].includes(theme)) throw new Error('Invalid BME_DPR or BME_THEME');
const oracleName = textbook ? 'unique-textbook-876.expected.json' : cap ? 'find-cap.json' : corrupt ? 'find-corpus-corrupt.json' : 'find-corpus.json';
const oracleBytes = await readFile(resolve(fixtureDir, oracleName)), oracle = JSON.parse(oracleBytes.toString('utf8'));
const manifest = textbook ? { ...oracle, probes: oracle.expected.queries.flatMap(({ query, pages }) => pages.map(page => ({ query, page }))) } : oracle;
const bytes = await readFile(resolve(fixtureDir, manifest.file));
const sha256 = createHash('sha256').update(bytes).digest('hex');
if (sha256 !== manifest.sha256) throw new Error('Fixture identity mismatch');
const catalogBytes = await readFile(process.env.BME_FIXTURE_MANIFEST ?? new URL('../../fixtures/pdf/manifest.json', import.meta.url));
const catalog = JSON.parse(catalogBytes.toString('utf8'));
const fixtureIdentity = [];
for (const [file, data] of [[manifest.file, bytes], [oracleName, oracleBytes]]) {
    const entry = catalog.fixtures.find(entry => entry.file === file), hash = createHash('sha256').update(data).digest('hex');
    if (!entry || entry.sha256 !== hash || entry.bytes !== data.length) throw new Error(`Fixture or independent oracle differs from the committed manifest: ${file}`);
    fixtureIdentity.push({ id: entry.id, file, sha256: hash, bytes: data.length });
}
await mkdir(out, { recursive: true });
let browser, page, binding, app;
const errors = [], observations = [];
function observeFind(theme) {
    localStorage.setItem('theme', theme);
    window.__findTraffic = [];
    window.__findAllocations = { utf8Bytes: 0, mapBytes: 0, encodes: 0, arrays: 0 };
    const encode = TextEncoder.prototype.encode;
    TextEncoder.prototype.encode = function (...args) {
        const value = encode.apply(this, args), caller = (new Error().stack ?? '').split('\n')[2] ?? '';
        if (caller.includes('/src/utils/pdfFind.ts')) { window.__findAllocations.utf8Bytes += value.byteLength; window.__findAllocations.encodes++; }
        return value;
    };
    const from = Uint32Array.from;
    Uint32Array.from = function (...args) {
        const value = from.apply(this, args), caller = (new Error().stack ?? '').split('\n')[2] ?? '';
        if (caller.includes('/src/utils/pdfFind.ts')) { window.__findAllocations.mapBytes += value.byteLength; window.__findAllocations.arrays++; }
        return value;
    };
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...args) {
        if (message?.action === 'GetTextContent') window.__findTraffic.push({ page: message.data?.pageIndex, canonical: message.data?.disableNormalization === true, at: performance.now() });
        return post.call(this, message, ...args);
    };
}
const result = { phase: 'setup', identity: { fixtures: fixtureIdentity, fixtureManifestSha256: createHash('sha256').update(catalogBytes).digest('hex'), mode, theme, dpr }, observations, errors,
    loss: ['Generated inputs only; no authorised originals.', 'Text-view adapter only; Original keyboard/highlight gates belong to P-07b.', 'StrictMode extraction counts exclude the independent Original text-layer pass.'],
    falsePass: 'Expected counts and pages come from the fixture author, not app extraction; each query is typed into the real visible Text find form.' };
async function assertWitness(value, message) {
    await binding.check();
    if (!value) { result.namedFailure = message; throw new Error(message); }
}
try {
    app = await serveApp({ root: sourceRoot, scratch: serverScratch, port, mode, build: false });
    result.identity.build = app.identity; result.identity.url = app.url;
    if (!app.identity.treeClean) throw new Error('Prepare from a committed app source tree');
    if (mutant ? app.identity.mutant?.name !== mutant || !app.identity.patchSha256 : app.identity.patchSha256 !== null) throw new Error('Candidate/mutant build identity does not match the requested arm');
    browser = await chromium.launch({ headless: true, executablePath: chrome });
    result.identity.browser = browser.version();
    if (browser.version() !== browserPin.version) throw new Error('Browser identity mismatch');
    const driver = JSON.parse(await readFile(new URL('../../../node_modules/playwright/package.json', import.meta.url), 'utf8'));
    if (driver.version !== '1.63.0') throw new Error('Playwright identity mismatch');
    result.identity.driver = driver.version;
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: dpr });
    binding = await bindServedBodies(context, { identity: app.identity, origin: app.url, mode: 'raw-route', buildMode: mode, report: { data: result } });
    await installVault(context, { name: 'Find corpus vault' });
    await context.addInitScript(observeFind, theme);
    page = await context.newPage(); page.on('pageerror', error => errors.push(String(error)));
    await page.goto(app.url);
    await seedVault(page, { name: 'Find corpus vault', files: { [manifest.file]: bytes, 'Find pause.md': '# Pause find\n\nThe PDF is hidden while this note is visible.\n' } });
    const seeded = await readWitness(page, { name: 'Find corpus vault', path: manifest.file, binary: true, report: { data: result } });
    await binding.check();
    await assertWitness(createHash('sha256').update(seeded).digest('hex') === sha256, 'OPFS seeded PDF identity mismatch');
    await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
    await page.locator('.tree-item').filter({ hasText: manifest.file }).click();
    await page.locator('.pdf-viewer-page canvas').first().waitFor();
    if (textbook) await assertWitness(await page.locator('.pdf-viewer-page').nth(449).locator('.textLayer span').count() === 0, 'Page 450 was already built');
    await page.getByRole('button', { name: 'More options', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'Read extracted text', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Find in extracted PDF text', exact: true });
    await input.waitFor();
    await page.waitForFunction(() => !!document.querySelector('[data-pdf-text-page="0"]'));
    await binding.check(); result.phase = 'functional';
    const trafficStart = await page.evaluate(() => window.__findTraffic.length);
    if (refine) {
        await input.fill('NEVER-BUILT-TARGET-0003'); await input.press('Enter');
        await page.waitForFunction(() => {
            const status = document.querySelector('.pdf-reading-results [role="status"]')?.textContent ?? '';
            return status.includes('pages searched') && !status.includes('876/876') && [...document.querySelectorAll('.pdf-reading-results li button')].some(button => button.textContent?.startsWith('Page 3 ·'));
        });
        await page.evaluate(() => {
            window.__staleFind = [];
            const root = document.querySelector('.pdf-reading');
            root.addEventListener('submit', () => {
                if (root.querySelector('.pdf-reading-find input').value === 'NEVER-BUILT-TARGET-0700') window.__refineActive = true;
            }, true);
            new MutationObserver(() => {
                if (!window.__refineActive) return;
                for (const button of root.querySelectorAll('.pdf-reading-results li button')) if (!button.textContent.startsWith('Page 700 ·')) window.__staleFind.push(button.textContent);
            }).observe(root, { subtree: true, childList: true, characterData: true });
        });
        await input.fill('NEVER-BUILT-TARGET-0700'); await input.press('Enter');
        await page.waitForFunction(() => document.querySelector('.pdf-reading-results [role="status"]')?.textContent?.includes('876/876 pages searched'), undefined, { timeout: 120000 });
        result.refine = { stale: await page.evaluate(() => window.__staleFind), requests: await page.evaluate(() => window.__findTraffic.filter(request => request.canonical)) };
        await assertWitness(result.refine.stale.length === 0, 'Refine published results from the aborted query');
        const refinedPages = await page.locator('.pdf-reading-results li button').allTextContents();
        await assertWitness(refinedPages.length === 1 && refinedPages[0].startsWith('Page 700 ·'), 'Refined query did not finish on page 700');
        const repeated = result.refine.requests.filter((request, i, all) => all.findIndex(other => other.page === request.page) !== i);
        await assertWitness(repeated.length === 0, 'Refinement extracted a canonical page more than once');
    }
    if (hide) {
        const hideQuery = 'A quiet bridge joins the two banks.';
        await page.evaluate(file => {
            window.__lostHideHits = [];
            document.addEventListener('pointerdown', event => {
                const row = event.target.closest('.tree-item')?.textContent ?? '';
                if (row.includes('Find pause')) {
                    window.__hideAt = document.querySelector('.pdf-reading-results [role="status"]')?.textContent;
                    window.__hideHits = [...document.querySelectorAll('.pdf-reading-results li button')].map(button => button.textContent);
                } else if (row.includes(file)) window.__watchRestore = true;
            }, true);
            const root = document.querySelector('.pdf-reading');
            new MutationObserver(() => {
                if (!window.__watchRestore || getComputedStyle(root).visibility === 'hidden') return;
                const shown = new Set([...root.querySelectorAll('.pdf-reading-results li button')].map(button => button.textContent));
                for (const text of window.__hideHits ?? []) if (!shown.has(text)) window.__lostHideHits.push(text);
            }).observe(root, { subtree: true, childList: true, characterData: true });
        }, manifest.file);
        // A cold session makes this a real, ongoing extraction scan. The
        // pointerdown witness below refuses an already-completed hide.
        await input.fill(hideQuery); await input.press('Enter');
        await page.waitForFunction(() => {
            const status = document.querySelector('.pdf-reading-results [role="status"]')?.textContent ?? '';
            return status.includes('pages searched') && !status.includes('876/876') && document.querySelectorAll('.pdf-reading-results li button').length > 0;
        });
        await page.locator('.tree-item').filter({ hasText: 'Find pause' }).click();
        const hideAt = await page.evaluate(() => window.__hideAt), beforeHits = await page.evaluate(() => window.__hideHits);
        await assertWitness(beforeHits.length > 0, 'Hide did not witness live hits to retain');
        await assertWitness(hideAt?.includes('pages searched') && !hideAt.includes('876/876'), 'The scan finished before the actual hide gesture');
        await page.locator('.cm-content').filter({ hasText: 'The PDF is hidden while this note is visible.' }).waitFor();
        await page.waitForFunction(() => getComputedStyle(document.querySelector('.pdf-pane')).visibility === 'hidden');
        const pane = page.locator('.pdf-pane');
        await assertWitness(await pane.evaluate(element => getComputedStyle(element).visibility) === 'hidden', 'PDF pane did not become hidden');
        const before = await page.evaluate(() => window.__findTraffic.length);
        await page.waitForTimeout(250); // The stated no-request observation interval.
        const after = await page.evaluate(() => window.__findTraffic.length);
        await assertWitness(after === before, 'Hidden PDF continued requesting extraction');
        await page.locator('.tree-item').filter({ hasText: manifest.file }).click();
        await input.waitFor();
        await assertWitness(await input.inputValue() === hideQuery, 'Hide discarded the query');
        await page.waitForFunction(() => document.querySelector('.pdf-reading-results [role="status"]')?.textContent?.includes('876/876 pages searched'), undefined, { timeout: 120000 });
        const lost = await page.evaluate(() => window.__lostHideHits);
        await assertWitness(lost.length === 0, 'Show discarded hits already found before hiding');
        result.hide = { hideAt, beforeHits, lost, before, after, status: await page.locator('.pdf-reading-results [role="status"]').textContent() };
        await page.evaluate(() => { window.__watchRestore = false; });
    }
    const queries = corrupt ? ['remote sentinel', 'later sentinel'] : [...new Set(manifest.probes.map(probe => probe.query))];
    for (const query of queries) {
        // A stale successful count cannot stand in for this submit: first make
        // an independently impossible query finish, and witness its zero hits.
        await input.fill('P07A-absent-sentinel-9127'); await input.press('Enter');
        await page.waitForFunction(total => document.querySelector('.pdf-reading-results [role="status"]')?.textContent?.startsWith(`0 matches · ${total}/${total} pages searched`), manifest.pages, { timeout: 120000 });
        await input.fill(query); await input.press('Enter');
        await page.waitForFunction(total => document.querySelector('.pdf-reading-results [role="status"]')?.textContent?.includes(`${total}/${total} pages searched`), manifest.pages, { timeout: 120000 });
        await binding.check();
        const status = await page.locator('.pdf-reading-results [role="status"]').textContent();
        const actualPages = await page.locator('.pdf-reading-results li button').allTextContents();
        const expectedPages = manifest.probes.filter(probe => probe.query === query).flatMap(probe => Array.from({ length: probe.reportedCount ?? probe.count ?? 1 }, () => probe.page)).sort((a, b) => a - b);
        const foundPages = actualPages.map(text => Number(/^Page (\d+)/u.exec(text)?.[1]));
        const pass = JSON.stringify(foundPages) === JSON.stringify(expectedPages) && (!cap || status.includes('Search limit reached (10,000 matches)'));
        await assertWitness(await input.inputValue() === query, 'The live query input lost the typed query');
        observations.push({ query, status, foundPages, expectedPages, pass });
    }
    await page.evaluate(async () => { await document.fonts.ready; });
    await page.screenshot({ path: resolve(out, 'text-find.png') });
    result.traffic = await page.evaluate(start => window.__findTraffic.slice(start), trafficStart);
    result.canonicalRequests = await page.evaluate(() => window.__findTraffic.filter(request => request.canonical));
    result.duplicateCanonicalPages = result.canonicalRequests.filter((request, i, all) => all.findIndex(other => other.page === request.page) !== i).map(request => request.page);
    if (mode === 'dev' && !corrupt && !hide) {
        const allocations = await page.evaluate(() => window.__findAllocations);
        await assertWitness(allocations.encodes === manifest.pages * 2 && allocations.arrays === manifest.pages * 2, 'Dev index allocation witness did not see exactly one key/canonical pair and two compact maps per page');
        result.indexAllocation = { ...allocations, accountedBytes: allocations.utf8Bytes + allocations.mapBytes + manifest.pages * 64,
            scope: 'Single cold document, no eviction/hide; exact retained UTF-8/compact arrays plus the engine 64-byte per-page record allowance, not JS heap overhead.' };
    }
    const lastHit = page.locator('.pdf-reading-results li button').last();
    const targetPage = Number(/^Page (\d+)/u.exec(await lastHit.textContent())?.[1]);
    await lastHit.click();
    await page.waitForFunction(number => document.querySelector('input[aria-label="Physical page"]')?.value === String(number), targetPage);
    await assertWitness(Number.isInteger(targetPage) && targetPage > 0 && await page.getByRole('textbox', { name: 'Physical page', exact: true }).inputValue() === String(targetPage), 'The live result click did not reveal its physical page');
    result.reveal = { targetPage, body: (await page.locator(`[data-pdf-text-page="${targetPage - 1}"]`).textContent()).slice(0, 400) };
    result.pageSamples = [];
    for (const number of corrupt || textbook || cap ? [] : [3, 4, 12, 13, 15]) {
        const jump = page.getByRole('textbox', { name: 'Physical page', exact: true });
        await jump.fill(String(number)); await jump.press('Enter');
        const body = page.locator(`[data-pdf-text-page="${number - 1}"]`); await body.waitFor();
        result.pageSamples.push({ page: number, text: await body.textContent() });
    }
    await assertWitness((!refine || result.refine) && (!hide || result.hide), 'A requested lifecycle arm did not execute');
    await assertWitness(observations.length === queries.length && observations.length > 0, 'A required query arm did not execute');
    result.domWitness = await page.locator('.pdf-reading-results').textContent();
    const served = await binding.check();
    await assertWitness(served.modules.some(item => item.path.includes('pdf.worker') && item.path.endsWith('.mjs')) && served.modules.some(item => item.path.endsWith('.css')), 'Missing required fetched PDF-worker/style identity');
    if (mode === 'production') await assertWitness(served.modules.some(item => item.path.includes('PdfPane') && item.path.endsWith('.js')), 'PDF lazy chunk was not fetched');
    const finalBytes = await readWitness(page, { name: 'Find corpus vault', path: manifest.file, binary: true, report: { data: result } });
    await binding.check();
    await assertWitness(createHash('sha256').update(finalBytes).digest('hex') === sha256, 'Find modified the PDF bytes');
    result.pass = observations.every(item => item.pass) && errors.length === 0 && (hide || result.duplicateCanonicalPages.length === 0);
    await assertWitness(result.pass, 'Find corpus mismatch; see results.json');
} catch (error) {
    result.pass = false; result.failure = String(error); process.exitCode = 1;
    result.warnings = page ? await page.locator('.pdf-reading-warning').allTextContents().catch(() => []) : [];
    if (page) await page.screenshot({ path: resolve(out, 'failure.png') }).catch(() => {});
}
finally {
    try { if (binding) await binding.check(); } catch (error) { result.artifactFailure = String(error); result.pass = false; process.exitCode = 1; }
    try { if (binding) await binding.stop(); }
    finally {
        try { if (browser) await browser.close(); }
        finally { if (app) await app.stop(); }
    }
    await writeFile(resolve(out, 'results.json'), JSON.stringify(result, null, 2) + '\n');
}
console.log(JSON.stringify({ pass: result.pass, failure: result.failure, errors, queries: observations.length, results: resolve(out, 'results.json') }, null, 2));
