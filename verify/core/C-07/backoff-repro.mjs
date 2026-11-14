import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { installHelperStandIn, toolText } from '../lib/helper.mjs';
import { installCounters, installWorkerTargets } from '../lib/counters.mjs';
import { buildIdentity, bindServedBodies } from '../lib/substitute.mjs';
import { installVault, seedVault } from '../lib/vault.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const scratch = process.env.BME_SCRATCH ?? '/Users/adham/Developer/bme-impl/scratch/c-c/c07b';
const origin = new URL(process.env.BME_ORIGIN ?? 'http://localhost:6320').origin;
const dist = process.env.BME_DIST ?? resolve(scratch, 'dist/benchmark');
const output = resolve(scratch, 'backoff-repro');
await mkdir(output, { recursive: true });
const pin = JSON.parse(await readFile(new URL('../../browser-pin.json', import.meta.url), 'utf8'));
const chrome = (await readFile('/Users/adham/Developer/bme-impl/scratch/browsers/CHROME', 'utf8')).trim();
const prelude = await readFile(new URL('./faults/crash-after-hello.mjs', import.meta.url), 'utf8');
const identity = await buildIdentity({ worktree: root, distDir: dist });
const events = [];
const fired = [];
const errors = [];
const report = { browser: null, cell: 'backoff-repro', identity, events, fired, errors };
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
let binding;
let helper;
let targets;
let page;
const until = async (predicate, label, ms = 10000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail(label);
};
try {
    report.browser = browser.version();
    assert.equal(report.browser, pin.version);
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const counters = await installCounters(context);
    await installVault(context, { name: 'worker-backoff' });
    binding = await bindServedBodies(context, {
        identity, origin, mode: 'benchmark', record: event => events.push(event),
        rules: [{
            id: 'crash-after-hello', anchor: 'agent-matcher-v1',
            match: ({ url }) => /\/matcher\.worker-[^/]+\.js$/.test(url.pathname),
            transform: body => prelude.replace('/* BME_FAULT_CONFIG */ null', JSON.stringify({ cell: report.cell, reportUrl: `${origin}/__core_fault__/report` })) + '\n' + body,
        }],
    });
    helper = await installHelperStandIn(context, { record: event => events.push(event) });
    await context.route(`${origin}/__core_fault__/report`, async route => {
        const data = JSON.parse(route.request().postData());
        fired.push({ at: Date.now(), ...data });
        await route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
    });
    page = await context.newPage();
    page.on('pageerror', error => errors.push(String(error)));
    targets = await installWorkerTargets(page, { record: event => events.push(event) });
    await page.goto(origin);
    await seedVault(page, { name: 'worker-backoff', files: { 'control.md': 'needle control', 'fault.md': 'needle fault' } });
    await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
    await page.locator('.tree-item').filter({ hasText: /^control$/ }).click();
    await page.locator('.cm-content').waitFor();
    await page.keyboard.press('Meta+Shift+x');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message the agent' }).fill('Exercise the background worker recovery.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await until(() => !!helper.activeRun, 'HarnessFault: a real user-started agent run did not start');
    const tool = helper.sendTool('vault_search', { query: 'needle', path: 'fault.md' });
    const result = report.result = await tool.result;
    binding.check();
    binding.requireApplied('crash-after-hello');
    assert(fired.length > 0, 'The substituted worker must report its actual fault');
    assert(toolText(result).includes('the search worker became unavailable'), 'The first real worker crash must reach the tool result');
    await until(async () => {
        report.witness = await counters.read(page);
        binding.check();
        return report.witness.perf?.find(client => client.name === 'agent-matcher')?.state === 'failed';
    }, 'The matcher cancelled host back-off/recovery: four real crashes must stop the persistent owner in failed', 4000);
    report.witness = await counters.read(page);
    report.targets = targets.read();
    assert.equal(fired.length, 4, 'Exactly four faulting worker generations, no storm');
    assert.equal(report.witness.workers.length, 4);
    assert.equal(report.witness.perf[0].inFlight, 0);
    assert.equal(report.witness.perf[0].permits, 0);
    assert.equal(errors.length, 0);
    assert.equal(report.witness.rejections.length, 0);
    console.log(JSON.stringify({ cell: report.cell, passed: true, workers: fired.length, browser: report.browser }));
} catch (error) {
    report.failure = String(error);
    if (page) await page.screenshot({ path: resolve(output, 'failure.png') }).catch(() => {});
    console.error(JSON.stringify({ cell: report.cell, failure: report.failure, faults: fired.length, state: report.witness?.perf }));
    throw error;
} finally {
    report.helperFrames = helper?.frames;
    report.substitutions = binding?.substitutions;
    report.bindingFailures = binding?.failures;
    report.targets = targets?.read();
    binding?.stop();
    helper?.dispose();
    await writeFile(resolve(output, 'observation.json'), JSON.stringify(report, null, 2));
    await browser.close();
}
