// First P-02b witness: real UI, successful codec fetch, a null-image reply,
// completed white paint, and no accessible incomplete-render notice.
import { chromium } from 'playwright';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const [url, identityPath, out] = process.argv.slice(2);
if (process.argv.length !== 5 || !url || !identityPath || !out) throw new Error('Usage: reproduce.mjs <preview-url/> <artifact-identity.json> <fresh-out>');
const origin = new URL(url);
if (origin.protocol !== 'http:' || origin.hostname !== 'localhost' || !origin.pathname.endsWith('/')) throw new Error('Expected loopback production URL');
const identity = JSON.parse(await readFile(identityPath, 'utf8'));
if (!identity.files?.['index.html']) throw new Error('Missing artifact identity');
const pin = JSON.parse(await readFile(new URL('../../browser-pin.json', import.meta.url), 'utf8'));
const file = 'bug_jpx.pdf';
const fixture = await readFile(`/Users/adham/Developer/browserMarkdownEditor/planning/00-evidence/pdf/offscreen/downloads/upstream-fixtures/${file}`);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fixtureSha256 = sha(fixture);
if (fixtureSha256 !== '4010d808557a72278368c05518367735ed186cbdd04974b8506275f9ac40f999') throw new Error('Local witness identity mismatch');
await mkdir(out);
const report = { fixture: { file, sha256: fixtureSha256, provenance: 'rights-unverified local witness' }, applicationCommit: identity.commit, browser: null, bodies: [], messages: [], warnings: [], errors: [] };
const browser = await chromium.launch({ headless: true, executablePath: `/Users/adham/Developer/bme-impl/scratch/browsers/${pin.version}/${pin.executable}` });
try {
    report.browser = browser.version();
    if (report.browser !== pin.version) throw new Error('Wrong browser');
    const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
    const pending = [];
    await context.route('**/*', route => {
        const request = new URL(route.request().url());
        if (request.origin !== origin.origin) return route.abort();
        const operation = (async () => {
            try {
                const response = await route.fetch();
                const body = await response.body();
                const file = decodeURIComponent(request.pathname.slice(origin.pathname.length)) || 'index.html';
                const expected = identity.files[file];
                report.bodies.push({ file, sha256: sha(body), bytes: body.length, matches: !!expected && expected.sha256 === sha(body) && expected.bytes === body.length && response.status() === 200 });
                await route.fulfill({ response });
            } catch (error) { report.errors.push(String(error)); await route.abort().catch(() => {}); }
        })();
        pending.push(operation);
        return operation;
    });
    const page = await context.newPage();
    page.on('pageerror', error => report.errors.push(String(error)));
    page.on('console', message => { if (/decode|OpenJPEG|bounds/.test(message.text())) report.warnings.push(message.text()); });
    await page.addInitScript(() => {
        const grant = handle => { handle.queryPermission = handle.requestPermission = async () => 'granted'; return handle; };
        const getDirectory = FileSystemDirectoryHandle.prototype.getDirectoryHandle;
        FileSystemDirectoryHandle.prototype.getDirectoryHandle = async function (...args) { return grant(await getDirectory.apply(this, args)); };
        window.showDirectoryPicker = async () => grant(await (await navigator.storage.getDirectory()).getDirectoryHandle('decode-failure', { create: true }));
        window.__failureAction = 'not-opened';
        window.__nullImages = [];
        const NativeWorker = Worker;
        window.Worker = class extends NativeWorker {
            constructor(...args) {
                super(...args);
                this.addEventListener('message', ({ data }) => {
                    if (data?.action === 'obj' && data.data?.[2] === 'Image' && data.data[3] === null) window.__nullImages.push({ target: data.targetName, page: data.data[1] });
                });
            }
        };
        const draw = CanvasRenderingContext2D.prototype.drawImage;
        CanvasRenderingContext2D.prototype.drawImage = function (...args) { this.canvas.__paintAction = window.__failureAction; this.canvas.__paintTime = performance.now(); return draw.apply(this, args); };
    });
    await page.goto(url);
    await page.evaluate(async bytes => {
        const vault = await (await navigator.storage.getDirectory()).getDirectoryHandle('decode-failure', { create: true });
        const handle = await vault.getFileHandle('bug_jpx.pdf', { create: true });
        const writable = await handle.createWritable(); await writable.write(new Uint8Array(bytes)); await writable.close();
    }, [...fixture]);
    await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
    await page.evaluate(() => { window.__failureAction = 'bug-jpx-open'; });
    await page.locator('.tree-item').filter({ hasText: file }).first().click();
    await page.waitForFunction(() => [...document.querySelectorAll('.pdf-viewer-page > canvas')].some(c => c.width && c.__paintAction === 'bug-jpx-open' && performance.now() - c.__paintTime > 500));
    await page.waitForLoadState('networkidle');
    await Promise.all(pending);
    if (!report.bodies.length || report.bodies.some(body => !body.matches) || !report.bodies.some(body => body.file.endsWith('/wasm/openjpeg.wasm'))) throw new Error('Served worker/codec identity is not proved');
    report.messages = await page.evaluate(() => window.__nullImages);
    report.pixels = await page.locator('.pdf-viewer-page > canvas').first().evaluate(canvas => {
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let ink = 0;
        for (let i = 0; i < pixels.length; i += 4) if (Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) < 240) ink++;
        return { width: canvas.width, height: canvas.height, ink, paintAction: canvas.__paintAction };
    });
    report.notices = await page.locator('[role="alert"], .pdf-pane-message, .pdf-render-notice').allTextContents();
    await page.screenshot({ path: resolve(out, 'silent-decode-failure.png') });
    report.witness = report.messages.length > 0 && report.pixels.ink === 0 && report.pixels.paintAction === 'bug-jpx-open' && report.notices.length === 0 && report.warnings.length > 0 && report.errors.length === 0;
    if (!report.witness) throw new Error('The silent completed-white-page witness did not fire');
} catch (error) { report.failure = String(error); throw error; }
finally { await browser.close(); await writeFile(resolve(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`); }
console.log(JSON.stringify({ witness: report.witness, pixels: report.pixels, notices: report.notices, warnings: report.warnings }, null, 2));
