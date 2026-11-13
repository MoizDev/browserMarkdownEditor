import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const mode = option('--mode', 'benchmark');
const url = option('--url', 'http://localhost:6300/');
const outDir = option('--out-dir');
const resultPath = option('--result');
const identityPath = option('--identity', outDir ? `${outDir}.identity.json` : undefined);
const expectedCommit = option('--expect-commit');
const patchPath = option('--patch');
const sourceRoot = option('--source-root');
const devServer = option('--dev-server');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const driverVersion = createRequire(import.meta.url)('playwright/package.json').version;
const git = (...args) => execFileSync('git', ['-C', sourceRoot, ...args], { encoding: 'utf8' }).trim();
const fail = (reason, detail) => Object.assign(new Error(detail), { reason });
const chrome = option('--chrome', '/Users/adham/Developer/bme-impl/scratch/browsers/157.0.8103.39/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const plant = 'bme-perf-hooks-plant-7f3a';
// These identify the hook, not ordinary app words such as tree or paths.
const anchors = [plant, '__perf', /\.tree\s*=\s*\{\s*paths\s*:/, /\.reports\s*=\s*\(\)\s*=>/];
const fixture = {
    'trash.md': 'Keep these bytes when trashing and restoring.\n',
    'move.md': 'Keep these bytes when moving and renaming.\n',
    'asset.md': '# Asset\n\n![[pixel.png]]\n',
    'area/deep/third/leaf.md': '# Three nested levels\n',
    'area/.Assets/hidden.txt': 'A hidden asset remains hidden.\n',
    'area/.Garbage/old.md': 'Nested trash.\n',
    '.Garbage/old.md': 'Root trash.\n',
};
const manifest = ['area', 'area/deep', 'area/deep/third', 'area/deep/third/leaf.md', 'asset.md', 'move.md', 'target', 'trash.md'].sort();

if (args.includes('--compare')) {
    const i = args.indexOf('--compare');
    const [benchmark, production] = await Promise.all(args.slice(i + 1, i + 3).map(async name => JSON.parse(await readFile(name, 'utf8'))));
    assert.equal(benchmark.mode, 'benchmark');
    assert.equal(production.mode, 'production');
    assert.equal(benchmark.ok, true);
    assert.equal(production.ok, true);
    assert.equal(benchmark.identity.commit, production.identity.commit, 'parity requires the same offered commit');
    assert.deepEqual(benchmark.files, production.files, 'benchmark and production files differ');
    assert.deepEqual(benchmark.visible, production.visible, 'benchmark and production visible DOM differs');
    console.log(JSON.stringify({ ok: true, parity: true, files: Object.keys(benchmark.files).length }));
    process.exit(0);
}
let browser, context, page;
let identity;
let handFailure;
let phase = 'setup';
const errors = [];
const fetched = new Map();
const actualURLs = new Set();
const supplementalURLs = new Set();
const responseTasks = [];
async function openBrowser() {
    browser = await chromium.launch({ headless: true, executablePath: chrome });
    result.browser = browser.version();
    assert.equal(result.browser, '157.0.8103.39', 'wrong browser build');
    context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    page = await context.newPage();
    page.setDefaultTimeout(15000);
    context.on('response', response => {
        const type = response.headers()['content-type'] ?? '';
        if (/javascript/.test(type) || /\.m?js(?:\?|$)/.test(response.url())) {
            if (!supplementalURLs.has(response.url())) actualURLs.add(response.url());
            responseTasks.push(response.body().then(body => fetched.set(response.url(), body)).catch(error => errors.push(`script body: ${error.message}`)));
        }
    });
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
    const grant = handle => {
        handle.queryPermission = async () => 'granted';
        handle.requestPermission = async () => 'granted';
        return handle;
    };
    const getDir = FileSystemDirectoryHandle.prototype.getDirectoryHandle;
    FileSystemDirectoryHandle.prototype.getDirectoryHandle = async function (...args) {
        return grant(await getDir.apply(this, args));
    };
    window.showDirectoryPicker = async () => grant(await (await navigator.storage.getDirectory()).getDirectoryHandle('c15b-fixture', { create: true }));
    window.__removals = [];
    window.__copyWrites = [];
    window.__vaultEvents = [];
    const dispatch = EventTarget.prototype.dispatchEvent;
    EventTarget.prototype.dispatchEvent = function (event) {
        if (this === window.__perf?.vault) window.__vaultEvents.push({ type: event.type, detail: structuredClone(event.detail) });
        return dispatch.call(this, event);
    };
    const remove = FileSystemDirectoryHandle.prototype.removeEntry;
    FileSystemDirectoryHandle.prototype.removeEntry = async function (name, options) {
        // Capture the report BEFORE any await: a later report cannot excuse an
        // earlier deletion. Resolve the native handle independently of the app.
        const call = { t: performance.now(), name, report: window.__perf?.vault?.reports().at(-1) ?? null };
        window.__removals.push(call);
        const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('c15b-fixture');
        const parent = await root.resolve(this);
        call.path = parent === null ? null : [...parent, name].join('/');
        return remove.call(this, name, options);
    };
    const writable = FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable = async function (...args) {
        if (window.__countCopies) {
            const report = window.__perf?.vault?.reports().at(-1) ?? null;
            const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('c15b-fixture');
            const segments = await root.resolve(this);
            window.__copyWrites.push({ path: segments?.join('/'), report });
        }
        return writable.apply(this, args);
    };
    });
}
const row = name => page.locator(`.tree-item[data-path="${name}"]`);
async function waitFor(fn, arg) {
    // In the pinned driver an async waitForFunction predicate returned while
    // a fresh evaluate still read false (trash was still live). Await each
    // native-FS read ourselves; the interval only schedules the next read.
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        if (await page.evaluate(fn, arg)) return;
        await page.waitForTimeout(25);
    }
    throw new Error('Observable filesystem condition did not settle in 15 seconds');
}
async function hasFile(name, exists = true) {
    const condition = async ({ name, exists }) => {
        try {
            let dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('c15b-fixture');
            const parts = name.split('/');
            for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
            await dir.getFileHandle(parts.at(-1));
            return exists;
        } catch (error) { return !exists && error.name === 'NotFoundError'; }
    };
    await waitFor(condition, { name, exists });
    assert.equal(await page.evaluate(condition, { name, exists }), true, `file condition did not settle: ${name} (${exists})`);
}
async function trashNote() {
    await row('trash.md').hover();
    await row('trash.md').getByRole('button', { name: 'Move to Trash', exact: true }).click();
    await page.locator('.confirm-dialog').getByRole('button', { name: 'Move to Trash', exact: true }).click();
    await hasFile('trash.md', false);
    await row('trash.md').waitFor({ state: 'detached' });
}
async function openBin() {
    await page.locator('.sidebar-footer').getByRole('button', { name: 'Trash', exact: true }).click();
    await page.locator('.trash-panel').waitFor();
    await page.locator('.trash-panel').getByText('Looking through the vault…').waitFor({ state: 'hidden' });
}
async function closeBin() {
    await page.locator('.trash-panel').getByRole('button', { name: 'Close', exact: true }).click();
    await page.locator('.trash-panel').waitFor({ state: 'detached' });
}
async function setAssetText(text) {
    const editor = page.locator('.cm-content').filter({ visible: true });
    assert.equal(await editor.getAttribute('contenteditable'), 'true', 'enter edit mode before typing');
    await editor.click();
    await page.keyboard.press('Meta+a');
    await page.keyboard.insertText(text);
    await page.keyboard.press('Meta+s');
    await waitFor(async text => {
        const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('c15b-fixture');
        return await (await (await dir.getFileHandle('asset.md')).getFile()).text() === text;
    }, text);
    const disk = await page.evaluate(async () => {
        const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('c15b-fixture');
        return (await (await dir.getFileHandle('asset.md')).getFile()).text();
    });
    assert.equal(disk, text, 'edited text must reach disk');
}
async function visibleSnapshot() {
    return page.evaluate(() => ({
        tree: [...document.querySelectorAll('.tree-item[data-path]')].map(el => ({ path: el.dataset.path, text: el.querySelector('.tree-item-label')?.textContent ?? el.querySelector('.tree-folder-label')?.textContent ?? '' })).sort((a, b) => a.path.localeCompare(b.path)),
        editor: [...document.querySelectorAll('.cm-line')].map(el => el.innerText),
        images: [...document.querySelectorAll('.cm-content img:not(.cm-widgetBuffer)')].map(image => ({ visible: getComputedStyle(image).display !== 'none', width: image.naturalWidth, height: image.naturalHeight })),
        bin: document.querySelector('.trash-panel')?.innerText.replace(/\s+/g, ' ').trim() ?? null,
    }));
}
const result = { mode, url, browser: null, driver: driverVersion, expectedCommit, identity: null, idbShim: false, anchors: anchors.map(String), ok: false };
try {
    phase = 'identity';
    assert.ok(['benchmark', 'production', 'dev'].includes(mode), 'unknown arm');
    assert.equal(driverVersion, '1.63.0', 'wrong Playwright driver');
    assert.match(expectedCommit ?? '', /^[a-f0-9]{40}$/, '--expect-commit must name the exact offered commit');
    assert.equal(new URL(url).pathname, '/', 'preview URL must name the origin root');
    if (mode === 'dev') {
        assert.ok(sourceRoot && devServer, 'dev requires --source-root and --dev-server');
        result.identity = { commit: git('rev-parse', 'HEAD'), tree: git('status', '--porcelain', '--untracked-files=all') || 'clean', root: sourceRoot, mode: 'dev' };
        assert.equal(result.identity.commit, expectedCommit);
        assert.equal(result.identity.tree, 'clean', 'dev source tree must be clean');
        const server = JSON.parse(execFileSync('hc', ['get', devServer], { encoding: 'utf8' }));
        result.devServer = { address: devServer, cwd: server.cwd, argv: server.argv };
        assert.equal(server.state, 'live', 'dev server is not live');
        assert.equal(server.cwd, sourceRoot, 'dev server cwd is not the offered worktree');
        const vite = server.argv.findIndex(arg => arg.endsWith('/vite'));
        assert.ok(vite >= 0 && server.argv[vite + 1] === sourceRoot, 'dev server must explicitly pass the offered worktree as its Vite root');
        assert.ok(server.argv.includes('serve'), 'dev server lacks its serve grant');
        assert.equal(server.argv[server.argv.indexOf('--port') + 1], new URL(url).port, 'dev server does not own the observed port');
        result.loss = 'Dev source text carries dead guarded code; no textual-exclusion claim is made for development modules.';
    } else {
        assert.ok(identityPath, '--identity (or --out-dir) is required');
        identity = JSON.parse(await readFile(identityPath, 'utf8'));
        result.identity = identity;
        assert.equal(identity.commit, expectedCommit, 'wrong build commit');
        assert.equal(identity.mode, mode, 'wrong build mode');
        if (patchPath) assert.deepEqual(identity.tree, { patchSha256: sha256(await readFile(patchPath)) }, 'wrong mutant patch');
        else assert.equal(identity.tree, 'clean', 'clean arm has a dirty/mutant build');
        assert.ok(identity.files['index.html'], 'identity has no entry HTML');
    }
    await openBrowser();
    phase = 'flow';
    await page.goto(url);
    await page.evaluate(async fixture => {
        const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('c15b-fixture', { create: true });
        for (const [name, text] of Object.entries(fixture)) {
            const parts = name.split('/');
            let dir = root;
            for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
            const stream = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
            await stream.write(text);
            await stream.close();
        }
        await root.getDirectoryHandle('target', { create: true });
        const assets = await root.getDirectoryHandle('.Assets', { create: true });
        const stream = await (await assets.getFileHandle('pixel.png', { create: true })).createWritable();
        await stream.write(Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB9kAAAAASUVORK5CYII='), c => c.charCodeAt(0)));
        await stream.close();
    }, fixture);
    await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
    await row('asset.md').waitFor();
    await page.evaluate(() => document.fonts.ready);
    if (mode === 'benchmark') {
        result.initialPaths = await page.evaluate(() => {
            window.__savedTreePaths = window.__perf?.tree?.paths;
            return window.__savedTreePaths?.() ?? null;
        });
        try { assert.deepEqual(result.initialPaths, manifest, 'tree.paths differs from the fixture, including collapsed descendants'); }
        catch (error) { handFailure = error.message; }
    }
    result.visible = { initial: await visibleSnapshot() };
    await page.evaluate(() => { window.__countCopies = true; });
    await trashNote();
    await openBin();
    await page.locator('.trash-row[data-tooltip=".Garbage/trash.md"]').getByRole('button', { name: 'Put back', exact: true }).click();
    await hasFile('trash.md');
    await closeBin();
    await trashNote();
    await openBin();
    await page.locator('.trash-row[data-tooltip=".Garbage/trash.md"]').getByRole('button', { name: 'Delete permanently', exact: true }).click();
    await page.locator('.confirm-dialog').getByRole('button', { name: 'Delete permanently', exact: true }).click();
    await hasFile('.Garbage/trash.md', false);
    await closeBin();
    await row('move.md').dragTo(row('target'));
    await hasFile('target/move.md');
    await row('target').click();
    await row('target/move.md').hover();
    await row('target/move.md').getByRole('button', { name: 'Rename', exact: true }).click();
    await page.locator('.inline-rename-input').fill('renamed.md');
    await page.locator('.inline-rename-input').press('Enter');
    await hasFile('target/renamed.md');
    await row('asset.md').click();
    await page.locator('.cm-content').filter({ visible: true }).waitFor();
    await page.keyboard.press('Meta+e');
    await page.locator('.cm-content[contenteditable="true"]').waitFor();
    await setAssetText('# Asset\n\nThe picture is retired.\n');
    await hasFile('.Garbage/.Assets/pixel.png');
    await hasFile('.Assets/pixel.png', false);
    await setAssetText(fixture['asset.md']);
    await hasFile('.Assets/pixel.png');
    await hasFile('.Garbage/.Assets/pixel.png', false);
    await page.locator('.cm-content img:not(.cm-widgetBuffer)').waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('.cm-content img:not(.cm-widgetBuffer)')].every(image => image.complete && image.naturalWidth > 0));
    await openBin();
    await page.locator('.trash-panel').getByRole('button', { name: 'Empty bin', exact: true }).click();
    await page.locator('.confirm-dialog').getByRole('button', { name: 'Empty bin', exact: true }).click();
    await page.locator('.trash-panel').getByText('Nothing has been deleted in this vault.', { exact: true }).waitFor();
    result.visible.final = await visibleSnapshot();
    assert.deepEqual(result.visible.final.images, [{ visible: true, width: 1, height: 1 }], 'restored image must actually paint, not just exist on disk');
    if (resultPath) await page.screenshot({ path: resultPath.replace(/\.json$/, '') + '-final.png', fullPage: true });
    await closeBin();
    result.removals = await page.evaluate(() => window.__removals);
    result.copyWrites = await page.evaluate(() => window.__copyWrites);
    try {
        assert.deepEqual(result.removals.map(call => call.path), ['trash.md', '.Garbage/trash.md', 'trash.md', '.Garbage/trash.md', 'move.md', 'target/move.md', '.Assets/pixel.png', '.Garbage/.Assets/pixel.png', '.Garbage', 'area/.Garbage']);
    } catch (error) { handFailure ??= error.message; }
    if (mode === 'benchmark') {
        try {
        const expected = ['trash', 'restore', 'trash', 'empty-trash', 'move', 'move', 'retire', 'restore', 'empty-trash', 'empty-trash'];
        const used = new Set();
        result.removals.forEach((call, index) => {
            assert.ok(call.report, `unreported removal: ${call.path}`);
            assert.equal(call.report.op, expected[index], `wrong operation for ${call.path}`);
            assert.equal(call.report.path, call.path, `report path differs from native removal: ${call.path}`);
            assert.ok(call.report.t <= call.t, 'report must precede native removal');
            assert.ok(!used.has(call.report.seq), 'one report cannot cover two native removals');
            used.add(call.report.seq);
        });
        for (const call of result.copyWrites.filter(call => call.report?.to === call.path)) {
            assert.ok(used.has(call.report.seq), 'copy and removal must share the operation-start report');
        }
        assert.equal(result.copyWrites.filter(call => call.report?.to === call.path).length, 7, 'every move copy starts with an operation report');
        result.finalPaths = await page.evaluate(() => window.__savedTreePaths());
        assert.deepEqual(result.finalPaths, manifest.filter(name => !['trash.md', 'move.md'].includes(name)).concat('target/renamed.md').sort(), 'getter held a stale tree');
        result.reports = await page.evaluate(() => window.__perf.vault.reports().filter(report => report.op !== 'write'));
        result.events = await page.evaluate(() => window.__vaultEvents.filter(event => event.detail.op !== 'write'));
        assert.equal(result.reports.length, 10, 'one report per context-started relocation or deletion');
        assert.deepEqual(result.events.map(event => event.detail), result.reports, 'EventTarget events must agree with the report log');
        assert.deepEqual(result.events.map(event => event.type), expected);
        } catch (error) { handFailure ??= error.message; }
    }
    result.hookAfterFlow = await page.evaluate(() => ({ root: typeof window.__perf, tree: typeof window.__perf?.tree, events: window.__vaultEvents.length }));
    const files = await page.evaluate(async () => {
        const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('c15b-fixture');
        const out = {};
        const walk = async (dir, prefix) => {
            for await (const [name, handle] of dir.entries()) {
                const key = prefix ? `${prefix}/${name}` : name;
                if (handle.kind === 'directory') await walk(handle, key);
                else out[key] = [...new Uint8Array(await (await handle.getFile()).arrayBuffer())];
            }
        };
        await walk(root, '');
        return out;
    });
    result.files = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([name, bytes]) => [name, createHash('sha256').update(Buffer.from(bytes)).digest('hex')]));
    assert.equal(result.files['trash.md'], undefined);
    assert.ok(result.files['target/renamed.md']);
    assert.ok(result.files['.Assets/pixel.png']);
    phase = 'identity';
    await page.waitForLoadState('networkidle');
    await Promise.all(responseTasks);
    if (mode !== 'dev') {
        // Inventory paths come from build metadata; every asserted content byte
        // comes from the browser's responses, including these labelled fetches.
        for (const relative of Object.keys(identity.files).filter(name => name.endsWith('.js'))) {
            const assetURL = new URL(relative, url).href;
            if (fetched.has(assetURL)) continue;
            supplementalURLs.add(assetURL);
            await page.evaluate(async assetURL => {
                const response = await fetch(assetURL);
                if (!response.ok) throw new Error(`Supplemental script HTTP ${response.status}: ${assetURL}`);
                await response.arrayBuffer();
            }, assetURL);
        }
        await Promise.all(responseTasks);
    }
    await context.close();
    await Promise.all(responseTasks);
    result.fetchedScripts = [...actualURLs];
    result.supplementalScripts = [...supplementalURLs];
    result.responseHashes = {};
    const hits = [];
    for (const [name, body] of fetched) {
        const hash = sha256(body);
        result.responseHashes[name] = hash;
        if (mode === 'dev') continue;
        const address = new URL(name);
        assert.equal(address.origin, new URL(url).origin, `script is not served by this preview: ${name}`);
        const relative = decodeURIComponent(address.pathname.slice(1));
        assert.equal(hash, identity.files[relative], `served script identity mismatch: ${relative}`);
        const source = body.toString('utf8');
        for (const anchor of anchors) {
            if (typeof anchor === 'string' ? source.includes(anchor) : anchor.test(source)) hits.push({ name, anchor: String(anchor), supplemental: supplementalURLs.has(name) });
        }
    }
    assert.ok(actualURLs.size > 0, 'no actual app scripts were observed');
    assert.deepEqual(errors, [], 'browser errors');
    result.scanHits = hits;
    phase = 'gate';
    if (mode === 'production') {
        if (hits.length) throw fail('P-anchor', `${hits[0].anchor} ${hits[0].name}`);
        if (result.hookAfterFlow.root !== 'undefined' || result.hookAfterFlow.tree !== 'undefined' || result.hookAfterFlow.events !== 0) throw fail('P-anchor', 'window.__perf/events after flow');
    } else if (mode === 'benchmark') {
        for (const anchor of anchors) {
            if (!hits.some(hit => !hit.supplemental && hit.anchor === String(anchor))) throw fail('B-control', `anchor absent from app-fetched script: ${anchor}`);
        }
        if (result.hookAfterFlow.root !== 'object' || result.hookAfterFlow.tree !== 'object') throw fail('B-control', 'benchmark hook is not live');
    } else {
        if (result.hookAfterFlow.root !== 'undefined' || result.hookAfterFlow.tree !== 'undefined' || result.hookAfterFlow.events !== 0 || result.removals.some(call => call.report) || result.copyWrites.some(call => call.report)) throw fail('D-hook', 'development produced a hook, report or event');
        assert.equal(git('rev-parse', 'HEAD'), expectedCommit, 'dev source commit changed during flow');
        assert.equal(git('status', '--porcelain', '--untracked-files=all'), '', 'dev source changed during flow');
    }
    if (handFailure) throw fail('hand-count', handFailure.replace(/\s+/g, ' '));
    result.ok = true;
} catch (error) {
    result.reason = error.reason ?? `INVALID ${phase}`;
    result.error = error.stack;
    result.browserErrors = errors;
    console.error(`${error.reason ? 'FAIL' : 'INVALID'} ${error.reason ?? phase} ${error.message.replace(/\s+/g, ' ')}`);
    process.exitCode = 1;
} finally {
    if (resultPath) {
        await mkdir(path.dirname(resultPath), { recursive: true });
        await writeFile(resultPath, JSON.stringify(result, null, 2) + '\n');
        if (!result.ok && page) await page.screenshot({ path: resultPath.replace(/\.json$/, '') + '.png', fullPage: true }).catch(() => {});
    }
    console.log(JSON.stringify(result, null, 2));
    await browser?.close();
}
