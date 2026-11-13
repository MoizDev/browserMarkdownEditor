// D1-G2, initial equivalent-re-ask witness. The transition matrix is added before
// package acceptance; this run makes no timing claim and never calls app code.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { ROOT, argumentsOf, portNumber, toolbox, sha256, attributeCanvases, canvasFingerprint } from './common.mjs';
import { installPdfObservations, snapshotPdf, releaseForCleanup } from './observe.mjs';

const options = argumentsOf(process.argv.slice(2), ['prepared', 'fixture', 'scratch', 'toolbox', 'port', 'phase'], ['prepared', 'fixture', 'scratch', 'toolbox']);
const phases = options.phase === undefined || options.phase === 'all' ? ['page', 'bind', 'render', 'verify'] : [options.phase];
if (phases.some(phase => !['page', 'bind', 'render', 'verify'].includes(phase))) throw new Error('Unknown hold phase');
const prepared = JSON.parse(await readFile(resolve(options.prepared)));
if (prepared.variant !== 'holds' || !prepared.identity.patchSha256 || prepared.identity.commit !== prepared.base) throw new Error('D1-G2 requires the prepared, identified hold build');
const fixturePath = resolve(options.fixture), fixture = await readFile(fixturePath);
const oracle = JSON.parse(await readFile(fixturePath.replace(/\.pdf$/u, '.expected.json')));
const manifest = JSON.parse(await readFile(join(ROOT, 'verify/fixtures/pdf/manifest.json')));
if (oracle.pages !== 1 || oracle.sha256 !== sha256(fixture) || !manifest.fixtures.some(row => row.id === oracle.id && row.sha256 === oracle.sha256)) throw new Error('Use the admitted one-page fixture for unambiguous outside per-page counters');
const scratch = resolve(options.scratch), port = portNumber(options.port), tools = await toolbox(options.toolbox);
await mkdir(scratch, { recursive: true });
const report = await tools.createReport({ scratch, name: 'D1-G2-equivalent', fixtures: { 'fixture.pdf': fixture },
    gate: 'D1-G2', coverage: 'Equivalent re-asks at the four named holds; transition matrix still pending',
    sourceIdentity: prepared.identity, holdSource: prepared.source, toolbox: tools.metadata, cases: [],
    loss: 'Functional source-map attribution and API counters; not a timing run. Main-window canvases only; no worker heap introspection.' });
let browser, server;
const bindings = [];
let failed = false;
try {
    const pin = JSON.parse(await readFile(join(ROOT, 'verify/browser-pin.json')));
    const driver = createRequire(import.meta.url)('playwright/package.json').version;
    if (`playwright@${driver}` !== pin.driver) throw new Error('Unpinned driver');
    browser = await chromium.launch({ headless: true, executablePath: process.env.BME_CHROME_PATH ?? join('/Users/adham/Developer/bme-impl/scratch/browsers', pin.version, pin.executable) });
    if (browser.version() !== pin.version) throw new Error('Unpinned browser');
    report.data.browser = { version: browser.version(), driver, viewport: { width: 1440, height: 900 }, dpr: 2, reloadArm: 'native-pinned-chrome' };
    server = await tools.serveApp({ root: prepared.root, scratch: prepared.scratch, port, mode: prepared.mode, build: false });
    const origin = new URL(server.url).origin;
    for (const phase of phases) {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: 'en-US', colorScheme: 'dark' });
        let page, binding;
        const row = { phase, transition: 'equivalent-reasks', passed: false, pageErrors: [] };
        report.data.cases.push(row);
        try {
            await tools.installVault(context, { name: 'D1-vault' });
            await tools.installCounters(context, { vaultName: 'D1-vault' });
            await installPdfObservations(context);
            const bindingReport = { data: {} };
            binding = await tools.bindServedBodies(context, { identity: prepared.identity, origin, mode: 'raw-route', buildMode: 'production', report: bindingReport,
                blockExternalOrigins: ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'] });
            bindings.push(binding);
            const check = async (label, expected, actual) => { row.servedBinding = await binding.check(); report.assert(`${phase}/${label}`, expected, actual); };
            page = await context.newPage();
            page.on('pageerror', error => row.pageErrors.push(String(error)));
            await page.goto(server.url);
            await tools.seedVault(page, { name: 'D1-vault', files: { 'fixture.pdf': fixture, 'note.md': '# Visible note\n\nA calm window keeps every mark readable.\n' } });
            await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
            await page.locator('.tree-item').filter({ hasText: 'fixture.pdf' }).first().click();
            await page.waitForFunction(() => document.querySelector('.pdf-viewer-page canvas')?.dataset.nativeEmphasis === 'false');
            await page.evaluate(() => document.fonts.ready);
            const warm = await canvasFingerprint(page);
            await check('warm page has glyph ink', true, warm.painted);
            const warmOutside = await attributeCanvases(await snapshotPdf(page), prepared, origin);
            await check('work callsite is positively observed', true, warmOutside.canvases.some(canvas => canvas.attribution.role === 'work'));
            await check('worker operator-list request is observed', true, warmOutside.events.some(event => event.op === 'workerMessage' && event.direction === 'out' && event.action === 'GetOperatorList' && event.pageIndex === 0));
            await check('PDF pane body is bound', true, row.servedBinding.modules.some(module => /\/PdfPane-[^/]+\.js$/u.test(module.path)));
            await check('PDF worker module body is bound', true, row.servedBinding.modules.some(module => /\/pdf\.worker[^/]+\.mjs$/u.test(module.path)));
            await page.evaluate(() => { window.__d1TextSentinel = document.querySelector('.pdf-viewer-page .textLayer span'); });
            const mark = await page.evaluate(phase => window.__d1Outside.arm(phase, 0).sequence, phase);
            row.mark = mark;
            await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
            await page.waitForFunction(() => window.__d1Outside.snapshot().hold?.arrivals > 0);
            row.held = await snapshotPdf(page);
            await check('named hold fired', true, row.held.hold.arrivals >= 1 && !row.held.hold.released);
            const scroll = page.locator('.pdf-viewer-scroll'), rectangle = await scroll.boundingBox();
            await page.mouse.move(rectangle.x + rectangle.width / 2, rectangle.y + rectangle.height / 2);
            let moved = 0;
            const positions = [];
            for (let n = 0; n < 60; n++) {
                const before = await scroll.evaluate(element => element.scrollTop);
                await page.mouse.wheel(0, n % 2 ? -1 : 1);
                await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
                const after = await scroll.evaluate(element => element.scrollTop);
                positions.push(after);
                if (after !== before) moved++;
            }
            row.scrollPositions = positions;
            await check('all 60 asks are real scrolls', 60, moved);
            const held = await attributeCanvases(await snapshotPdf(page), prepared, origin);
            const heldWorks = held.canvases.filter(canvas => canvas.firstSequence > mark && canvas.attribution.role === 'work');
            row.heldWorkCanvases = heldWorks;
            // Bind/page holds can precede canvas allocation. A render/verify
            // hold must already own exactly one work canvas in this one-page UI.
            await check('held work is bounded', true, heldWorks.length <= 1);
            await page.evaluate(() => window.__d1Outside.release());
            await page.waitForFunction(mark => window.__d1Outside.snapshot().events.some(event => event.sequence > mark && event.op === 'displayBlit' && event.page === 0), mark);
            await page.waitForFunction(() => {
                const canvas = document.querySelector('.pdf-viewer-page canvas'), r = canvas?.getBoundingClientRect();
                return r?.width > 0 && Math.abs(canvas.width / r.width - devicePixelRatio) < 0.01;
            });
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            const after = await attributeCanvases(await snapshotPdf(page), prepared, origin);
            row.after = after;
            const work = after.canvases.filter(canvas => canvas.firstSequence > mark && canvas.attribution.role === 'work');
            const blits = after.events.filter(event => event.sequence > mark && event.op === 'displayBlit' && event.page === 0);
            row.finalPixels = await canvasFingerprint(page);
            await check('final current-density glyph pixels', true, row.finalPixels.painted && row.finalPixels.visibility === 'visible');
            await check('native text DOM survived a paint change', true, await page.evaluate(() => window.__d1TextSentinel === document.querySelector('.pdf-viewer-page .textLayer span')));
            const managedIds = new Set(after.canvases.filter(canvas => ['work', 'probe'].includes(canvas.attribution.role)).map(canvas => canvas.id));
            row.maxActiveDrawingRoots = Math.max(0, ...after.events.filter(event => event.sequence > mark && event.live).map(event => event.live.filter(canvas => managedIds.has(canvas.id) && canvas.width * canvas.height > 0 && canvas.depth > 0).length));
            await check('one managed drawing root at a time', 1, row.maxActiveDrawingRoots);
            await check('one displayed completion', 1, blits.length);
            // This is the named failing witness on d53ae0a: the first completed
            // target was discarded and a second full work canvas was allocated.
            await check('equivalent requests keep one render work canvas', 1, work.length);
            await check('all render work backing was released', 0, work.reduce((bytes, canvas) => bytes + canvas.width * canvas.height * 4, 0));
            await page.getByRole('button', { name: 'Close fixture.pdf', exact: true }).click();
            await page.waitForFunction(() => document.querySelectorAll('.pdf-pane').length === 0);
            await page.waitForFunction(ids => window.__d1Outside.snapshot().canvases.filter(canvas => ids.includes(canvas.id)).every(canvas => canvas.width * canvas.height === 0), [...managedIds]);
            row.afterClose = await attributeCanvases(await snapshotPdf(page), prepared, origin);
            await check('teardown has no render/probe backing', 0, row.afterClose.canvases.filter(canvas => ['work', 'probe'].includes(canvas.attribution.role)).reduce((bytes, canvas) => bytes + canvas.width * canvas.height * 4, 0));
            await check('no page errors', [], row.pageErrors);
            row.passed = true;
        } catch (error) {
            failed = true;
            let failure = error;
            if (binding) {
                try { row.servedBinding = await binding.check(); }
                catch (fault) { failure = fault; }
            }
            row.error = { name: failure.name, message: failure.message };
            report.fail(failure);
            if (page && !page.isClosed()) await page.screenshot({ path: join(scratch, `${phase}-failure.png`), animations: 'disabled' }).catch(() => {});
        } finally {
            if (page && !page.isClosed()) await releaseForCleanup(page);
            if (binding) await binding.stop();
            await context.close();
        }
    }
    await Promise.all(bindings.map(binding => binding.check()));
    report.assert('all requested named arms executed', phases, report.data.cases.map(row => row.phase));
} catch (error) { failed = true; report.fail(error); }
finally {
    await browser?.close();
    await server?.stop();
    const path = await report.finish();
    await writeFile(join(scratch, 'latest-report.json'), JSON.stringify({ report: path, passed: report.data.passed }, null, 2) + '\n');
    console.log(JSON.stringify({ report: path, passed: report.data.passed }));
}
if (failed) process.exitCode = 1;
