import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { installHelperStandIn } from '../lib/helper.mjs';
import { installCounters, installWorkerTargets } from '../lib/counters.mjs';
import { buildIdentity, bindServedBodies } from '../lib/substitute.mjs';
import { installVault, seedVault } from '../lib/vault.mjs';

export const root = fileURLToPath(new URL('../../../', import.meta.url));
export const scratch = process.env.BME_SCRATCH ?? '/Users/adham/Developer/bme-impl/scratch/c-c/c07b';
export const origin = new URL(process.env.BME_ORIGIN ?? 'http://localhost:6320').origin;
export const mode = process.env.BME_MODE ?? 'benchmark';
export const dist = process.env.BME_DIST ?? resolve(scratch, `dist/${mode}`);

export async function until(predicate, label, ms = 10000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail(label);
}

/** Only real app gestures and public benchmark readings live here. No imported app executor. */
export async function openFixture({ id, rules = [], install, cancel = 'after-tool', clock = false } = {}) {
    const events = [];
    const errors = [];
    const consoleErrors = [];
    const lifecycle = [];
    const pin = JSON.parse(await readFile(new URL('../../browser-pin.json', import.meta.url), 'utf8'));
    const chrome = process.env.BME_CHROME_PATH ?? (await readFile('/Users/adham/Developer/bme-impl/scratch/browsers/CHROME', 'utf8')).trim();
    const prepared = JSON.parse(await readFile(resolve(scratch, `prepared/${mode}.json`), 'utf8'));
    assert.equal(prepared.mode, mode, 'HarnessFault: wrong prepared mode');
    assert.equal(prepared.distDir, dist, 'HarnessFault: wrong prepared dist');
    const identity = prepared.identity;
    const source = await buildIdentity({ worktree: root });
    assert.equal(source.commit, identity.commit, 'HarnessFault: source commit changed since preparation');
    assert.equal(source.sourceDiffSha256, identity.sourceDiffSha256, 'HarnessFault: source changed since preparation');
    const driver = JSON.parse(await readFile(resolve(root, 'node_modules/playwright/package.json'), 'utf8'));
    assert.equal(`playwright@${driver.version}`, pin.driver, 'HarnessFault: wrong Playwright driver');
    const browser = await chromium.launch({ executablePath: chrome, headless: true });
    assert.equal(browser.version(), pin.version, 'HarnessFault: wrong Chromium build');
    const report = { id, mode, browser: browser.version(), driver: pin.driver, identity, events, errors, consoleErrors, lifecycle };
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const record = event => events.push(event);
    const counters = await installCounters(context);
    await installVault(context, { name: 'worker-vault' });
    await context.route('**/*', route => {
        if (new URL(route.request().url()).origin === origin) return route.continue();
        record({ type: 'blocked-external', url: route.request().url() });
        return route.abort();
    });
    const binding = await bindServedBodies(context, { identity, origin, mode, rules, record });
    const helper = await installHelperStandIn(context, { cancel, record });
    if (install) await install(context, record);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => {
        if (message.type() === 'error') {
            const entry = { text: message.text(), location: message.location() };
            // Fonts are explicitly blocked; retain those diagnostics separately, never hide app errors.
            if (!events.some(e => e.type === 'blocked-external' && e.url === entry.location.url)) consoleErrors.push(entry);
        }
        if (message.text().startsWith('BME_CORE_LIFECYCLE:')) lifecycle.push({ event: message.text().split(':')[1], at: Date.now() });
    });
    const targets = await installWorkerTargets(page, { record });
    if (clock) await page.clock.install({ time: new Date('2026-11-13T00:00:00Z') });
    const fixture = {
        browser, context, page, binding, helper, counters, targets, report,
        async startRun(text = 'Exercise the background worker.') {
            const before = helper.runs.length;
            await page.getByRole('textbox', { name: 'Message the agent' }).fill(text);
            await page.getByRole('button', { name: 'Send', exact: true }).click();
            await until(() => helper.runs.length > before, 'HarnessFault: the real bridge did not start this user message');
        },
        async switchVault(name = 'worker-other') {
            await page.evaluate(name => { window.__bmePickVault = name; }, name);
            await page.locator('.vault-switcher').click();
            await page.getByText('Open folder…', { exact: true }).click();
            await until(async () => (await page.locator('.vault-switcher').getAttribute('aria-label'))?.includes(name), 'HarnessFault: native picker switch did not activate the named fixture vault');
        },
        async read() { binding.check(); return counters.read(page); },
        async close() {
            report.helperFrames = helper.frames;
            report.substitutions = binding.substitutions;
            report.bindingFailures = binding.failures;
            report.targets = targets.read();
            binding.stop();
            helper.dispose();
            await browser.close();
        },
    };
    try {
        await page.goto(origin);
        await seedVault(page, { name: 'worker-vault', files: { 'control.md': 'needle control', 'fault.md': 'needle fault' } });
        await seedVault(page, { name: 'worker-other', files: { 'other.md': 'other vault marker' } });
        await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
        await page.locator('.tree-item').filter({ hasText: /^control$/ }).click();
        await page.locator('.cm-content').waitFor();
        await page.keyboard.press('Meta+Shift+x');
        await page.getByRole('button', { name: 'Connect', exact: true }).click();
        await fixture.startRun();
        return fixture;
    } catch (error) {
        await fixture.close();
        error.fixtureReport = report;
        throw error;
    }
}
