import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const driver = require('playwright/package.json').version;
const browserPin = '157.0.8103.39';
const anchors = ['bme-perf-hooks-plant-7f3a', '__perf', 'ownerlessReports'];
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const artifacts = resolve(config.artifacts);
await mkdir(artifacts, { recursive: true });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const metadata = { expectedBrowser: browserPin, driver, expectedDriver: '1.63.0', commit: config.commit, anchors };

function fail(reason, detail) {
    const error = new Error(`${reason} ${detail}`);
    error.reason = reason;
    error.detail = detail;
    throw error;
}
function hand(field, got, want) {
    if (JSON.stringify(got) !== JSON.stringify(want)) fail('hand-count', `${field} ${JSON.stringify(got)}!=${JSON.stringify(want)}`);
}

async function buildIdentity(id, arm) {
    const identity = JSON.parse(await readFile(arm.identity, 'utf8'));
    assert.equal(identity.commit, config.commit, `${id}: wrong source commit`);
    assert.equal(identity.mode, id === 'P' ? 'production' : 'benchmark', `${id}: wrong build mode`);
    if (arm.patchSha256) assert.equal(identity.tree.patchSha256, arm.patchSha256, `${id}: wrong mutant patch`);
    else assert.equal(identity.tree, 'clean', `${id}: the clean build must have clean source`);
    assert(Object.keys(identity.files).length > 0, `${id}: empty build identity`);
    return identity;
}

async function scan(id, arm, identity, page, fetched, drain, supplementalUrls) {
    const supplemental = [];
    const checkBody = item => {
        const url = new URL(item.url);
        assert.equal(url.origin, new URL(arm.url).origin, `${id}: off-origin script`);
        const path = decodeURIComponent(url.pathname).replace(/^\//, '');
        const hash = sha256(item.body);
        if (id !== 'D') assert.equal(hash, identity.files[path], `${id}: body identity mismatch for ${path}`);
        return { source: item.body.toString('utf8'), url: item.url, path, sha256: hash };
    };
    await drain();
    if (id !== 'D') {
        const already = new Set(fetched.map(item => decodeURIComponent(new URL(item.url).pathname).replace(/^\//, '')));
        for (const path of Object.keys(identity.files).filter(path => path.endsWith('.js') && !already.has(path))) {
            const url = new URL(path.split('/').map(encodeURIComponent).join('/'), arm.url).href;
            supplementalUrls.add(url);
            // This is a browser fetch, not a Node read of dist. Keep its label
            // separate from scripts the user flow itself requested.
            const response = await page.evaluate(async url => {
                const response = await fetch(url);
                const bytes = new Uint8Array(await response.arrayBuffer());
                let binary = '';
                for (let offset = 0; offset < bytes.length; offset += 32768) {
                    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
                }
                return { status: response.status, body: btoa(binary) };
            }, url);
            assert.equal(response.status, 200, `${id}: missing supplemental script ${url}`);
            supplemental.push({ url, body: Buffer.from(response.body, 'base64') });
        }
    }
    await drain();
    const observed = fetched.map(checkBody);
    const extra = supplemental.map(checkBody);
    const hits = items => items.flatMap(({ source, url }) => anchors.filter(anchor => source.includes(anchor)).map(anchor => ({ url, anchor })));
    const observedHits = hits(observed);
    const supplementalHits = hits(extra);
    if (id === 'D') {
        const app = observed.find(item => new URL(item.url).pathname === '/src/App.tsx');
        assert(app?.source.includes(`${arm.root}/src/App.tsx`), 'D: JSX dev source must name the recorded worktree root');
    }
    const manifest = items => items.map(item => ({ url: item.url, path: item.path, sha256: item.sha256 }));
    const report = {
        ...metadata, id, identity, observed: manifest(observed),
        supplemental: manifest(extra), observedHits, supplementalHits,
        loss: id === 'D' ? 'Dev source text carries dead guarded code; runtime absence, not dev text absence, is asserted.' : null,
    };
    await writeFile(join(artifacts, `${id}-scan.json`), JSON.stringify(report, null, 2));
    if (id === 'P' && [...observedHits, ...supplementalHits].length) {
        const hit = [...observedHits, ...supplementalHits][0];
        fail('P-anchor', `${hit.anchor} ${hit.url}`);
    }
    if (id === 'B') for (const anchor of anchors) {
        if (!observedHits.some(hit => hit.anchor === anchor)) fail('positive-control', `${anchor} absent from browser-fetched scripts`);
    }
    return { observed: observed.length, supplemental: extra.length, observedHits, supplementalHits, loss: report.loss };
}

async function runFlow(id) {
    const arm = config.arms[id];
    let identity;
    if (id === 'D') {
        identity = { commit: git(arm.root, 'rev-parse', 'HEAD'), tree: git(arm.root, 'status', '--porcelain') ? 'dirty' : 'clean', mode: 'development' };
        assert.equal(identity.commit, config.commit, 'D: wrong source commit');
        assert.equal(identity.tree, 'clean', 'D: dirty dev source');
    } else identity = await buildIdentity(id, arm);
    assert.equal(driver, '1.63.0', 'Wrong Playwright driver');
    const browser = await chromium.launch({ headless: true, executablePath: config.chrome
        ?? '/Users/adham/Developer/bme-impl/scratch/browsers/157.0.8103.39/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' });
    metadata.browser = browser.version();
    try {
        assert.equal(browser.version(), browserPin, 'Wrong Chrome for Testing version');
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
        const page = await context.newPage();
        const errors = [];
        const fetched = [];
        const supplementalUrls = new Set();
        const pending = new Set();
        const responseErrors = [];
        page.on('pageerror', error => errors.push(error.message));
        context.on('response', response => {
            if (supplementalUrls.has(response.url())) return;
            if (response.request().resourceType() === 'script' || /javascript/.test(response.headers()['content-type'] ?? '')) {
                const task = response.body().then(body => fetched.push({ url: response.url(), body }))
                    .catch(error => responseErrors.push(`${response.url()}: ${error.message}`));
                pending.add(task);
                task.finally(() => pending.delete(task)).catch(() => {});
            }
        });
        const drain = async () => {
            while (pending.size) await Promise.all([...pending]);
            assert.deepEqual(responseErrors, [], 'A fetched script body could not be read');
        };
        await page.route('**/*', route => new URL(route.request().url()).origin === new URL(arm.url).origin ? route.continue() : route.abort());
        await page.addInitScript(() => {
            const grant = handle => {
                handle.queryPermission = async () => 'granted';
                handle.requestPermission = async () => 'granted';
                return handle;
            };
            const getDirectory = FileSystemDirectoryHandle.prototype.getDirectoryHandle;
            FileSystemDirectoryHandle.prototype.getDirectoryHandle = async function (...args) { return grant(await getDirectory.apply(this, args)); };
            window.showDirectoryPicker = async () => grant(await (await navigator.storage.getDirectory()).getDirectoryHandle('funnel-vault', { create: true }));
            delete window.FileSystemObserver;
            window.__witness = { external: false, writes: [], closed: 0, readRetries: 0, events: [] };
            const dispatch = EventTarget.prototype.dispatchEvent;
            EventTarget.prototype.dispatchEvent = function (event) {
                const detail = event instanceof CustomEvent ? event.detail : null;
                if (detail && typeof detail.seq === 'number' && typeof detail.caller === 'string'
                    && ['write', 'trash', 'move', 'retire', 'restore', 'empty-trash'].includes(event.type)) {
                    window.__witness.events.push({ ...detail });
                }
                return dispatch.call(this, event);
            };
            const createWritable = FileSystemFileHandle.prototype.createWritable;
            FileSystemFileHandle.prototype.createWritable = async function (...args) {
                const appWrite = !window.__witness.external;
                if (appWrite) window.__witness.writes.push({ name: this.name, t: performance.now() });
                const writable = await createWritable.apply(this, args);
                if (appWrite) {
                    const close = writable.close.bind(writable);
                    writable.close = async (...args) => {
                        const result = await close(...args);
                        window.__witness.closed++;
                        return result;
                    };
                }
                return writable;
            };
        });
        const writeOutside = text => page.evaluate(async text => {
            window.__witness.external = true;
            try {
                const vault = await (await navigator.storage.getDirectory()).getDirectoryHandle('funnel-vault', { create: true });
                const writable = await (await vault.getFileHandle('note.md', { create: true })).createWritable();
                await writable.write(text);
                await writable.close();
            } finally { window.__witness.external = false; }
        }, text);
        const readDisk = () => page.evaluate(async () => {
            const vault = await (await navigator.storage.getDirectory()).getDirectoryHandle('funnel-vault');
            return (await (await vault.getFileHandle('note.md')).getFile()).text();
        });
        const waitDisk = async expected => {
            const deadline = Date.now() + 10000;
            while (Date.now() < deadline) {
                const probe = await page.evaluate(async () => {
                    try {
                        const vault = await (await navigator.storage.getDirectory()).getDirectoryHandle('funnel-vault');
                        return { text: await (await (await vault.getFileHandle('note.md')).getFile()).text() };
                    } catch (error) {
                        if (error.name === 'NotReadableError' && ++window.__witness.readRetries <= 3) return { retry: true };
                        throw error;
                    }
                });
                if (probe.text === expected) return;
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            assert.fail(`Disk did not reach ${JSON.stringify(expected)} within 10 seconds`);
        };
        try {
            await page.goto(arm.url);
            await writeOutside('Initial note.\n');
            await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
            await page.locator('.vault-switcher').waitFor();
            await page.locator('.tree-item').filter({ hasText: /^note$/ }).click();
            await page.locator('.cm-content').waitFor();
            await page.keyboard.press('Meta+e');
            await page.locator('.cm-content[contenteditable="true"]').waitFor();
            await page.locator('.cm-content').click();
            await page.keyboard.press('Meta+a');
            await page.keyboard.insertText('Typed and autosaved.\n');
            await page.waitForFunction(() => window.__witness.writes.length === 1 && window.__witness.closed === 1);
            await waitDisk('Typed and autosaved.\n');
            await page.locator('.tab-dirty-dot').waitFor({ state: 'detached' });
            await writeOutside('Changed outside the app.\n');
            await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent.includes('Changed outside the app.'));
            await page.locator('.cm-content').click();
            await page.keyboard.press('Meta+a');
            await page.keyboard.insertText('Dirty when closed.\n');
            await page.locator('.tab-dirty-dot').waitFor();
            await page.locator('.tab-close').click();
            await page.waitForFunction(() => window.__witness.writes.length === 2 && window.__witness.closed === 2);
            await waitDisk('Dirty when closed.\n');
            const counters = await page.evaluate(() => ({ witness: window.__witness, funnel: window.__perf?.funnel ?? null,
                reports: window.__perf?.vault?.reports() ?? [], perfUndefined: window.__perf === undefined }));
            const disk = await readDisk();
            assert.equal(counters.witness.writes.length, 2, 'Autosave and close must each write once');
            assert.equal(counters.witness.closed, 2, 'Both writes must complete');
            await page.locator('.tree-item').filter({ hasText: /^note$/ }).click();
            await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent.includes('Dirty when closed.'));
            await page.evaluate(() => document.fonts.ready);
            const visible = await page.evaluate(() => ({ text: document.querySelector('.cm-content')?.innerText,
                tabs: [...document.querySelectorAll('.tab-title')].map(el => el.textContent),
                tree: [...document.querySelectorAll('.tree-item')].map(el => el.textContent),
                diskBars: document.querySelectorAll('.disk-bar').length, dirty: document.querySelectorAll('.tab-dirty-dot').length }));
            await page.screenshot({ path: join(artifacts, `${id}.png`) });
            const bundle = await scan(id, arm, identity, page, fetched, drain, supplementalUrls);
            const result = { ...metadata, id, url: arm.url, identity, counters, disk, visible, errors, bundle };
            await writeFile(join(artifacts, `${id}.json`), JSON.stringify(result, null, 2));
            assert.deepEqual(errors, [], 'The app must not throw');
            if (id === 'B') {
                if (!counters.funnel) fail('hand-count', 'funnel missing');
                if (!(counters.funnel.reports['pane:note'] >= 2)) fail('hand-count', 'pane:note <2');
                hand('disk', counters.funnel.reports.disk, 1);
                hand('ownerlessReports', counters.funnel.ownerlessReports, counters.funnel.reports);
                hand('rejected', counters.funnel.rejected, {});
                hand('reads', counters.funnel.reads, 2);
                const writes = counters.reports.filter(report => report.op === 'write');
                hand('write-reports', writes.length, counters.witness.writes.length);
                hand('write-callers', writes.map(report => [report.caller, report.path]), [['flushTab', 'note.md'], ['flushTab', 'note.md']]);
                hand('write-events', counters.witness.events.length, writes.length);
                writes.forEach((report, index) => assert(report.t <= counters.witness.writes[index].t, 'Report must precede writable'));
            } else {
                assert.equal(counters.perfUndefined, true, `${id}: window.__perf must be undefined`);
                assert.equal(counters.funnel, null, `${id}: no funnel hook`);
                assert.deepEqual(counters.reports, [], `${id}: no hook reports`);
                assert.deepEqual(counters.witness.events, [], `${id}: no hook events`);
            }
            console.log(`PASS ${id} browser=${browser.version()} driver=${driver} readRetries=${counters.witness.readRetries}`);
            return result;
        } catch (error) {
            await page.screenshot({ path: join(artifacts, `${id}-failure.png`) }).catch(() => {});
            await writeFile(join(artifacts, `${id}-failure.json`), JSON.stringify({ ...metadata, id, identity, error: error.stack, errors,
                witness: await page.evaluate(() => window.__witness).catch(() => null) }, null, 2));
            throw error;
        }
    } finally { await browser.close(); }
}

try {
    const production = await runFlow('P');
    const benchmark = await runFlow('B');
    const development = await runFlow('D');
    assert.equal(benchmark.disk, production.disk, 'P/B bytes differ');
    assert.deepEqual(benchmark.visible, production.visible, 'P/B visible DOM differs');
    assert.equal(development.disk, production.disk, 'D bytes differ');
    assert.deepEqual(development.visible, production.visible, 'D visible DOM differs');
    await writeFile(join(artifacts, 'result.json'), JSON.stringify({ ...metadata, result: 'pass', arms: ['P', 'B', 'D'], parity: true }, null, 2));
    console.log(`PASS C-15a P/B/D parity artifacts=${artifacts}`);
} catch (error) {
    console.error(`FAIL ${error.reason ?? 'setup'} ${error.detail ?? error.message}`);
    await writeFile(join(artifacts, 'result.json'), JSON.stringify({ ...metadata, result: 'fail', reason: error.reason ?? 'setup', error: error.stack }, null, 2));
    process.exitCode = 1;
}
