import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareApp, serveApp } from './serve.mjs';
import { openBrowser } from './browser.mjs';
import { bindServedBodies } from './identity.mjs';
import { createReport } from './report.mjs';
import { installVault, seedVault, readWitness } from './vault.mjs';
import { installCounters, resetCounters, readCounters } from './counters.mjs';
import { installReload } from './reload.mjs';
import { recordRequests } from './requests.mjs';
import { editMode } from './input.mjs';
import { installFastAudit, readFastAudit, checkProductionRemovals } from './fastAudit.mjs';
import { opaqueFrameEpub } from './epubFixture.mjs';
import { createDeterministicPdf, saveDeterministicPdf } from '../fixtures/lib/pdf.mjs';

const exec = promisify(execFile);
export const fastRoot = resolve(process.env.BME_ROOT ?? fileURLToPath(new URL('../../', import.meta.url)));
export const fastScratch = resolve(process.env.BME_FAST_SCRATCH ?? '/Users/adham/Developer/bme-impl/scratch/v-a-fast');
export const fastPort = Number(process.env.BME_PORT);
export const lockPath = '/Users/adham/Developer/bme-impl/scratch/bin/bme-lock';
export const appScratch = mode => join(fastScratch, mode);

export async function prepareFast() {
    await prepareApp({ root: fastRoot, scratch: appScratch('production'), manifest: true, sourcemap: true });
    const source = await readFile(join(fastRoot, 'src/utils/perfHooks.ts'), 'utf8').catch(error => {
        if (error.code === 'ENOENT') return ''; throw error;
    });
    if (source.includes("'trash-done'")) {
        await prepareApp({ root: fastRoot, scratch: appScratch('benchmark'), mode: 'benchmark', manifest: true, sourcemap: true });
    }
}

export async function generatedVault(count = 100) {
    const out = join(fastScratch, 'fixtures');
    await mkdir(out, { recursive: true });
    await exec(process.execPath, [join(fastRoot, 'verify/fixtures/core/generators/vault.mjs'), '--out', out, '--seed', '1703', '--notes', String(count)], { cwd: fastRoot });
    const fixture = JSON.parse(await readFile(join(out, `vault-${count}.json`), 'utf8'));
    return Object.fromEntries(fixture.files.map(file => [file.path, file.encoding === 'base64' ? Buffer.from(file.content, 'base64') : file.content]));
}

export async function documentFixtures() {
    const identity = { id: 'FAST-GUARDS-PDF', seed: 1703 };
    const pdf = await createDeterministicPdf(identity);
    pdf.addPage([320, 320]).drawText('Fast guards: readable PDF', { x: 25, y: 260, size: 14 });
    return { 'Welcome.md': '# Welcome\n\nBME-VAULT-v1\n',
        'sample.pdf': await saveDeterministicPdf(pdf, identity),
        'drawing.tldraw': await readFile(join(fastRoot, 'verify/whiteboard/w-b/fixtures/old.tldraw'), 'utf8'),
        'notes.notebook': '', 'book.epub': opaqueFrameEpub() };
}

export const treeRow = (page, path) => page.locator(`.tree-item[data-path=${JSON.stringify(path)}]`);
export async function openDocument(page, path) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index++) {
        const parent = treeRow(page, parts.slice(0, index).join('/'));
        if (await parent.getAttribute('aria-expanded') !== 'true') await parent.click();
    }
    await treeRow(page, path).click();
    if (/\.pdf$/i.test(path)) await page.locator('.pdf-viewer-page canvas:visible').first().waitFor();
    else if (/\.epub$/i.test(path)) await page.frameLocator('.epub-pane iframe').locator('.chapter').first().waitFor();
    else if (/\.(tldraw|notebook)$/i.test(path)) await page.locator('.tl-container:visible').waitFor();
    else await page.locator('.cm-content:visible').waitFor();
}

export async function replaceNote(page, text) {
    await editMode(page);
    await page.locator('.cm-content:visible').click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.insertText(text);
}

/** One report per guard, fresh OPFS contexts per case, immutable prepared app. */
export async function fastGuard(name, flow) {
    if (process.argv.includes('--prepare')) { await prepareFast(); return; }
    if (!Number.isInteger(fastPort) || fastPort < 1024) throw new Error('Set BME_PORT to a port in your assigned range');
    const report = await createReport({ scratch: fastScratch, name, functionalOnly: true, timingClaims: false });
    report.data.sessions = [];
    const session = async ({ label, files, mode = 'production', init, requests = true }, action) => {
        const meta = { label, mode, fixtures: Object.fromEntries(Object.entries(files).map(([path, bytes]) =>
            [path, createHash('sha256').update(bytes).digest('hex')])) };
        report.data.sessions.push(meta);
        let app, browser, binding, traffic, page;
        const errors = [], dialogs = [];
        const vaultName = `Fast-${label}`;
        try {
            app = await serveApp({ root: fastRoot, scratch: appScratch(mode), port: fastPort, mode, build: false });
            meta.build = app.identity;
            browser = await openBrowser({ contextOptions: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 } });
            meta.browser = browser.identity;
            const { context } = browser;
            await installVault(context, { name: vaultName });
            await installCounters(context, { vaultName });
            await installFastAudit(context, vaultName);
            meta.reloadArm = await installReload(context, { arm: 'pinned-chrome', mode });
            if (init) await context.addInitScript(init);
            binding = await bindServedBodies(context, { identity: app.identity, origin: app.url, mode: 'raw-route', buildMode: mode, report: { data: meta } });
            page = await context.newPage();
            page.setDefaultTimeout(15000);
            page.on('pageerror', error => errors.push(error.message));
            page.on('dialog', async dialog => {
                dialogs.push({ type: dialog.type(), message: dialog.message() });
                await dialog.dismiss();
            });
            if (requests) traffic = recordRequests(page);
            await page.goto(app.url, { waitUntil: 'domcontentloaded' });
            await page.evaluate(() => { window.__bmeFastAudit.enabled = false; });
            await seedVault(page, { name: vaultName, files });
            await resetCounters(page);
            await page.evaluate(() => { window.__bmeFastAudit.enabled = true; });
            const check = async (label, expected, actual) => {
                await binding.check();
                report.assert(`${meta.label}: ${label}`, expected, actual);
            };
            await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
            await treeRow(page, 'Welcome.md').waitFor();
            await action({ page, context, app, report, check, meta, vaultName, traffic });
            await binding.check();
            meta.audit = await readFastAudit(page);
            meta.removalSites = await checkProductionRemovals(meta.audit, app.distDir);
            await check('native I/O resolves inside the vault', [], meta.audit.calls.filter(call => call.fault));
            await check('no page errors', [], errors);
            await check('no native dialogs except beforeunload', [], dialogs.filter(dialog => dialog.type !== 'beforeunload'));
        } finally {
            meta.pageErrors = errors; meta.dialogs = dialogs;
            if (page && !page.isClosed()) {
                meta.screenshot = join(fastScratch, 'reports', `${name}-${label}-${report.data.runId}.png`);
                await page.screenshot({ path: meta.screenshot }).catch(error => { meta.screenshotError = error.message; });
                if (traffic) meta.requests = await traffic.read();
                meta.counters = await readCounters(page).catch(() => null);
                meta.audit ??= await readFastAudit(page).catch(() => null);
            }
            traffic?.stop();
            if (binding) { try { await binding.check(); } finally { await binding.stop(); } }
            await browser?.close();
            await app?.stop();
        }
        return meta;
    };
    try { await flow({ report, session }); }
    catch (error) { report.fail(error); process.exitCode = 1; }
    const path = await report.finish();
    console.log(`${name} ${report.data.passed ? 'PASS' : 'FAIL'} ${path}`);
    if (!report.data.passed) console.error(report.data.errors.map(error => error.message).join('\n'));
}

export async function saveNote(page, vaultName, path, text, report) {
    const snapshot = await readCounters(page);
    const count = snapshot.records.filter(record => record.op === 'close' && record.ok && record.path === path).length + 1;
    await replaceNote(page, text);
    await page.keyboard.press('ControlOrMeta+s');
    const actual = await readWitness(page, { name: vaultName, path, report, afterCompletedCloses: { path, count } });
    if (actual !== text) throw new Error(`Saved note differs: ${path}`);
}
