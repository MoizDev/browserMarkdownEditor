// P-00 functional baseline: real production app, user gestures, named OPFS vault.
// No app module imports or calls. Generated expected records are authored inputs,
// never reconstructed from pdf.js output. Run under bme-lock run (HOWTO.md).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';

const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
    if (!process.argv[i].startsWith('--') || process.argv[i + 1] === undefined) throw new Error('Every option needs a value');
    const key = process.argv[i].slice(2);
    if (!['dist', 'corpus', 'out', 'chrome', 'app-commit', 'port', 'dpr', 'only', 'mutant'].includes(key) || options[key] !== undefined) throw new Error(`Unknown or repeated option: ${key}`);
    options[key] = process.argv[i + 1];
}
if (options.dpr && !['1', '2', '1,2'].includes(options.dpr)) throw new Error('DPR must be 1, 2, or 1,2');
if (options.mutant && options.mutant !== 'pdf-pane-boot-throw') throw new Error('Unknown mutant');
for (const key of ['dist', 'corpus', 'out', 'chrome', 'app-commit']) if (!options[key]) throw new Error(`Missing --${key}`);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const appCommit = git('rev-parse', options['app-commit']);
const planningBase = git('rev-parse', 'b10d0d3');
const srcTree = git('rev-parse', `${appCommit}:src`);
if (srcTree !== git('rev-parse', `${planningBase}:src`)) throw new Error('Step-zero source no longer equals the planning base');
const dist = resolve(options.dist), corpus = resolve(options.corpus), out = resolve(options.out);
await mkdir(out, { recursive: true });
const port = Number(options.port ?? 6380);
if (port < 6380 || port > 6399) throw new Error('Outside p-a port allocation');
const origin = `http://localhost:${port}`;
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.pdf': 'application/pdf' };
let mutantFired = false;
const server = createServer(async (request, response) => {
    try {
        const url = new URL(request.url, origin);
        const fixture = url.pathname.startsWith('/__fixture/');
        const root = fixture ? corpus : dist;
        const name = fixture ? url.pathname.slice('/__fixture/'.length) : url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const path = resolve(root, decodeURIComponent(name));
        if (!path.startsWith(root + sep)) { response.writeHead(403).end(); return; }
        let bytes = await readFile(path);
        if (options.mutant === 'pdf-pane-boot-throw' && /\/PdfPane-[^/]+\.js$/u.test(path)) {
            mutantFired = true;
            bytes = Buffer.from('throw new Error("P00 MUTANT: PDF pane chunk did not boot");');
        }
        response.writeHead(200, { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }).end(bytes);
    } catch { response.writeHead(404).end(); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, 'localhost', resolve); });
let browser, lastPage;
const diagnostics = [];
try {
    const driverPackage = createRequire(import.meta.url)('playwright/package.json');
    if (driverPackage.version !== '1.63.0') throw new Error(`Driver is ${driverPackage.version}, not 1.63.0`);
    browser = await chromium.launch({ headless: true, executablePath: options.chrome });
    if (browser.version() !== '157.0.8103.39') throw new Error(`Unpinned browser: ${browser.version()}`);
    const results = [], screenshotHashes = [], networks = [];
    const manifest = JSON.parse(await readFile(new URL('../../fixtures/pdf/manifest.json', import.meta.url)));
    const names = (options.only ? options.only.split(',') : ['authored-paper-15', 'unique-textbook-876', 'unique-textbook-1000', 'repeated-quotes-anchors']);
    if (!names.length || new Set(names).size !== names.length || names.some(name => !manifest.fixtures.some(entry => entry.file === `${name}.pdf`))) throw new Error('Unknown, empty or repeated fixture arm');
    for (const dpr of (options.dpr ?? '1,2').split(',').map(Number)) {
        for (const name of names) {
            console.log(`Capture ${name}, DPR ${dpr}`);
            const oracleBytes = await readFile(resolve(corpus, `${name}.expected.json`));
            const oracle = JSON.parse(oracleBytes);
            const pdf = await readFile(resolve(corpus, oracle.file));
            const admitted = manifest.fixtures.find(entry => entry.file === oracle.file);
            const admittedOracle = manifest.fixtures.find(entry => entry.file === `${name}.expected.json`);
            if (hash(pdf) !== oracle.sha256 || admitted?.id !== oracle.id || admitted.sha256 !== oracle.sha256 || admittedOracle?.sha256 !== hash(oracleBytes)) throw new Error(`Fixture identity mismatch: ${name}`);
            const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr, locale: 'en-US', colorScheme: 'dark' });
            await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
            const page = await context.newPage(), pageErrors = [], fetched = new Set();
            lastPage = page;
            page.on('pageerror', error => { pageErrors.push(String(error)); diagnostics.push({ kind: 'pageerror', message: String(error) }); });
            page.on('console', message => { if (message.type() === 'error') diagnostics.push({ kind: 'console', message: message.text() }); });
            page.on('response', response => { if (response.url().startsWith(origin)) fetched.add(new URL(response.url()).pathname); });
            await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
            await page.addInitScript(() => {
                const grant = handle => { handle.queryPermission = async () => 'granted'; handle.requestPermission = async () => 'granted'; return handle; };
                const getDirectory = FileSystemDirectoryHandle.prototype.getDirectoryHandle;
                FileSystemDirectoryHandle.prototype.getDirectoryHandle = async function (...args) { return grant(await getDirectory.apply(this, args)); };
                window.showDirectoryPicker = async () => grant(await (await navigator.storage.getDirectory()).getDirectoryHandle('P00-vault', { create: true }));
                // The command's default action is observed after bubbling. Native
                // Chrome's toolbar is outside the headless page; see loss below.
                window.addEventListener('keydown', event => {
                    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
                        const witness = { trusted: event.isTrusted, defaultPrevented: false };
                        window.__p00FindKey = witness;
                        queueMicrotask(() => { witness.defaultPrevented = event.defaultPrevented; });
                    }
                });
            });
            await page.goto(origin);
            const screen = await page.evaluate(() => ({ dpr: devicePixelRatio, width: innerWidth, height: innerHeight, theme: document.documentElement.dataset.theme ?? 'dark' }));
            if (screen.dpr !== dpr || screen.width !== 1440 || screen.height !== 900 || screen.theme !== 'dark') throw new Error(`Unexpected live screen: ${JSON.stringify(screen)}`);
            await page.evaluate(async file => {
                const vault = await (await navigator.storage.getDirectory()).getDirectoryHandle('P00-vault', { create: true });
                const bytes = await (await fetch(`/__fixture/${file}`)).arrayBuffer();
                const writable = await (await vault.getFileHandle(file, { create: true })).createWritable();
                await writable.write(bytes); await writable.close();
            }, oracle.file);
            await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
            await page.locator('.tree-item').filter({ hasText: name }).first().click();
            await page.waitForFunction(count => document.querySelectorAll('.pdf-viewer-page').length === count, oracle.pages);
            await page.waitForFunction(() => document.querySelector('.pdf-viewer-page canvas')?.width > 1 && document.querySelector('.pdf-viewer-page .textLayer span'));
            if (oracle.pages <= 300) await page.waitForFunction(count => [...document.querySelectorAll('.pdf-viewer-page .textLayer')].filter(layer => layer.querySelector('span')).length === count, oracle.pages);
            await page.evaluate(() => document.fonts.ready);
            const record = { fixture: { id: oracle.id, sha256: oracle.sha256, pages: oracle.pages, file: oracle.file },
                identity: { appCommit, planningBase, srcTree, browser: browser.version(), driver: driverPackage.version, driverSource: 'pinned dev dependency', dpr, viewport: { width: 1440, height: 900 }, buildMode: 'production' },
                expectedCorrect: { queries: oracle.expected.queries, gestures: oracle.expected.gestures, selectAll: { length: oracle.expected.correctSelectAllText.length, sha256: hash(oracle.expected.correctSelectAllText), scope: oracle.expected.correctSelectAll } } };
            const geometry = await page.evaluate(() => [...document.querySelectorAll('.pdf-viewer-page')].map(element => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height })));
            record.geometry = { first: geometry[0], last: geometry.at(-1), pageCount: geometry.length, equalBoxes: geometry.every(box => box.width === geometry[0].width && box.height === geometry[0].height), source: oracle.expected.pageModels[0].geometry };
            record.initialInk = await ink(page);
            if (!record.initialInk.darkPixels) throw new Error(`Blank canvas: ${name}`);
            await page.screenshot({ path: resolve(out, `${name}-dpr${dpr}-original.png`), animations: 'disabled' });
            screenshotHashes.push({ fixture: oracle.id, dpr, surface: 'original', sha256: hash(await readFile(resolve(out, `${name}-dpr${dpr}-original.png`))) });
            record.copy = {};
            await jump(page, 1);
            for (const kind of ['title', 'twoLine']) {
                const gesture = oracle.expected.gestures[kind];
                await seedClipboard(page, `${name}-${kind}`);
                await drag(page, { page: gesture.page, point: gesture.from }, { page: gesture.page, point: gesture.to });
                record.copy[kind] = await copied(page, `${name}-${kind}`);
            }
            // Zoom out so both sides of the page boundary fit in one viewport.
            // The native selection drag itself remains pointer input, not Range.
            for (let i = 0; i < 6; i++) await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
            await jump(page, 2);
            await page.mouse.move(800, 450);
            await page.mouse.wheel(0, -200);
            await page.waitForTimeout(400);
            const boundary = oracle.expected.gestures.crossPage;
            await seedClipboard(page, `${name}-cross-page`);
            await drag(page, boundary.from, boundary.to);
            record.copy.crossPage = await copied(page, `${name}-cross-page`);
            if (record.copy.crossPage.selectedPages.length !== 2) throw new Error('Cross-page drag did not select both page bodies');
            await jump(page, 1);
            const box = await page.locator('.pdf-viewer-scroll').boundingBox();
            await page.mouse.click(box.x + 8, box.y + 8);
            await seedClipboard(page, `${name}-select-all`);
            await page.keyboard.press('Meta+a');
            record.copy.selectAll = await copied(page, `${name}-select-all`);
            record.copy.selectAll.classification = record.copy.selectAll.includesChrome ? 'known-bad witness: select-all captured app chrome' : 'PDF-only witness';
            record.originalFind = { method: 'trusted Meta+F routing witness, followed by labelled window.find browser DOM-engine diagnostic (not native toolbar automation)', key: null, before: [], afterVisitingTargets: [] };
            await page.locator('.pdf-viewer-scroll').click({ position: { x: 10, y: 10 } });
            await page.keyboard.press('Meta+f');
            record.originalFind.key = await page.evaluate(() => window.__p00FindKey);
            if (!record.originalFind.key?.trusted || record.originalFind.key.defaultPrevented) throw new Error('Baseline did not leave trusted find to the browser');
            await page.keyboard.press('Escape');
            for (const query of oracle.expected.queries) record.originalFind.before.push(await browserFind(page, query));
            for (const target of oracle.expected.queries.filter(query => query.neverBuiltOnOpen)) {
                await jump(page, target.pages[0]);
                await page.waitForFunction(number => document.querySelectorAll('.pdf-viewer-page')[number - 1].querySelector('.textLayer span'), target.pages[0]);
            }
            if (oracle.expected.queries.some(query => query.neverBuiltOnOpen)) {
                await jump(page, 1);
                for (const query of oracle.expected.queries) record.originalFind.afterVisitingTargets.push(await browserFind(page, query));
            }
            // Text is explicitly opened through the header's action. All find
            // counts below come from the real app form and real result buttons.
            await page.getByRole('button', { name: 'More options', exact: true }).click();
            await page.getByRole('menuitemradio', { name: 'Read extracted text', exact: true }).click();
            await page.waitForSelector('.pdf-reading-copy');
            await page.waitForTimeout(500);
            const targetPage = oracle.pages > 300 ? 450 : 1;
            const physicalPage = page.getByRole('textbox', { name: 'Physical page', exact: true });
            await physicalPage.fill(String(targetPage)); await physicalPage.press('Enter');
            await page.waitForSelector(`.pdf-reading-copy[data-pdf-text-page="${targetPage - 1}"]`);
            // PageDown is natively animated: it produced 9 or 10 real scroll
            // revisions for one identical gesture. A form navigation is a single
            // explicit checkpoint, so the stored baseline is reproducible without
            // erasing revision fields or changing the app's scrolling behavior.
            await page.waitForFunction(number => Object.entries(localStorage).filter(([key]) => key === 'pdfTextViewState').some(([, raw]) => Object.values(JSON.parse(raw)).some(record => record.surface === 'text' && record.textAnchor?.physicalPageIndex === number - 1 && record.textAnchor.offsetUTF16 === 0)), targetPage);
            await page.waitForTimeout(500);
            record.storedText = await page.evaluate(() => {
                const entries = Object.entries(localStorage).filter(([key]) => key.includes('pdfTextViewState'));
                return entries.map(([key, value]) => ({ key, value: JSON.parse(value) }));
            });
            if (!record.storedText.length) throw new Error('No stored schema-1 Text record');
            // Vault ids are generated by the app. Preserve every meaningful byte
            // of the record, but canonicalize that random identifier in map keys.
            record.storedText = record.storedText.map(entry => ({ key: entry.key.replace(/vault:[^:]+:/u, 'vault:<vault-id>:'), value: Object.fromEntries(Object.entries(entry.value).map(([key, value]) => [`<vault-id>\u0000${key.split('\u0000').slice(1).join('\u0000')}`, value])) }));
            for (const entry of record.storedText) for (const value of Object.values(entry.value)) {
                if (value.extractionSchema !== 1 || value.surface !== 'text' || value.textChoice !== 'manual' || !value.textAnchor?.quote) throw new Error('Stored Text record lacks a manual schema-1 anchor');
            }
            await page.screenshot({ path: resolve(out, `${name}-dpr${dpr}-text.png`), animations: 'disabled' });
            screenshotHashes.push({ fixture: oracle.id, dpr, surface: 'text', sha256: hash(await readFile(resolve(out, `${name}-dpr${dpr}-text.png`))) });
            record.textFind = [];
            for (const query of oracle.expected.queries) {
                const input = page.getByRole('textbox', { name: 'Find in extracted PDF text', exact: true });
                await input.fill(query.query);
                await input.press('Enter');
                await page.waitForFunction(count => {
                    const text = document.querySelector('.pdf-reading-results [role=status]')?.textContent ?? '';
                    return text.includes(`${count}/${count} pages searched`);
                }, oracle.pages, { timeout: 180_000 });
                const result = await page.locator('.pdf-reading-results').evaluate(element => ({
                    status: element.querySelector('[role=status]').textContent,
                    matches: [...element.querySelectorAll('li button')].map(button => ({ page: Number(button.textContent.match(/^Page (\d+)/u)[1]), snippet: button.textContent })),
                }));
                if (result.matches.length) {
                    await page.locator('.pdf-reading-results li button').first().click();
                    await page.waitForFunction(number => document.querySelector('.pdf-reading input[aria-label="Physical page"]')?.value === String(number), result.matches[0].page);
                }
                record.textFind.push({ query: query.query, expectedCount: query.count, ...result });
                await page.getByRole('button', { name: 'Close results', exact: true }).click();
            }
            if (record.textFind.length !== oracle.expected.queries.length || Object.keys(record.copy).length !== 4) throw new Error('A required capture arm did not run');
            const sourceHash = await page.evaluate(async file => {
                const vault = await (await navigator.storage.getDirectory()).getDirectoryHandle('P00-vault');
                const bytes = await (await (await vault.getFileHandle(file)).getFile()).arrayBuffer();
                return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
            }, oracle.file);
            if (sourceHash !== oracle.sha256) throw new Error('Display-only capture changed the PDF');
            record.sourceUnchanged = true;
            record.pageErrors = pageErrors;
            if (pageErrors.length) throw new Error(`Page errors: ${pageErrors.join('; ')}`);
            networks.push({ fixture: oracle.id, dpr, fetched: [...fetched].filter(path => !path.startsWith('/__fixture/')).sort() });
            results.push(record);
            await writeFile(resolve(out, 'functional.json'), JSON.stringify({ schema: 1, results, loss: 'Native browser toolbar is not automatable headless: Original find is explicitly a browser DOM-engine diagnostic. No timing, hardware-GPU, external-document, second-host or save-latency claim. Random vault identity alone is canonicalized; Text digests/anchors are unmodified.' }, null, 2) + '\n');
            await writeFile(resolve(out, 'landmarks.json'), JSON.stringify(screenshotHashes, null, 2) + '\n');
            await writeFile(resolve(out, 'network.json'), JSON.stringify(networks, null, 2) + '\n');
            await context.close();
        }
    }
    if (results.length !== names.length * (options.dpr ?? '1,2').split(',').length) throw new Error('A required fixture/DPR arm did not run');
    const assets = (await readdir(resolve(dist, 'assets'))).filter(name => /\.(?:js|mjs|css|wasm)$/u.test(name)).sort();
    await writeFile(resolve(out, 'build-identity.json'), JSON.stringify({ appCommit, planningBase, srcTree, html: hash(await readFile(resolve(dist, 'index.html'))), chunks: await Promise.all(assets.map(async file => ({ file, sha256: hash(await readFile(resolve(dist, 'assets', file))) }))) }, null, 2) + '\n');
} catch (error) {
    if (lastPage && !lastPage.isClosed()) {
        await lastPage.screenshot({ path: resolve(out, 'failure.png') }).catch(() => {});
        diagnostics.push({ kind: 'body', message: await lastPage.locator('body').innerText() });
    }
    await writeFile(resolve(out, 'failure.json'), JSON.stringify({ error: String(error), mutant: options.mutant ?? null, mutantFired, diagnostics }, null, 2) + '\n');
    throw error;
} finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
}

async function ink(page) {
    return page.evaluate(() => {
        const canvas = document.querySelector('.pdf-viewer-page canvas');
        const bytes = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let darkPixels = 0;
        for (let i = 0; i < bytes.length; i += 4) if (bytes[i] < 150 && bytes[i + 1] < 150 && bytes[i + 2] < 150 && bytes[i + 3] > 0) darkPixels++;
        return { width: canvas.width, height: canvas.height, darkPixels };
    });
}
async function jump(page, number) {
    const input = page.locator('.pdf-viewer-page-input');
    await input.fill(String(number)); await input.press('Enter'); await input.press('Tab');
    await page.waitForTimeout(250);
}
async function drag(page, from, to) {
    const points = await page.evaluate(({ from, to }) => [from, to].map((endpoint, index) => {
        const element = document.querySelectorAll('.pdf-viewer-page')[endpoint.page - 1];
        const rect = element.getBoundingClientRect(), scale = rect.width / 612;
        return { x: rect.left + endpoint.point[0] * scale + (index === 0 ? 0.5 : -0.75), y: rect.top + endpoint.point[1] * scale };
    }), { from, to });
    const viewport = page.viewportSize();
    for (const point of points) if (point.y < 70 || point.y >= viewport.height - 20) throw new Error(`Gesture landmark outside viewport: ${JSON.stringify(points)}`);
    // Clearing the preceding native selection and separating gestures fixed an
    // empty second drag in the first capture; neither action invents a Range.
    await page.waitForTimeout(550);
    await page.evaluate(points => {
        window.__p00Gesture = points.map(point => ({ ...point, hitTag: document.elementFromPoint(point.x, point.y)?.tagName, hitText: document.elementFromPoint(point.x, point.y)?.textContent.slice(0, 120) }));
        getSelection().removeAllRanges();
    }, points);
    await page.mouse.move(points[0].x, points[0].y); await page.mouse.down();
    await page.mouse.move(points[1].x, points[1].y, { steps: 18 }); await page.mouse.up();
}
async function seedClipboard(page, label) {
    await page.evaluate(text => navigator.clipboard.writeText(text), `P00 clipboard sentinel ${label}`);
}
async function copied(page, label) {
    const selection = await page.evaluate(() => {
        const selection = getSelection();
        const selectedPages = [...document.querySelectorAll('.pdf-viewer-page')].flatMap((element, index) => element.querySelector('.textLayer span') && selection.containsNode(element.querySelector('.textLayer'), true) ? [index + 1] : []);
        const text = selection.toString();
        const endpointInLayer = node => Boolean(node?.parentElement?.closest('.pdf-viewer-page .textLayer'));
        return { text, selectedPages, rangeCount: selection.rangeCount, collapsed: selection.isCollapsed, endpointsInLayer: endpointInLayer(selection.anchorNode) && endpointInLayer(selection.focusNode), includesChrome: Boolean(selection.anchorNode?.parentElement?.closest('.file-explorer')) || /Open Vault|Word emphasis|Text · extracted from PDF|P00-vault/u.test(text) };
    });
    if (!selection.rangeCount || selection.collapsed || !selection.text.length || (!label.endsWith('select-all') && !selection.endpointsInLayer)) throw new Error(`No selected text for ${label}: ${JSON.stringify(await page.evaluate(() => window.__p00Gesture))}`);
    const sentinel = `P00 clipboard sentinel ${label}`;
    if (await page.evaluate(() => navigator.clipboard.readText()) !== sentinel) throw new Error(`Clipboard sentinel missing before Copy: ${label}`);
    await page.keyboard.press('Meta+c');
    await page.waitForFunction(sentinel => navigator.clipboard.readText().then(text => text !== sentinel), sentinel);
    const text = await page.evaluate(() => navigator.clipboard.readText());
    if (!text) throw new Error(`Empty clipboard for ${label}`);
    const compact = value => ({ text: value, length: value.length, sha256: hash(value) });
    return { selection: compact(selection.text), clipboard: compact(text), selectedPages: selection.selectedPages, rangeCount: selection.rangeCount, noncollapsed: !selection.collapsed, endpointsInLayer: selection.endpointsInLayer, includesChrome: selection.includesChrome, clipboardChanged: true, gesture: label.endsWith('select-all') ? { key: 'Meta+A' } : await page.evaluate(() => window.__p00Gesture) };
}
async function browserFind(page, expected) {
    return page.evaluate(expected => {
        getSelection().removeAllRanges();
        const layersBefore = [...document.querySelectorAll('.pdf-viewer-page')].flatMap((element, index) => element.querySelector('.textLayer span') ? [index + 1] : []);
        const targetBuiltBefore = expected.pages.map(number => layersBefore.includes(number));
        const hits = [], seen = new Set();
        let wrapped = false;
        for (let i = 0; i < 2000; i++) {
            if (!window.find(expected.query, false, false, true)) break;
            const selection = getSelection(), range = selection.getRangeAt(0), parent = range.startContainer.parentElement;
            const element = parent?.closest('.pdf-viewer-page');
            if (!element) throw new Error('Browser find matched app chrome');
            const index = [...document.querySelectorAll('.pdf-viewer-page')].indexOf(element) + 1;
            const layer = element.querySelector('.textLayer'), before = document.createRange();
            before.setStart(layer, 0); before.setEnd(range.startContainer, range.startOffset);
            const offset = before.toString().length, key = `${index}:${offset}`;
            if (seen.has(key)) { wrapped = true; break; }
            seen.add(key);
            const rect = range.getBoundingClientRect();
            hits.push({ page: index, offset, text: selection.toString(), nonzeroRange: rect.width > 0 && rect.height > 0 });
        }
        getSelection().removeAllRanges();
        return { query: expected.query, expectedCount: expected.count, targetBuiltBefore, hits, count: hits.length, wrapped };
    }, expected);
}
