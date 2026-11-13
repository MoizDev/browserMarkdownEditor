// Browser gate, not a module test: only the real app's picker, tree and pixels.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const [url, fixtureDir, outDir] = process.argv.slice(2);
if (!url || !fixtureDir || !outDir) throw new Error('Usage: node view-codecs.mjs <built-app-url> <generated-fixture-dir> <result-dir>');
const driver = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(driver.startsWith('/') ? pathToFileURL(driver).href : driver);
const executablePath = process.env.CHROME_PATH || '/Users/adham/Developer/bme-impl/scratch/browsers/157.0.8103.39/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const generated = JSON.parse(await readFile(resolve(fixtureDir, 'codecs-minimal.oracle.json'), 'utf8'));
const fixtures = generated.fixtures.map(f => ({ ...f, path: resolve(fixtureDir, f.file), provenance: 'CC0-1.0 authored GEN-09 slice' }));
if (process.env.LOCAL_CODEC_WITNESSES) {
    const source = '/Users/adham/Developer/browserMarkdownEditor/planning/00-evidence/pdf/offscreen/downloads/upstream-fixtures';
    for (const [file, sha256] of [
        ['bug_jpx.pdf', '4010d808557a72278368c05518367735ed186cbdd04974b8506275f9ac40f999'],
        ['jbig2_symbol_offset.pdf', '305b71c67829ef0bb8bddab9fa3ee763dcecd173f5fd996740d17212888fa97d'],
        ['jbig2_file_header.pdf', '5edb6045fc86ee5fa8e837685a35a57014764d1f72518e136e5e8f13fcf92c8d'],
        ['ccitt_EndOfBlock_false.pdf', 'f2289b94e7e3f05f9e37754c399d3f525edf9444fb32c3279959cf64b575fe62'],
    ]) fixtures.push({ file, sha256, path: resolve(source, file), provenance: 'rights-unverified local witness', expected: {} });
}
await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath });
const report = { gate: 'D2-G1 View slice', build: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), driver, browser: browser.version(), url, mode: process.env.EXPECT_BROKEN ? 'unfixed witness' : 'fixed', cases: [], notCovered: [
    'Annotate/thumbnail/closed-file agent surfaces', 'independent JPX/JBIG2 reference crops and CJK outline oracle', 'ICC/standard fonts/large image corpus', 'D2-G2/G3/G4/G5/G6 beyond this slice',
] };
try {
    for (const fixture of fixtures) {
        const bytes = await readFile(fixture.path);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        if (sha256 !== fixture.sha256) throw new Error(`Fixture identity mismatch: ${fixture.file}`);
        const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: Number(process.env.DPR || 1) });
        const page = await context.newPage();
        const network = [], consoleMessages = [], errors = [];
        page.on('request', r => network.push(r.url()));
        page.on('console', m => consoleMessages.push({ type: m.type(), text: m.text() }));
        page.on('pageerror', e => errors.push(String(e)));
        await context.route('**/*', route => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
        await page.addInitScript(() => {
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
            };
            const drawImage = CanvasRenderingContext2D.prototype.drawImage;
            CanvasRenderingContext2D.prototype.drawImage = function (...args) { this.canvas.__lastBlit = performance.now(); return drawImage.apply(this, args); };
        });
        await page.goto(url);
        await page.evaluate(async ({ name, data }) => {
            const vault = await (await navigator.storage.getDirectory()).getDirectoryHandle('codec-fixtures', { create: true });
            const file = await vault.getFileHandle(name, { create: true });
            const writable = await file.createWritable();
            await writable.write(new Uint8Array(data));
            await writable.close();
        }, { name: fixture.file, data: [...bytes] });
        await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
        await page.locator('.tree-item').filter({ hasText: fixture.file }).first().click();
        await page.waitForFunction(() => [...document.querySelectorAll('.pdf-viewer-page > canvas')].some(c => c.width > 0 && c.__lastBlit && performance.now() - c.__lastBlit > 500), undefined, { timeout: 20000 });
        const pixels = await page.locator('.pdf-viewer-page > canvas').first().evaluate(c => {
            const rgba = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            let ink = 0;
            for (let i = 0; i < rgba.length; i += 4) if (Math.min(rgba[i], rgba[i + 1], rgba[i + 2]) < 240) ink++;
            return { width: c.width, height: c.height, ink, ratio: ink / (c.width * c.height), completedBlit: !!c.__lastBlit };
        });
        const messages = await page.evaluate(() => window.__codecMessages);
        const notices = await page.locator('[role="alert"], .pdf-pane-message').allTextContents();
        await page.screenshot({ path: resolve(outDir, `${fixture.file}.png`) });
        const warnings = consoleMessages.filter(m => /decode|wasmUrl|OpenJPEG|jbig2|CMap/i.test(m.text));
        const blank = fixture.expected.blank === true;
        const pass = blank ? pixels.ink === 0 && notices.length === 0 : pixels.ink > 0 && warnings.length === 0 && errors.length === 0 && notices.length === 0;
        report.cases.push({ file: fixture.file, sha256, provenance: fixture.provenance, pixels, messages, warnings, errors, notices, network, pass });
        await context.close();
    }
} finally {
    await browser.close();
    await writeFile(resolve(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify(report.cases.map(c => ({ file: c.file, ink: c.pixels.ink, warnings: c.warnings.length, pass: c.pass })), null, 2));
if (!process.env.EXPECT_BROKEN && report.cases.some(c => !c.pass)) process.exitCode = 1;
if (process.env.EXPECT_BROKEN && !report.cases.some(c => !c.pass && c.pixels.ink === 0 && c.warnings.length > 0)) throw new Error('Unfixed blank-decoder witness did not fire');
