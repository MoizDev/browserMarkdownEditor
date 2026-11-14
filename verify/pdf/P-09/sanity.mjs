// Charter §0: one real-app merge/seam sanity, not another review proof run.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { openBrowser } from '../../lib/browser.mjs';
import { installVault, seedVault, readWitness } from '../../lib/vault.mjs';
import { installCounters, readCounters, resetCounters } from '../../lib/counters.mjs';
import { inspectPdfOutput } from './pdf-output.mjs';

const [origin, portfolioPath, legacyPath, out] = process.argv.slice(2);
if (!out || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname)) {
    throw new Error('Usage: sanity.mjs LOOPBACK_ORIGIN PORTFOLIO_PDF MAIN_LEGACY_PDF OUT');
}
const name = 'p09-sanity', sha = value => createHash('sha256').update(value).digest('hex');
const portfolio = await readFile(portfolioPath), legacy = await readFile(legacyPath);
await mkdir(out, { recursive: true });
const report = { data: { errors: [], passed: false, portfolioSha256: sha(portfolio), legacySha256: sha(legacy), reloadArm: 'not-run' } };
const run = await openBrowser({ contextOptions: { viewport: { width: 1440, height: 900 } } });
let page;
try {
    const { context } = run;
    report.data.browser = run.identity;
    await installVault(context, { name }); await installCounters(context, { vaultName: name });
    await context.route(/https:\/\/(fonts.googleapis.com|fonts.gstatic.com)\//, route => route.abort());
    await context.addInitScript(() => {
        if (window !== window.top) return;
        const blit = CanvasRenderingContext2D.prototype.drawImage;
        CanvasRenderingContext2D.prototype.drawImage = function (...args) {
            const result = blit.apply(this, args);
            if (this.canvas.parentElement?.classList.contains('pdf-viewer-page')) this.canvas.dataset.sanityPainted = 'yes';
            return result;
        };
    });
    page = await context.newPage();
    page.on('pageerror', error => report.data.errors.push(error.message));
    await page.goto(origin);
    await seedVault(page, { name, files: { 'portfolio.pdf': portfolio, 'legacy.pdf': legacy } });
    await resetCounters(page);
    await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
    const active = page.locator('.pdf-pane:not(.pdf-pane-hidden)');
    const painted = () => active.locator('.pdf-viewer-page canvas[data-sanity-painted="yes"]').first().waitFor({ timeout: 60000 });
    const read = (file, afterCompletedCloses) => readWitness(page, { name, path: file, binary: true, report, afterCompletedCloses });
    const screenshots = async label => {
        await page.screenshot({ path: path.join(out, `${label}-dark.png`) });
        await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click();
        await page.screenshot({ path: path.join(out, `${label}-light.png`) });
        await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).click();
    };
    const annotate = async () => {
        await page.getByRole('button', { name: 'Toggle view/annotate mode' }).click();
        await page.waitForFunction(() => [...document.querySelectorAll('.pdf-pane:not(.pdf-pane-hidden) .tl-container img')].some(img => img.complete && img.naturalWidth > 0), null, { timeout: 60000 });
    };
    const stroke = async (file, y = .25) => {
        const before = await active.locator('.tl-shape[data-shape-type="draw"]').count();
        const closes = (await readCounters(page)).records.filter(r => r.op === 'close' && r.ok && r.path === file).length;
        const box = await active.locator('.tl-shape[data-shape-type="image"]').first().boundingBox();
        await page.mouse.move(box.x + box.width * .55, box.y + box.height * y);
        await page.keyboard.press('d'); await page.mouse.down();
        await page.mouse.move(box.x + box.width * .7, box.y + box.height * (y + .05), { steps: 20 }); await page.mouse.up();
        await page.waitForFunction(before => document.querySelectorAll('.pdf-pane:not(.pdf-pane-hidden) .tl-shape[data-shape-type="draw"]').length > before, before);
        return read(file, { path: file, count: closes + 1, timeoutMs: 60000 });
    };
    await page.locator('.tree-item', { hasText: 'portfolio.pdf' }).click(); await painted();
    await page.waitForFunction(() => document.querySelector('.pdf-pane:not(.pdf-pane-hidden) .textLayer')?.textContent.includes('OUTER MUST SURVIVE'));
    await page.getByRole('button', { name: 'Toggle view/annotate mode' }).click();
    await active.locator('.pdf-role-notice').waitFor({ state: 'visible' });
    if (await active.locator('.tl-container').count()) throw new Error('Portfolio mounted an editable canvas');
    await page.keyboard.press('Meta+s');
    await screenshots('portfolio');
    report.data.portfolioUnchanged = sha(await read('portfolio.pdf')) === sha(portfolio);
    report.data.portfolioWrites = (await readCounters(page)).records.filter(r => r.op === 'createWritable' && r.path === 'portfolio.pdf').length;
    if (!report.data.portfolioUnchanged || report.data.portfolioWrites) throw new Error('Refused portfolio was written');

    await page.locator('.tree-item', { hasText: 'legacy.pdf' }).click(); await painted(); await annotate();
    report.data.existingStrokes = await active.locator('.tl-shape[data-shape-type="draw"]').count();
    if (report.data.existingStrokes !== 1) throw new Error('Main-built legacy stroke was not loaded');
    const written = await stroke('legacy.pdf');
    const inspected = await inspectPdfOutput(written, true);
    report.data.savedDrawIds = inspected.drawRecords.map(record => record.id);
    if (sha(written) === sha(legacy) || report.data.savedDrawIds.length < 2) throw new Error('Legacy stroke did not reach the saved PDF');
    await writeFile(path.join(out, 'legacy-saved.pdf'), written);
    await screenshots('legacy');
    report.data.p09Passed = true;

    report.data.counters = await readCounters(page);
    if (report.data.errors.length) throw new Error(report.data.errors.join('; '));
    report.data.passed = true;
} catch (error) {
    report.data.failure = error.stack ?? String(error); process.exitCode = 1;
    if (page) { report.data.failureScreen = await page.locator('body').innerText(); await page.screenshot({ path: path.join(out, 'failure.png') }); }
}
finally { await run.close(); await writeFile(path.join(out, 'sanity.json'), `${JSON.stringify(report.data, null, 2)}\n`); console.log(JSON.stringify(report.data)); }
