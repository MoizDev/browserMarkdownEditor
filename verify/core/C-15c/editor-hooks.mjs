import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { assertIdentity, fail, observe } from './observe.mjs';

const driverVersion = createRequire(import.meta.url)('playwright/package.json').version;

const plain = 'A plain sentence for the editor counter interval.\n\nLast line.';
const mixed = 'A note with one picture and one formula.\n\n![[counter.svg]]\n\n$$\nx^2 + y^2 = z^2\n$$\n\nLast line.';
const typed = 'counterinterval';

async function seed(page) {
    await page.evaluate(async ({ plain, mixed }) => {
        const root = await navigator.storage.getDirectory();
        const vault = await root.getDirectoryHandle('counter-vault', { create: true });
        const assets = await vault.getDirectoryHandle('.Assets', { create: true });
        for (const [dir, name, text] of [
            [vault, 'Plain.md', plain], [vault, 'Mixed.md', mixed],
            [assets, 'counter.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="#6699cc"/></svg>'],
        ]) {
            const file = await dir.getFileHandle(name, { create: true });
            const stream = await file.createWritable();
            await stream.write(text);
            await stream.close();
        }
    }, { plain, mixed });
}

async function files(page) {
    return page.evaluate(async () => {
        const result = {};
        const walk = async (dir, prefix = '') => {
            for await (const [name, handle] of dir.entries()) {
                const path = prefix + name;
                if (handle.kind === 'directory') await walk(handle, path + '/');
                else {
                    const bytes = await (await handle.getFile()).arrayBuffer();
                    result[path] = Array.from(new Uint8Array(bytes));
                }
            }
        };
        await walk(await (await navigator.storage.getDirectory()).getDirectoryHandle('counter-vault'));
        return result;
    });
}

async function runArm(browser, arm, identity, reportDir) {
    const { url, kind } = arm;
    const benchmark = kind === 'B';
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    const observation = observe(context, arm, identity);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    // No font/CDN/helper traffic leaves this local run.
    await page.route('**/*', route => new URL(route.request().url()).origin === new URL(url).origin
        ? route.continue() : route.abort());
    await page.addInitScript(() => {
        let perf;
        window.__c15HookRootWrites = 0;
        Object.defineProperty(window, '__perf', {
            configurable: true,
            get: () => perf,
            set: value => { window.__c15HookRootWrites++; perf = value; },
        });
        const grant = handle => {
            handle.queryPermission = async () => 'granted';
            handle.requestPermission = async () => 'granted';
            return handle;
        };
        const getDir = FileSystemDirectoryHandle.prototype.getDirectoryHandle;
        FileSystemDirectoryHandle.prototype.getDirectoryHandle = async function (...args) {
            return grant(await getDir.apply(this, args));
        };
        window.showDirectoryPicker = async () => grant(await (await navigator.storage.getDirectory()).getDirectoryHandle('counter-vault', { create: true }));
    });
    const result = { url, kind, identity, fixtures: {} };
    let phase = 'render';
    try {
        await page.goto(url);
        await seed(page);
        await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
        for (const [name, original] of [['Plain', plain], ['Mixed', mixed]]) {
            await page.locator('.tree-item').filter({ hasText: new RegExp(`^${name}$`) }).click();
            const content = page.locator('.cm-content:visible');
            // A row click reads asynchronously. An old note's still-mounted
            // contenteditable=false is not evidence that this note opened.
            await content.locator('.cm-line').filter({ hasText: original.split('\n')[0] }).waitFor();
            await page.waitForFunction(() => document.querySelector('.cm-content')?.getAttribute('contenteditable') === 'false');
            if (benchmark) {
                if (!await page.evaluate(() => !!window.__perf?.editor)) fail('FAIL B-control missing-editor-hook');
                await page.waitForFunction(() => window.__perf.editor.parse.idle);
            }
            await page.keyboard.press('Meta+e');
            await page.waitForFunction(() => document.querySelector('.cm-content')?.getAttribute('contenteditable') === 'true');
            // Click prose, not the content box's centre (which is the picture
            // in Mixed). Its own selection handlers legitimately take focus.
            await content.locator('.cm-line').filter({ hasText: /^Last line\.$/ }).click();
            await page.keyboard.press('Meta+ArrowRight');
            assert.equal(await content.evaluate(el => document.activeElement === el), true, 'the editable note must hold the keyboard');
            if (benchmark) {
                await page.waitForFunction(() => window.__perf.editor.parse.idle);
                await page.evaluate(() => window.__perf.editor.reset());
                phase = 'hand-count';
                const reset = await page.evaluate(() => window.__perf.editor);
                assert.equal(reset.transactions, 0, 'reset starts a fresh interval');
                assert.equal(reset.windows, 0);
                assert.equal(reset.widgetsBuilt, 0);
                assert.equal(reset.l3Ms.total, 0);
                assert.deepEqual(reset.l3Ms.samples, []);
                phase = 'render';
            }
            for (const character of typed) await page.keyboard.press(character);
            assert.ok((await content.innerText()).endsWith('Last line.' + typed), 'real key presses must append exactly N characters at the document end');
            await page.keyboard.press('Meta+e');
            await page.waitForFunction(() => document.querySelector('.cm-content')?.getAttribute('contenteditable') === 'false');
            await page.keyboard.press('Meta+e');
            await page.waitForFunction(() => document.querySelector('.cm-content')?.getAttribute('contenteditable') === 'true');
            if (benchmark) {
                await page.waitForFunction(() => window.__perf.editor.parse.idle);
                phase = 'hand-count';
                const counters = await page.evaluate(() => window.__perf.editor);
                assert.ok(counters.transactions >= typed.length, 'the field must see every typed key');
                if (counters.fullRenders.mode !== 2) fail(`FAIL hand-count fullRenders.mode ${counters.fullRenders.mode}!=2`);
                assert.ok(counters.fullRenders.coverage >= typed.length, 'each typing transaction rebuilds today');
                assert.equal(counters.fullRenders.create, 0, 'mode changes must not be classified as initial creation');
                assert.equal(counters.fullRenders.revGap, 0);
                assert.equal(counters.fullRenders.error, 0);
                assert.equal(counters.windows, Object.values(counters.fullRenders).reduce((a, b) => a + b, 0));
                assert.ok(counters.windowChars >= original.length * counters.windows, 'each rebuild covers the full document');
                assert.equal(counters.l1Ms, null, 'today has no L1 split');
                assert.equal(counters.l3Ms.samples.length, counters.windows, 'each rebuild has one timing sample');
                assert.ok(counters.l3Ms.samples.every(ms => Number.isFinite(ms) && ms >= 0));
                assert.equal(counters.l3Ms.total, counters.l3Ms.samples.reduce((a, b) => a + b, 0));
                assert.equal(counters.slicedChars, 0);
                assert.equal(counters.parse.treeLength, original.length + typed.length);
                assert.equal(counters.parse.idle, true);
                if (name === 'Plain') assert.equal(counters.widgetsBuilt, 0, 'plain prose constructs no widgets');
                else assert.ok(counters.widgetsBuilt > 0, 'image/math widgets must be counted');
                result.fixtures[name] = { counters };
                phase = 'render';
            } else result.fixtures[name] = {};
            await page.keyboard.press('Meta+s');
            const saveWitness = await page.evaluate(async ({ name, expected }) => {
                const witness = { attempts: 0, notReadableRetries: 0, passed: false, error: null };
                const deadline = performance.now() + 10000;
                while (performance.now() < deadline) {
                    witness.attempts++;
                    try {
                        const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('counter-vault');
                        if (await (await (await dir.getFileHandle(name + '.md')).getFile()).text() === expected) {
                            witness.passed = true;
                            return witness;
                        }
                    } catch (error) {
                        // Only the outside witness retries a raced File snapshot.
                        // App pageerrors are captured separately and always fail.
                        if (error.name !== 'NotReadableError') throw error;
                        witness.notReadableRetries++;
                        if (witness.notReadableRetries > 3) {
                            witness.error = 'Outside save witness exhausted its three NotReadableError retries';
                            return witness;
                        }
                    }
                    await new Promise(resolve => setTimeout(resolve, 30));
                }
                witness.error = 'Saved source did not match within 10 seconds';
                return witness;
            }, { name, expected: original + typed });
            result.fixtures[name].saveWitness = saveWitness;
            assert.equal(saveWitness.passed, true, saveWitness.error || 'saved source must match');
            await page.keyboard.press('Meta+e');
            await page.waitForFunction(() => document.querySelector('.cm-content')?.getAttribute('contenteditable') === 'false');
            if (name === 'Mixed') {
                await page.locator('.cm-math-widget .katex').waitFor();
                await page.waitForFunction(() => document.querySelector('.cm-image-widget img')?.naturalWidth > 0);
                assert.deepEqual(await page.locator('.cm-image-widget img').evaluate(img => [img.naturalWidth, img.naturalHeight]), [120, 40]);
            }
            await page.evaluate(() => document.fonts.ready);
            // Object URLs are intentionally per context/origin. Their bytes and
            // loaded dimensions are checked separately; their random IDs are not DOM parity.
            result.fixtures[name].dom = await content.evaluate(el => el.innerHTML.replace(/blob:[^"\s]+/g, 'blob:object-url'));
            await page.screenshot({ path: join(reportDir, `${kind}-${name}.png`), animations: 'disabled', caret: 'hide' });
        }
        result.files = await files(page);
        assert.deepEqual(errors, [], 'the real app must raise no page errors');
        result.observation = await observation.finish();
        result.hookProbe = await page.evaluate(() => ({
            rootUndefined: window.__perf === undefined,
            editorUndefined: window.__perf?.editor === undefined,
            rootAssignments: window.__c15HookRootWrites,
        }));
        if (benchmark) {
            if (result.hookProbe.rootUndefined || result.hookProbe.rootAssignments === 0) fail('FAIL B-control hook-root-observer');
        } else if (!result.hookProbe.rootUndefined || !result.hookProbe.editorUndefined || result.hookProbe.rootAssignments !== 0) {
            fail(`FAIL ${kind}-hook ${JSON.stringify(result.hookProbe)}`);
        }
        return result;
    } catch (error) {
        // Every user-visible/hand-count assertion is a product failure. Only
        // explicitly tagged byte-identity/transport failures remain INVALID.
        if (!error.gateReason && !error.invalidExecution) {
            error.gateReason = `FAIL ${phase === 'hand-count' ? 'hand-count' : kind + '-render'} ${error.message}`;
        }
        result.observation = observation.snapshot();
        result.failure = await page.evaluate(() => ({
            text: document.body.innerText,
            focus: document.activeElement ? {
                tag: document.activeElement.tagName,
                className: document.activeElement.className,
                role: document.activeElement.getAttribute('role'),
            } : null,
        })).catch(() => null);
        await page.screenshot({ path: join(reportDir, `${kind}-failure.png`), animations: 'disabled', caret: 'hide' }).catch(() => {});
        error.arm = result;
        throw error;
    } finally {
        await context.close();
    }
}

const [specPath, output = '/Users/adham/Developer/bme-impl/scratch/c-d/C-15c'] = process.argv.slice(2);
await mkdir(output, { recursive: true });
const report = { gate: 'C-15c-editor-PBD', browser: null, playwright: driverVersion, node: process.version, identities: [], arms: [] };
let browser;
try {
    assert.ok(specPath, 'Use editor-hooks.mjs <P-B-D-spec.json> [report-directory]');
    const spec = JSON.parse(await readFile(specPath, 'utf8'));
    assert.deepEqual(spec.arms.map(arm => arm.kind), ['P', 'B', 'D'], 'one invocation runs production, benchmark and dev');
    assert.equal(driverVersion, '1.63.0', 'the driver must be the I-0 pin');
    for (const arm of spec.arms) report.identities.push(await assertIdentity(arm));
    assert.equal(new Set(report.identities.map(identity => identity.commit)).size, 1, 'P/B/D derive from the same commit');
    const executablePath = (await readFile('/Users/adham/Developer/bme-impl/scratch/browsers/CHROME', 'utf8')).trim();
    browser = await chromium.launch({ headless: true, executablePath });
    report.browser = browser.version();
    assert.equal(report.browser, '157.0.8103.39', 'the browser must be the integrator-pinned build');
    for (let i = 0; i < spec.arms.length; i++) {
        report.arms.push(await runArm(browser, spec.arms[i], report.identities[i], output));
    }
    try {
        assert.deepEqual(report.arms[0].files, report.arms[1].files, 'instrumentation must not change any vault bytes');
        for (const name of ['Plain', 'Mixed']) assert.equal(report.arms[0].fixtures[name].dom, report.arms[1].fixtures[name].dom,
            'instrumentation must not change the visible editor DOM');
    } catch (error) { fail(`FAIL PB-parity ${error.message}`); }
    report.passed = true;
    console.log('PASS C-15c P B D parity');
} catch (error) {
    report.passed = false;
    if (error.arm) report.arms.push(error.arm);
    report.error = error.stack;
    report.reason = error.gateReason || `INVALID ${error.message}`;
    report.actual = error.actual;
    report.expected = error.expected;
    process.exitCode = error.gateReason ? 1 : 2;
    console.log(report.reason);
} finally {
    await browser?.close();
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ ...report,
        identities: report.identities.map(identity => ({ ...identity, files: Object.keys(identity.files).length, sources: Object.keys(identity.sources || {}).length })),
        arms: report.arms.map(arm => ({
            url: arm.url, kind: arm.kind, hookProbe: arm.hookProbe,
            scripts: arm.observation?.scripts.length, supplemental: arm.observation?.supplemental.length,
            sourceTextLoss: arm.observation?.sourceTextLoss,
            fixtures: Object.fromEntries(Object.entries(arm.fixtures).map(([name, value]) => [name, { counters: value.counters, saveWitness: value.saveWitness }])),
            files: Object.keys(arm.files || {}), failure: arm.failure,
        })),
    }, null, 2));
}
