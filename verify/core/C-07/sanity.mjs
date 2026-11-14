import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../lib/browser.mjs';
import { prepareApp, serveApp } from '../../lib/serve.mjs';
import { installVault, seedVault } from '../../lib/vault.mjs';
import { installCounters, readCounters } from '../../lib/counters.mjs';
import { fontsReady } from '../../lib/input.mjs';
import { createReport } from '../../lib/report.mjs';
import { installHelperStandIn, toolText } from '../lib/helper.mjs';
import { installWorkerTargets } from '../lib/counters.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const scratch = process.env.BME_SCRATCH ?? '/Users/adham/Developer/bme-impl/scratch/c-c/c07b/sanity';
const port = Number(process.env.BME_PORT ?? 6320);
const mode = 'benchmark';
if (process.argv.includes('--prepare')) {
    const prepared = await prepareApp({ root, scratch, mode });
    console.log(JSON.stringify({ prepared: prepared.identity.commit, scratch }));
    process.exit(0);
}

// Charter §0: product sanity, not the deferred PL0 fault matrix, clock or mutant proof.
const report = await createReport({ scratch, name: 'C-07b-sanity', fixtures: { 'control.md': 'needle control', 'fault.md': 'needle fault', 'other.md': 'other vault marker' } });
let app;
let session;
let helper;
let targets;
let page;
let faultUsed = false;
const fired = [];
const until = async (predicate, description) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail(description);
};
try {
    app = await serveApp({ root, scratch, port, mode, build: false });
    session = await openBrowser({ contextOptions: { viewport: { width: 1440, height: 900 } } });
    report.data.browser = session.identity;
    report.data.build = app.identity;
    const context = session.context;
    const origin = new URL(app.url).origin;
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await installCounters(context, { vaultName: 'worker-vault' });
    await installVault(context, { name: 'worker-vault' });
    helper = await installHelperStandIn(context, { record: event => (report.data.helperEvents ??= []).push(event) });
    await context.route(`${origin}/__core_fault__/report`, async route => {
        fired.push(JSON.parse(route.request().postData()));
        await route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
    });
    const prelude = await readFile(new URL('./faults/crash-after-hello.mjs', import.meta.url), 'utf8');
    await context.route(/\/matcher\.worker-[^/]+\.js$/, async route => {
        const response = await route.fetch();
        const original = await response.text();
        if (!faultUsed) {
            faultUsed = true;
            const config = { cell: 'C-07b-sanity', trigger: 'batch', reportUrl: `${origin}/__core_fault__/report` };
            await route.fulfill({ response, body: prelude.replace('/* BME_FAULT_CONFIG */ null', JSON.stringify(config)) + '\n' + original });
        } else await route.fulfill({ response });
    });
    page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    targets = await installWorkerTargets(page);
    await page.goto(app.url);
    await seedVault(page, { name: 'worker-vault', files: { 'control.md': 'needle control', 'fault.md': 'needle fault' } });
    await seedVault(page, { name: 'worker-other', files: { 'other.md': 'other vault marker' } });
    await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
    await page.locator('.tree-item').filter({ hasText: /^control$/ }).click();
    await page.locator('.cm-content').waitFor();
    await page.keyboard.press('Meta+Shift+x');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message the agent' }).fill('Search these notes.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await until(() => !!helper.activeRun, 'The user message did not start its real bridge run');

    const failed = await helper.sendTool('vault_search', { query: 'needle', path: 'fault.md' }).result;
    report.assert('one real worker fault fired', 1, fired.length);
    report.assert('the interrupted search reports unavailable', true, toolText(failed).includes('the search worker became unavailable'));
    await until(async () => (await page.evaluate(() => window.__perf.workers())).some(client => client.name === 'agent-matcher' && client.state === 'ready')
        && targets.read().alive.filter(worker => worker.url.includes('matcher')).length === 1, 'The host did not recover on its own after the worker crash');
    const recovered = await helper.sendTool('vault_search', { query: 'needle', path: 'control.md' }).result;
    report.assert('the next search works', true, toolText(recovered).includes('control.md:1: needle control'));
    const counters = await readCounters(page);
    report.assert('recovery reuses its replacement worker', 2, counters.records.filter(record => record.op === 'workerStart' && record.url.includes('matcher')).length);
    report.data.results = { failed, recovered };

    // Tool replies precede chatStore's coalesced render. Wait for the second card rather than
    // clicking whichever card happens to be last in the previous frame.
    const card = page.locator('.agent-tool').nth(1);
    await card.waitFor();
    await card.locator('.agent-tool-row').click();
    await card.getByText(/needle control/).waitFor();
    await fontsReady(page);
    await mkdir(resolve(scratch, 'screenshots'), { recursive: true });
    await page.screenshot({ path: resolve(scratch, 'screenshots/dark.png') });
    await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click();
    await page.locator('html[data-theme="light"]').waitFor();
    await fontsReady(page);
    await page.screenshot({ path: resolve(scratch, 'screenshots/light.png') });

    helper.finishRun();
    await page.getByRole('button', { name: 'Stop', exact: true }).waitFor({ state: 'hidden' });
    // Change only the native picker fixture; the actual switch still goes through the app menu.
    await page.evaluate(() => {
        window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('worker-other');
    });
    await page.locator('.vault-switcher').click();
    await page.getByText('Open folder…', { exact: true }).click();
    await until(async () => (await page.locator('.vault-switcher').getAttribute('aria-label'))?.includes('worker-other'), 'The new vault did not open');
    await until(async () => targets.read().alive.filter(worker => worker.url.includes('matcher')).length === 0
        && !(await page.evaluate(() => window.__perf.workers())).some(client => client.name === 'agent-matcher'), 'The old vault retained its matcher owner or worker');
    report.assert('vault switch leaves no matcher worker', 0, targets.read().alive.filter(worker => worker.url.includes('matcher')).length);
    report.assert('vault switch releases the client registry entry', 0, (await page.evaluate(() => window.__perf.workers())).filter(client => client.name === 'agent-matcher').length);
    report.assert('no page errors', [], errors);
    report.data.targets = targets.read();
    await page.screenshot({ path: resolve(scratch, 'screenshots/switched.png') });
    console.log(JSON.stringify({ passed: true, browser: session.identity.version, faults: fired.length, targets: targets.read() }));
} catch (error) {
    report.fail(error);
    if (page) await page.screenshot({ path: resolve(scratch, 'failure.png') }).catch(() => {});
    throw error;
} finally {
    report.data.helperFrames = helper?.frames;
    helper?.dispose();
    await session?.close();
    await app?.stop();
    console.log(await report.finish());
}
