// Browser gate: the real app's picker, tree, typed note, search and painted pixels.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const [url, fixtureDir, outDir, identityFile, mode] = process.argv.slice(2);
if (process.argv.length !== 7 || !url || !fixtureDir || !outDir || !identityFile || !['generated', 'local'].includes(mode)) throw new Error('Usage: node view-codecs.mjs <built-app-url> <generated-fixture-dir> <result-dir> <artifact-identity.json> <generated|local>');
const origin = new URL(url);
if (origin.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(origin.hostname) || !origin.pathname.endsWith('/') || origin.search || origin.hash || origin.username) throw new Error('Expected a loopback production URL ending in /');
const dpr = Number(process.env.DPR || 1), theme = process.env.THEME || 'dark';
if (![1, 2].includes(dpr) || !['light', 'dark'].includes(theme)) throw new Error('DPR must be 1 or 2; THEME must be light or dark');
const identity = JSON.parse(await readFile(identityFile, 'utf8'));
if (identity.schema !== 1 || !/^[a-f0-9]{40}$/.test(identity.commit) || !identity.files?.['index.html'] || !Object.keys(identity.sourceFiles || {}).length || ![null, 'missing-wasm'].includes(identity.mutant)) throw new Error('Missing/invalid expected production artifact identity');
const pin = JSON.parse(await readFile(new URL('../../browser-pin.json', import.meta.url), 'utf8'));
const driverVersion = JSON.parse(await readFile(new URL('../../../node_modules/playwright/package.json', import.meta.url), 'utf8')).version;
if (`playwright@${driverVersion}` !== pin.driver) throw new Error('Driver does not match the run pin');
const executablePath = process.env.CHROME_PATH || `/Users/adham/Developer/bme-impl/scratch/browsers/${pin.version}/${pin.executable}`;
const oracleBytes = await readFile(resolve(fixtureDir, 'codecs-minimal.oracle.json'));
const generated = JSON.parse(oracleBytes.toString('utf8'));
const manifest = JSON.parse(await readFile(new URL('../../fixtures/pdf/manifest.json', import.meta.url), 'utf8'));
const oracleIdentity = manifest.fixtures.find(f => f.file === 'codecs-minimal.oracle.json');
if (oracleIdentity?.sha256 !== createHash('sha256').update(oracleBytes).digest('hex') || oracleIdentity.bytes !== oracleBytes.length) throw new Error('Independent oracle identity mismatch');
const fixtures = generated.fixtures.map(f => ({ ...f, path: resolve(fixtureDir, f.file), provenance: 'authored GEN-09 slice; licence NOASSERTION, proposed CC0-1.0' }));
for (const fixture of fixtures) {
    const entry = manifest.fixtures.find(f => f.id === fixture.id);
    if (!entry || entry.sha256 !== fixture.sha256) throw new Error(`Committed fixture identity mismatch: ${fixture.file}`);
}
if (mode === 'local') {
    const source = '/Users/adham/Developer/browserMarkdownEditor/planning/00-evidence/pdf/offscreen/downloads/upstream-fixtures';
    for (const [file, sha256] of [
        ['jbig2_symbol_offset.pdf', '305b71c67829ef0bb8bddab9fa3ee763dcecd173f5fd996740d17212888fa97d'],
        ['jbig2_file_header.pdf', '5edb6045fc86ee5fa8e837685a35a57014764d1f72518e136e5e8f13fcf92c8d'],
        ['ccitt_EndOfBlock_false.pdf', 'f2289b94e7e3f05f9e37754c399d3f525edf9444fb32c3279959cf64b575fe62'],
    ]) fixtures.push({ file, sha256, path: resolve(source, file), provenance: 'rights-unverified local witness', expected: {} });
}
if (mode === 'local') {
    if (!process.env.LOCAL_JPX_WITNESS) throw new Error('Local arm requires the approved positive JPX witness metadata path');
    fixtures.push(JSON.parse(await readFile(process.env.LOCAL_JPX_WITNESS, 'utf8')));
}
if (fixtures.length !== (mode === 'local' ? 8 : 4) || new Set(fixtures.map(f => f.file)).size !== fixtures.length) throw new Error('Required fixture arms are missing/duplicated');
await mkdir(outDir, { recursive: true });
const sha = data => createHash('sha256').update(data).digest('hex');
const report = {
    gate: 'P-02a assets/View slice', build: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceDiff: sha(execFileSync('git', ['diff', 'HEAD'])), driver: pin.driver, browser: null, url,
    mode, theme, dpr, applicationIdentity: { commit: identity.commit, mutant: identity.mutant, sha256: sha(await readFile(identityFile)) }, cases: [], notCovered: [
        'Annotate/thumbnail/closed-file agent surfaces (seam/integration follow-up)',
        'Independent local JBIG2 reference crops and CJK glyph-outline oracle; ink alone is not full fidelity',
        'bug_jpx has an out-of-bounds decoder failure even with assets: P-02b must show the page notice',
        'ICC/standard fonts/large image corpus; D2-G2/G3/G4 fault/retry; fresh/warm vault switching',
        'JPX/JBIG2 encoder pin and exact negative constructions remain outside committed GEN-09 slice',
    ],
};
const pdfResource = value => /\/pdfjs-runtime\/|\/[^/]*(?:pdf|Pdf)[^/]*\.(?:js|mjs|wasm|css)(?:\?|$)/.test(value);
async function session() {
    const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: dpr });
    const page = await context.newPage();
    const network = [], responses = [], pending = [], consoleMessages = [], errors = [];
    page.on('request', r => network.push(r.url()));
    page.on('response', r => {
        if (new URL(r.url()).origin !== origin.origin) return;
        pending.push(r.body().then(body => {
            const path = decodeURIComponent(new URL(r.url()).pathname.slice(origin.pathname.length)) || 'index.html';
            const expected = identity.files[path];
            const actual = { url: r.url(), file: path, status: r.status(), sha256: sha(body), bytes: body.length, contentType: r.headers()['content-type'] };
            actual.matchesExpected = !!expected && expected.sha256 === actual.sha256 && expected.bytes === actual.bytes && actual.status === 200;
            responses.push(actual);
        }).catch(error => responses.push({ url: r.url(), error: String(error), matchesExpected: false })));
    });
    page.on('console', m => consoleMessages.push({ type: m.type(), text: m.text() }));
    page.on('pageerror', e => errors.push(String(e)));
    // The run is offline apart from its own static origin. Attempted off-origin
    // traffic is still counted, never hidden by the abort.
    await context.route('**/*', route => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
    await page.addInitScript(({ theme }) => {
        localStorage.setItem('theme', theme);
        window.__codecAction = 'not-opened';
        const grant = h => { h.queryPermission = h.requestPermission = async () => 'granted'; return h; };
        const getDirectory = FileSystemDirectoryHandle.prototype.getDirectoryHandle;
        FileSystemDirectoryHandle.prototype.getDirectoryHandle = async function (...args) { return grant(await getDirectory.apply(this, args)); };
        window.showDirectoryPicker = async () => grant(await (await navigator.storage.getDirectory()).getDirectoryHandle('codec-fixtures', { create: true }));
        window.__codecMessages = [];
        const NativeWorker = window.Worker;
        window.Worker = class extends NativeWorker {
            constructor(...args) {
                super(...args);
                this.addEventListener('message', e => {
                    const m = e.data;
                    if (['ready', 'test', 'obj', 'commonobj'].includes(m?.action)) window.__codecMessages.push({ action: m.action, target: m.targetName, data: ['ready', 'test'].includes(m.action) ? m.data : Array.isArray(m.data) ? m.data.map(v => v === null || ['string', 'number'].includes(typeof v) ? v : typeof v) : typeof m.data });
                });
            }
            postMessage(message, ...rest) {
                if (message?.action === 'GetDocRequest') window.__codecMessages.push({ action: 'GetDocRequest', version: message.data?.apiVersion });
                return super.postMessage(message, ...rest);
            }
        };
        const drawImage = CanvasRenderingContext2D.prototype.drawImage;
        CanvasRenderingContext2D.prototype.drawImage = function (...args) { this.canvas.__lastBlit = performance.now(); this.canvas.__codecAction = window.__codecAction; return drawImage.apply(this, args); };
    }, { theme });
    await page.goto(url);
    await page.waitForFunction(theme => theme === 'light' ? document.documentElement.dataset.theme === 'light' : document.documentElement.dataset.theme !== 'light', theme);
    return { context, page, network, responses, pending, consoleMessages, errors };
}
async function seed(page, name, bytes) {
    await page.evaluate(async ({ name, data }) => {
        const vault = await (await navigator.storage.getDirectory()).getDirectoryHandle('codec-fixtures', { create: true });
        const file = await vault.getFileHandle(name, { create: true });
        const writable = await file.createWritable();
        await writable.write(new Uint8Array(data));
        await writable.close();
    }, { name, data: [...bytes] });
    await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
}
async function collect(s, requirePdf) {
    await s.page.waitForLoadState('networkidle');
    let drained = 0;
    while (drained < s.pending.length) {
        const batch = s.pending.slice(drained);
        drained = s.pending.length;
        await Promise.all(batch);
    }
    if (!s.responses.length || s.responses.some(r => !r.matchesExpected)) throw new Error('A served artifact body is missing or differs from the expected build bytes');
    const entry = new URL(identity.entryScript, url).href;
    if (!s.responses.some(r => r.url === entry && r.matchesExpected)) throw new Error('Expected application entry was not served');
    if (requirePdf && !s.responses.some(r => /pdf\.worker.*\.mjs$/.test(r.file) && r.matchesExpected)) throw new Error('Expected native PDF worker body is missing');
}
const browser = await chromium.launch({ headless: true, executablePath });
try {
    report.browser = browser.version();
    if (report.browser !== pin.version) throw new Error('Browser does not match the run pin');
    // X-LAZY negative control: a real editable/searchable Markdown-only vault,
    // held beyond the app's 4 s idle-prefetch deadline plus a 1 s margin.
    const baseline = await session();
    await seed(baseline.page, 'note.md', Buffer.from('# Codec network baseline\n\nA searchable note.\n'));
    await baseline.page.locator('.tree-item').filter({ hasText: 'note' }).first().click();
    await baseline.page.locator('.cm-content').waitFor({ state: 'visible' });
    await baseline.page.keyboard.press('Meta+e');
    await baseline.page.waitForFunction(() => document.querySelector('.cm-content')?.getAttribute('contenteditable') === 'true');
    await baseline.page.locator('.cm-content').click();
    await baseline.page.keyboard.press('Control+End');
    await baseline.page.keyboard.type(' lazy-network-sentinel');
    await baseline.page.waitForFunction(() => document.querySelector('.cm-content')?.textContent.includes('lazy-network-sentinel'));
    await baseline.page.getByRole('button', { name: 'Search', exact: true }).click();
    await baseline.page.getByRole('textbox', { name: 'Search vault', exact: true }).fill('searchable');
    await baseline.page.waitForTimeout(5000);
    await collect(baseline, false);
    const baselineOffOrigin = baseline.network.filter(u => new URL(u).origin !== origin.origin);
    if (baselineOffOrigin.some(u => !u.startsWith('https://fonts.googleapis.com/') && !u.startsWith('https://fonts.gstatic.com/'))) throw new Error('Unapproved off-origin request in the baseline');
    report.markdown = { network: baseline.network, responses: baseline.responses, errors: baseline.errors, pdfRequests: baseline.network.filter(pdfResource), baselineOffOrigin, waitedMs: 5000, executed: 1 };
    await baseline.page.screenshot({ path: resolve(outDir, 'markdown-baseline.png') });
    await baseline.context.close();
    for (const fixture of fixtures) {
        const bytes = await readFile(fixture.path);
        const sha256 = sha(bytes);
        if (sha256 !== fixture.sha256) throw new Error(`Fixture identity mismatch: ${fixture.file}`);
        const s = await session();
        const { context, page, network, responses, consoleMessages, errors } = s;
        await seed(page, fixture.file, bytes);
        const action = `open:${fixture.sha256}`;
        await page.evaluate(action => { window.__codecAction = action; }, action);
        await page.locator('.tree-item').filter({ hasText: fixture.file }).first().click();
        await page.waitForFunction(action => [...document.querySelectorAll('.pdf-viewer-page > canvas')].some(c => c.width > 0 && c.__codecAction === action && c.__lastBlit && performance.now() - c.__lastBlit > 500), action, { timeout: 20000 });
        const pixels = await page.locator('.pdf-viewer-page > canvas').first().evaluate((c, expected) => {
            const rgba = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            const dark = (x, y) => Math.min(...rgba.slice((y * c.width + x) * 4, (y * c.width + x) * 4 + 3)) < 128;
            let ink = 0;
            for (let i = 0; i < rgba.length; i += 4) if (Math.min(rgba[i], rgba[i + 1], rgba[i + 2]) < 240) ink++;
            const sample = (x, y) => dark(Math.min(c.width - 1, Math.floor(x / 256 * c.width)), Math.min(c.height - 1, Math.floor(y / 256 * c.height)));
            const landmarks = [];
            if (expected.codec === 'CCITT G4') {
                for (const y of [32, 96, 160, 224]) landmarks.push(!sample(64, y), sample(192, y));
            } else if (expected.checker) {
                for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) landmarks.push(sample(16 + (x + 0.5) * 56, 16 + (y + 0.5) * 56) === ((x + y) % 2 === 1));
            }
            return { width: c.width, height: c.height, ink, ratio: ink / (c.width * c.height), completedBlit: !!c.__lastBlit, landmarks };
        }, fixture.expected);
        const messages = await page.evaluate(() => window.__codecMessages);
        const notices = await page.locator('[role="alert"], .pdf-pane-message').allTextContents();
        await page.screenshot({ path: resolve(outDir, `${fixture.file}.png`) });
        await collect(s, true);
        const warnings = consoleMessages.filter(m => /decode|wasmUrl|OpenJPEG|jbig2|CMap/i.test(m.text));
        const additionalOffOrigin = network.filter(u => new URL(u).origin !== new URL(url).origin && !baselineOffOrigin.includes(u));
        const blank = fixture.expected.blank === true;
        const pass = (blank ? pixels.ink === 0 : pixels.ink > 0) && pixels.landmarks.every(Boolean) && warnings.length === 0 && errors.length === 0 && notices.length === 0 && additionalOffOrigin.length === 0;
        report.cases.push({ file: fixture.file, sha256, provenance: fixture.provenance, encoder: fixture.encoder, action, executed: 1, pixels, messages, warnings, errors, notices, network, responses, additionalOffOrigin, pass });
        await context.close();
    }
    if (report.markdown.executed !== 1 || report.cases.length !== fixtures.length || report.cases.some(c => c.executed !== 1)) throw new Error('A required named arm did not execute exactly once');
    report.positiveControl = report.cases.some(c => c.responses.some(r => /\/wasm\/.*\.wasm$/.test(r.file) && r.matchesExpected) && c.pixels.ink > 0 && c.pass);
    report.namedMutantFailure = identity.mutant === 'missing-wasm' && report.cases.some(c => c.pixels.completedBlit && c.pixels.ink === 0 && c.warnings.some(w => /wasmUrl/.test(w.text)) && !c.pass);
} catch (error) {
    report.failure = String(error);
    for (const [i, context] of browser.contexts().entries()) for (const [j, page] of context.pages().entries()) {
        await page.screenshot({ path: resolve(outDir, `failure-${i}-${j}.png`) }).catch(() => {});
        await writeFile(resolve(outDir, `failure-${i}-${j}.txt`), await page.locator('body').innerText().catch(() => 'page unavailable'));
    }
    throw error;
} finally {
    await browser.close();
    await writeFile(resolve(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify({ markdownPdfRequests: report.markdown?.pdfRequests, positiveControl: report.positiveControl, cases: report.cases.map(c => ({ file: c.file, ink: c.pixels.ink, landmarks: c.pixels.landmarks, warnings: c.warnings.length, pass: c.pass })) }, null, 2));
if (report.cases.some(c => !c.pass) || report.markdown.pdfRequests.length || report.markdown.errors.length || !report.positiveControl) process.exitCode = 1;
if (identity.mutant === 'missing-wasm' && !report.namedMutantFailure) throw new Error('The mutant was not killed by the named completed-white-blit/missing-wasm arm; setup failure is not a kill');
