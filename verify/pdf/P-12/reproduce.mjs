// Current-build PDF-D10 reproduction: an outside-edited, main-built legacy PDF.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openBrowser } from '../../lib/browser.mjs';
import { installVault, seedVault, readWitness } from '../../lib/vault.mjs';
import { installCounters, readCounters, resetCounters } from '../../lib/counters.mjs';
const [origin, fixture, output] = process.argv.slice(2);
if (!output || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname)) throw new Error('Usage: reproduce.mjs LOOPBACK_ORIGIN FOREIGN_EDITED_LEGACY_PDF OUTPUT');
const name = 'p12-reproduction', input = await readFile(fixture);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { data: { errors: [], inputSha256: sha(input), reproduced: false } };
await mkdir(output, { recursive: true });
const run = await openBrowser({ contextOptions: { viewport: { width: 1440, height: 900 } } });
let page;
try {
    report.data.browser = run.identity;
    await installVault(run.context, { name }); await installCounters(run.context, { vaultName: name });
    await run.context.route(/https:\/\/(fonts.googleapis.com|fonts.gstatic.com)\//, route => route.abort());
    page = await run.context.newPage();
    page.on('pageerror', error => report.data.errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') (report.data.consoleErrors ??= []).push(message.text()); });
    await page.goto(origin);
    await seedVault(page, { name, files: { 'foreign.pdf': input } }); await resetCounters(page);
    await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
    await page.locator('.tree-item', { hasText: 'foreign.pdf' }).click();
    await page.waitForFunction(() => document.querySelector('.textLayer')?.textContent.includes('FOREIGNEDITMARKER'), null, { timeout: 60000 });
    await page.screenshot({ path: path.join(output, 'foreign-before.png') });
    await page.getByRole('button', { name: 'Toggle view/annotate mode' }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.tl-container img')].some(img => img.complete && img.naturalWidth > 0), null, { timeout: 60000 });
    report.data.bars = await page.locator('.disk-bar').count();
    const before = await page.locator('.tl-shape[data-shape-type="draw"]').count();
    const box = await page.locator('.tl-shape[data-shape-type="image"]').first().boundingBox();
    await page.mouse.move(box.x + box.width * .55, box.y + box.height * .4);
    await page.keyboard.press('d'); await page.mouse.down();
    await page.mouse.move(box.x + box.width * .7, box.y + box.height * .45, { steps: 20 }); await page.mouse.up();
    await page.waitForFunction(before => document.querySelectorAll('.tl-shape[data-shape-type="draw"]').length > before, before);
    const overwritten = await readWitness(page, { name, path: 'foreign.pdf', binary: true, report, afterCompletedCloses: { path: 'foreign.pdf', count: 1, timeoutMs: 60000 } });
    await writeFile(path.join(output, 'overwritten.pdf'), overwritten);
    report.data.outputSha256 = sha(overwritten);
    await page.getByRole('button', { name: 'Toggle view/annotate mode' }).click();
    await page.waitForFunction(() => {
        const layer = document.querySelector('.textLayer');
        return layer && layer.textContent.trim().length > 0 && !layer.textContent.includes('FOREIGNEDITMARKER');
    }, null, { timeout: 60000 });
    await page.screenshot({ path: path.join(output, 'foreign-after.png') });
    report.data.entries = await page.evaluate(async name => {
        const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
        return [...await Array.fromAsync(dir.keys())];
    }, name);
    report.data.counters = await readCounters(page);
    report.data.reproduced = !report.data.bars && report.data.inputSha256 !== report.data.outputSha256 && report.data.entries.length === 1 && report.data.entries[0] === 'foreign.pdf';
    if (!report.data.reproduced || report.data.errors.length) throw new Error('Foreign discard was not reproduced cleanly');
} catch (error) {
    report.data.failure = error.stack ?? String(error); process.exitCode = 1;
    if (page) {
        report.data.failureScreen = await page.locator('body').innerText();
        await page.screenshot({ path: path.join(output, 'failure.png') });
    }
}
finally { await run.close(); await writeFile(path.join(output, 'reproduction.json'), `${JSON.stringify(report.data, null, 2)}\n`); console.log(JSON.stringify(report.data)); }
