// Charter §0: one real-app quick look, not a calibrated bench/reviewer proof.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openBrowser } from '../../lib/browser.mjs';
import { prepareApp, serveApp } from '../../lib/serve.mjs';
import { installVault, seedVault } from '../../lib/vault.mjs';

const root = resolve(process.env.BME_ROOT ?? '.'), scratch = process.env.BME_SCRATCH;
const port = Number(process.env.BME_PORT ?? 6480);
if (!scratch || !process.env.BME_PDF || !process.env.BME_PATCH) throw new Error('Set BME_SCRATCH, BME_PDF, BME_PATCH; BME_ROOT is the detached seam tree');
if (process.argv.length === 3 && process.argv[2] === '--prepare') {
    await prepareApp({ root, scratch, mode: 'production' });
} else {
    if (process.argv.length !== 2) throw new Error('Only --prepare or no arguments');
    const lane = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const patch = createHash('sha256').update(await readFile(process.env.BME_PATCH)).digest('hex');
    const pdf = await readFile(process.env.BME_PDF);
    const report = { source: `lane ${lane} + seam patch ${patch}`, qualification: 'Unqualified single-run quick readings; no calibrated performance claim.', cases: [] };
    let app, run;
    await mkdir(scratch, { recursive: true });
    try {
        app = await serveApp({ root, scratch, port, mode: 'production', build: false });
        const paneChunks = (await readdir(resolve(app.distDir, 'assets'))).filter(name => /^PdfPane-.*\.js$/.test(name));
        if (paneChunks.length !== 1) throw new Error('PDF component lost its separate dynamic chunk');
        run = await openBrowser(); report.browser = run.identity;
        for (const [kind, theme, dpr] of [['pdf', 'light', 1], ['pdf', 'dark', 2], ['markdown', 'light', 1]]) {
            const context = await run.browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr });
            const vault = `PdfSanity-${kind}-${theme}`;
            await installVault(context, { name: vault });
            await context.addInitScript(theme => {
                if (window !== window.top) return;
                localStorage.setItem('theme', theme);
                window.pdfQuickRead = { clicks: [], reads: [] };
                addEventListener('pointerdown', event => {
                    const name = event.target instanceof Element ? event.target.closest('.tree-item')?.textContent?.match(/(?:first|second)\.pdf/)?.[0] : null;
                    if (name) window.pdfQuickRead.clicks.push({ file: name, t: event.timeStamp });
                }, true);
                const getFile = FileSystemFileHandle.prototype.getFile;
                FileSystemFileHandle.prototype.getFile = function (...args) {
                    const documentRead = new Error().stack?.includes('/assets/PdfPane-') === true;
                    const t = performance.now(), value = getFile.apply(this, args);
                    if (documentRead) window.pdfQuickRead.reads.push({ file: this.name, t });
                    return value;
                };
            }, theme);
            const page = await context.newPage(), urls = [], errors = [];
            page.on('request', request => urls.push(request.url()));
            page.on('pageerror', error => errors.push(error.message));
            const cdp = await context.newCDPSession(page); await cdp.send('Debugger.enable');
            let paneCompiled = false;
            cdp.on('Debugger.scriptParsed', event => { if (event.url.includes(`/assets/${paneChunks[0]}`)) paneCompiled = true; });
            await page.goto(app.url);
            await seedVault(page, { name: vault, files: kind === 'pdf' ? { 'first.pdf': pdf, 'second.pdf': pdf, 'note.md': '# A note beside the PDF\n' } : { 'note.md': '# Markdown-only vault\nNo PDF is needed here.\n' } });
            await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
            const row = { kind, theme, dpr, errors, urls, quickReadMs: [] };
            if (kind === 'pdf') {
                const until = Date.now() + 15000;
                while (!paneCompiled && Date.now() < until) await page.waitForTimeout(25);
                if (!paneCompiled) throw new Error('Expected the actual idle PDF prefetch before clicking');
                await page.waitForTimeout(100);
                for (const file of ['first.pdf', 'second.pdf']) {
                    await page.locator('.tree-item').filter({ hasText: file }).click();
                    await page.waitForFunction(file => window.pdfQuickRead.reads.some(row => row.file === file), file);
                    await page.waitForFunction(() => [...document.querySelectorAll('.pdf-viewer-page > canvas')].some(canvas => canvas.width > 0 && getComputedStyle(canvas).visibility !== 'hidden'));
                    await page.evaluate(() => document.fonts.ready);
                    row.quickReadMs.push(await page.evaluate(file => {
                        const { clicks, reads } = window.pdfQuickRead;
                        return reads.find(row => row.file === file).t - clicks.find(row => row.file === file).t;
                    }, file));
                    await page.screenshot({ path: resolve(scratch, `${theme}-${file}.png`) });
                }
                row.deltaMs = row.quickReadMs[0] - row.quickReadMs[1];
                if (row.deltaMs > 50) throw new Error(`Warm first open still delayed by ${row.deltaMs}ms`);
                const input = page.locator('.pdf-viewer:visible .pdf-viewer-page-input');
                await input.fill('2'); await input.press('Enter');
                await page.waitForFunction(() => [...document.querySelectorAll('.pdf-viewer-page-input')].some(input => getComputedStyle(input).visibility !== 'hidden' && input.value === '2'));
            } else {
                await page.locator('.tree-item').filter({ hasText: 'note' }).click();
                await page.locator('.cm-content').waitFor();
                await page.evaluate(() => new Promise(resolve => requestIdleCallback(() => resolve(), { timeout: 5000 })));
                await page.waitForTimeout(250);
                row.pdfRequests = urls.filter(url => /\/PdfPane-|\/pdfWorker-|pdf\.worker|\/pdfjs\//i.test(url));
                if (row.pdfRequests.length) throw new Error('Markdown-only vault fetched PDF code');
                await page.screenshot({ path: resolve(scratch, 'markdown-only.png') });
            }
            if (errors.length) throw new Error(`Page errors: ${errors.join('; ')}`);
            report.cases.push(row); await context.close();
        }
        report.passed = true;
    } catch (error) { report.error = error.message; throw error; }
    finally {
        await run?.close(); await app?.stop();
        await writeFile(resolve(scratch, 'sanity.json'), JSON.stringify(report, null, 2) + '\n');
    }
    console.log(JSON.stringify({ source: report.source, passed: report.passed, readings: report.cases.map(row => ({ kind: row.kind, theme: row.theme, quickReadMs: row.quickReadMs, pdfRequests: row.pdfRequests })) }, null, 2));
}
