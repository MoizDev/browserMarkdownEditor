// Charter §0 sanity: one real-app run, light + dark. No mutant, identity,
// eval-guard or fault-matrix proof. The worker close exercises the user-facing
// no-progress/explicit-Retry path; no app internals are imported or invoked.
import { chromium } from 'playwright';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [url, out] = process.argv.slice(2);
if (process.argv.length !== 4 || !url || !out) throw new Error('Usage: sanity.mjs <preview-url/> <fresh-out>');
const target = new URL(url);
if (target.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(target.hostname) || !target.pathname.endsWith('/')) throw new Error('Expected a loopback preview URL');
const pin = JSON.parse(await readFile(new URL('../../browser-pin.json', import.meta.url), 'utf8'));
const positive = await readFile('/Users/adham/Developer/bme-impl/scratch/p-e/local-positive-jpx.pdf');
const damaged = await readFile('/Users/adham/Developer/browserMarkdownEditor/planning/00-evidence/pdf/offscreen/downloads/upstream-fixtures/bug_jpx.pdf');
await mkdir(out);
const report = { purpose: 'P-02b real-app sanity', cases: [], losses: ['Corrupt JPX is a rights-unverified local witness', 'Silent worker close is reachable via CDP; a real Chrome worker crash often takes the renderer with it', 'No review-phase proof or performance qualification'] };
const browser = await chromium.launch({ headless: true, executablePath: `/Users/adham/Developer/bme-impl/scratch/browsers/${pin.version}/${pin.executable}` });
try {
    if (browser.version() !== pin.version) throw new Error('Wrong browser');
    report.browser = browser.version();
    for (const theme of ['dark', 'light']) {
        const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(String(error)));
        await context.route('**/*', route => new URL(route.request().url()).origin === target.origin ? route.continue() : route.abort());
        await page.addInitScript(theme => {
            localStorage.setItem('theme', theme);
            const grant = h => { h.queryPermission = h.requestPermission = async () => 'granted'; return h; };
            const getDirectory = FileSystemDirectoryHandle.prototype.getDirectoryHandle;
            FileSystemDirectoryHandle.prototype.getDirectoryHandle = async function (...args) { return grant(await getDirectory.apply(this, args)); };
            window.showDirectoryPicker = async () => grant(await (await navigator.storage.getDirectory()).getDirectoryHandle('pdf-sanity', { create: true }));
            window.__pdfSanity = { writes: 0, opens: 0, workers: 0, action: 'not-opened' };
            const writable = FileSystemFileHandle.prototype.createWritable;
            FileSystemFileHandle.prototype.createWritable = function (...args) { window.__pdfSanity.writes++; return writable.apply(this, args); };
            const NativeWorker = Worker;
            window.Worker = class extends NativeWorker {
                constructor(...args) { super(...args); window.__pdfSanity.workers++; }
                postMessage(message, ...rest) { if (message?.action === 'GetDocRequest') window.__pdfSanity.opens++; return super.postMessage(message, ...rest); }
            };
            const draw = CanvasRenderingContext2D.prototype.drawImage;
            CanvasRenderingContext2D.prototype.drawImage = function (...args) { const result = draw.apply(this, args); this.canvas.__sanityPaint = window.__pdfSanity.action; return result; };
        }, theme);
        await page.goto(url);
        await page.evaluate(async ({ scan, corrupt }) => {
            const vault = await (await navigator.storage.getDirectory()).getDirectoryHandle('pdf-sanity', { create: true });
            for (const [name, bytes] of [['scan.pdf', scan], ['corrupt.pdf', corrupt], ['waiting.pdf', scan]]) {
                const file = await vault.getFileHandle(name, { create: true });
                const writable = await file.createWritable(); await writable.write(new Uint8Array(bytes)); await writable.close();
            }
        }, { scan: [...positive], corrupt: [...damaged] });
        if (await page.evaluate(() => window.__pdfSanity.writes) !== 3) throw new Error('Seeding did not exercise the write counter');
        await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
        await page.evaluate(() => { window.__pdfSanity.writes = 0; });
        const activeCanvas = '.pdf-pane:not(.pdf-pane-hidden) .pdf-viewer-page > canvas';
        async function action(value) { await page.evaluate(value => { window.__pdfSanity.action = value; }, value); }
        async function painted(value, requireInk = true) {
            await page.waitForFunction(({ selector, value }) => [...document.querySelectorAll(selector)].some(canvas => canvas.width && canvas.__sanityPaint === value), { selector: activeCanvas, value });
            const ink = await page.locator(activeCanvas).first().evaluate(canvas => {
                const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
                let ink = 0;
                for (let i = 0; i < pixels.length; i += 4) if (Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) < 128) ink++;
                return ink;
            });
            if (requireInk && ink === 0) throw new Error('The scan painted no content');
            return ink;
        }
        const incomplete = () => page.getByRole('alert', { name: 'PDF rendering incomplete', exact: true }).filter({ hasText: 'image-decode-failed' });
        await action('scan');
        await page.locator('.tree-item').filter({ hasText: 'scan.pdf' }).first().click();
        const scanInk = await painted('scan');
        await page.screenshot({ path: resolve(out, `${theme}-scan.png`) });
        await action('corrupt');
        await page.locator('.tree-item').filter({ hasText: 'corrupt.pdf' }).first().click();
        await incomplete().waitFor();
        await page.getByRole('button', { name: 'Page thumbnails', exact: true }).click();
        await page.getByText('Thumbnail unavailable', { exact: true }).waitFor();
        const retryBox = await incomplete().getByRole('button', { name: 'Try again', exact: true }).boundingBox();
        if (!retryBox || retryBox.x < 0 || retryBox.x + retryBox.width > 1100) throw new Error('Retry is clipped outside the visible reader');
        await page.screenshot({ path: resolve(out, `${theme}-corrupt.png`) });
        const before = await page.evaluate(() => ({ opens: window.__pdfSanity.opens, workers: window.__pdfSanity.workers }));
        await action('retry-corrupt');
        await incomplete().getByRole('button', { name: 'Try again', exact: true }).click();
        await page.waitForFunction(count => window.__pdfSanity.opens > count, before.opens);
        await painted('retry-corrupt', false);
        await incomplete().waitFor();
        await page.getByText('Thumbnail unavailable', { exact: true }).waitFor();
        if (await page.evaluate(() => window.__pdfSanity.workers) !== before.workers) throw new Error('Healthy-worker Retry restarted the shared worker');
        const workers = page.workers().filter(worker => worker.url().includes('/pdfClassic.worker-'));
        if (workers.length !== 1) throw new Error('Expected one renderer');
        const closed = workers[0].waitForEvent('close');
        await workers[0].evaluate(() => self.close());
        await closed;
        await action('waiting');
        await page.locator('.tree-item').filter({ hasText: 'waiting.pdf' }).first().click();
        const delayed = page.getByRole('status', { name: 'PDF rendering delayed', exact: true });
        await delayed.waitFor({ timeout: 15000 });
        await page.screenshot({ path: resolve(out, `${theme}-watchdog.png`) });
        if (await page.evaluate(() => window.__pdfSanity.workers) !== before.workers) throw new Error('Watchdog restarted work automatically');
        await action('restarted');
        await delayed.getByRole('button', { name: 'Try again', exact: true }).click();
        const restartedInk = await painted('restarted');
        await delayed.waitFor({ state: 'detached' });
        await page.screenshot({ path: resolve(out, `${theme}-restarted.png`) });
        const state = await page.evaluate(() => window.__pdfSanity);
        if (state.workers !== before.workers + 1 || state.writes !== 0 || errors.length) throw new Error(`Unexpected restart/write/error state: ${JSON.stringify({ state, errors })}`);
        const saved = await page.evaluate(async () => {
            const vault = await (await navigator.storage.getDirectory()).getDirectoryHandle('pdf-sanity');
            return Promise.all(['scan.pdf', 'corrupt.pdf', 'waiting.pdf'].map(async name => [...new Uint8Array(await (await (await vault.getFileHandle(name)).getFile()).arrayBuffer())]));
        });
        if (!Buffer.from(saved[0]).equals(positive) || !Buffer.from(saved[1]).equals(damaged) || !Buffer.from(saved[2]).equals(positive)) throw new Error('A PDF changed during display/Retry');
        report.cases.push({ theme, scanInk, restartedInk, retryRightEdge: retryBox.x + retryBox.width, healthyRetry: true, watchdog: true, explicitRestart: true, unchangedFiles: true, state, errors });
        await context.close();
    }
} catch (error) { report.failure = String(error); throw error; }
finally { await browser.close(); await writeFile(resolve(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`); }
console.log(JSON.stringify(report, null, 2));
