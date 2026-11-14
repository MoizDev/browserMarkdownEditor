#!/usr/bin/env node
import { resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { prepareApp, serveApp, withSaveSkipped, withDevSourceDrift } from '../lib/serve.mjs';
import { openBrowser } from '../lib/browser.mjs';
import { installVault, seedVault, readWitness, waitForVault } from '../lib/vault.mjs';
import { editMode, typeText, fontsReady } from '../lib/input.mjs';
import { installReload, forceReload } from '../lib/reload.mjs';
import { installCounters, readCounters, resetCounters } from '../lib/counters.mjs';
import { recordRequests } from '../lib/requests.mjs';
import { createReport } from '../lib/report.mjs';
import { buildIdentity, bindServedBodies } from '../lib/identity.mjs';
import { opaqueFrameEpub } from '../lib/epubFixture.mjs';

// One autosave of one inserted sentence; opening/reading/restoring never writes.
// The note phase ends before the separate EPUB frame control starts workers.
// No trash or move is requested in either phase.
const expectedCounts = { createWritable: 1, close: 1, removeEntry: 0, workerStart: 0 };
const sentence = 'The toolbox sentence survives autosave and a real reload.';
const fixtures = {
    'A.md': '# Note A\n\nOriginal A.\n',
    'B.md': '# Note B\n\nOriginal B.\n',
    'C.md': '# Note C\n\n![[pixel.png]]\n',
    'Opaque.epub': opaqueFrameEpub(),
    '.Assets/pixel.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'),
};
const options = {
    root: resolve(process.env.BME_ROOT ?? '.'),
    scratch: resolve(process.env.BME_SCRATCH ?? '/Users/adham/Developer/bme-impl/scratch/v-a'),
    port: Number(process.env.BME_PORT ?? 6160),
    mode: process.env.BME_MODE ?? 'production',
};
const arm = process.env.BME_RELOAD_ARM ?? 'pinned-chrome';
const mutant = process.argv.includes('--mutant');
const bindingMutant = process.argv.includes('--binding-mutant');
const initMutant = process.argv.includes('--init-mutant');
const devDriftMutant = process.argv.includes('--dev-drift-mutant');
const headDriftMutant = process.argv.includes('--head-drift-mutant');
const flags = { mutant, bindingMutant, initMutant, devDriftMutant, headDriftMutant };
if (Object.values(flags).filter(Boolean).length > 1) throw new Error('Choose one mutant arm at a time');
const mutantName = mutant ? 'mutant' : bindingMutant ? 'binding-mutant' : initMutant ? 'init-mutant' : devDriftMutant ? 'dev-drift-mutant' : headDriftMutant ? 'head-drift-mutant' : '';
if (process.argv.includes('--prepare')) {
    try {
        const requestedRoot = options.root;
        if ((devDriftMutant || headDriftMutant) && options.mode !== 'dev') throw new Error('Dev source/HEAD drift controls require BME_MODE=dev');
        if (mutant) options.root = await withSaveSkipped(options);
        if (devDriftMutant) options.root = await withDevSourceDrift({ ...options, file: process.env.BME_DEV_DRIFT_PATH });
        const prepared = await prepareApp(options);
        prepared.requestedRoot = requestedRoot;
        prepared.flags = flags;
        if (devDriftMutant) {
            const patch = prepared.identity.mutant;
            const path = resolve(prepared.root, patch.file);
            await writeFile(path, Buffer.concat([await readFile(path), Buffer.from(patch.append)]));
        }
        if (headDriftMutant) {
            prepared.headDriftMutant = { before: prepared.identity.commit, after: '0'.repeat(40), kind: 'stale prepared HEAD metadata; source bytes unchanged' };
            prepared.identity.commit = prepared.headDriftMutant.after;
        }
        if (bindingMutant) {
            if (!prepared.distDir) throw new Error('Binding mutant requires a production build');
            const html = await readFile(resolve(prepared.distDir, 'index.html'), 'utf8');
            const entries = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g)];
            if (entries.length !== 1) throw new Error('Binding mutant entry-script anchor is absent or ambiguous');
            const entryPath = new URL(entries[0][1], 'http://prepared.invalid/').pathname.slice(1);
            const emitted = prepared.identity.files.find(file => file.path === entryPath);
            if (!emitted) throw new Error('Binding mutant entry script is not in the emitted manifest');
            const path = resolve(prepared.distDir, emitted.path);
            prepared.bindingMutant = { path: emitted.path, emittedSha256: emitted.sha256, append: '\n// served-body binding mutant\n' };
            const manifest = await buildIdentity({ worktree: requestedRoot, distDir: prepared.distDir, patch: prepared.bindingMutant });
            prepared.identity = { ...prepared.identity, ...manifest, contentSha256: manifest.manifestSha256 };
            await writeFile(path, Buffer.concat([await readFile(path), Buffer.from(prepared.bindingMutant.append)]));
        }
        const path = resolve(options.scratch, 'prepared.json');
        await writeFile(path, `${JSON.stringify(prepared, null, 2)}\n`);
        console.log(path);
    } catch (error) { console.error(error); process.exitCode = 1; }
    process.exit(process.exitCode ?? 0);
}
const report = await createReport({ ...options, name: `toolbox-smoke-${options.mode}${mutantName ? `-${mutantName}` : ''}`, fixtures,
    gate: { witness: 'A.md and the restored editor contain the sentence',
        identity: 'build content hash, actual browser version, reload arm and document path',
        mutant: initMutant ? 'initializer guards removed and subframe FSA constructors hidden; pageerror must fail' : devDriftMutant ? 'served source changed after dev preparation; startup must refuse' : headDriftMutant ? 'prepared HEAD metadata made stale; startup must refuse' : bindingMutant ? 'served entry script gains a harmless comment; body binding must reject it' : 'flushTab versioned-write call replaced in a scratch copy only',
        falsePass: 'hash-only navigation mistaken for a reload; marker must disappear',
        loss: 'OPFS does not prove real-disk events (VER-11); window counters miss worker internals (V-01b)' },
    expectedCounts, counterScope: 'note open/save/switch/restore; EPUB frame control has a separate counter epoch',
});
let app, session, requests, binding;
const assert = async (...args) => { await binding.check(); report.assert(...args); };
try {
    const prepared = JSON.parse(await readFile(resolve(options.scratch, 'prepared.json'), 'utf8'));
    if (prepared.requestedRoot !== options.root || Object.entries(flags).some(([key, value]) => !!prepared.flags?.[key] !== value)) throw new Error('Prepared smoke flags/source do not match this run; run --prepare first');
    report.data.preparation = { preparedAt: prepared.preparedAt, flags: prepared.flags };
    if (prepared.bindingMutant) report.data.bindingMutant = prepared.bindingMutant;
    if (prepared.headDriftMutant) report.data.headDriftMutant = prepared.headDriftMutant;
    app = await serveApp({ ...options, root: prepared.root, build: false });
    report.data.build = app.identity;
    session = await openBrowser();
    report.data.browser = session.identity;
    const initContext = initMutant ? {
        async addInitScript(callback, arg) {
            const source = typeof callback === 'function' ? `(${callback.toString()})(${JSON.stringify(arg)});` : callback.content;
            if (typeof source !== 'string') throw new Error('Init mutant requires a serializable callback/content script');
            const start = source.indexOf('if (window !== window.top) return;');
            const marker = source.includes('if (window.__bmeCounters) return;') ? 'if (window.__bmeCounters) return;' : 'const grant = handle => {';
            const end = source.indexOf(marker, start);
            if (start < 0 || end < 0 || source.split('if (window !== window.top) return;').length !== 2) throw new Error('Unguarded-init mutant anchor changed (VER-13)');
            const fault = "if (window !== window.top) for (const name of ['FileSystemHandle','FileSystemDirectoryHandle','FileSystemFileHandle']) Reflect.deleteProperty(globalThis, name);\n";
            const patched = source.slice(0, start) + fault + 'const storage = navigator.storage;\nconst legacyDirectory = FileSystemDirectoryHandle.prototype;\n' + source.slice(end);
            const receipts = report.data.initMutant ??= [];
            receipts.push({ removed: 'main-window and FSA feature guards', frameFault: 'hide FSA constructors only in subframes', continuation: marker });
            new Function(patched); // A broken mutation is a patch-time fault (VER-13), never a killed gate.
            await session.context.addInitScript({ content: patched });
        },
    } : session.context;
    await installCounters(initContext, { vaultName: 'Toolbox Vault' });
    await installVault(initContext, { name: 'Toolbox Vault' });
    report.data.reload = await installReload(session.context, { arm, mode: options.mode });
    const page = await session.context.newPage();
    binding = await bindServedBodies(session.context, { identity: app.identity, origin: app.url,
        mode: process.env.BME_BINDING_MODE ?? 'raw-route', buildMode: options.mode, report,
        moduleOverrides: report.data.reload.moduleOverrides });
    requests = recordRequests(page);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(app.url);
    await seedVault(page, { name: 'Toolbox Vault', files: fixtures });
    // Atomically snapshot+reset: even a worker starting during seeding is retained.
    const startupCounters = await resetCounters(page);
    report.data.startupCounters = startupCounters;
    await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
    await page.locator('.vault-switcher').waitFor();
    await page.locator('.tree-item').filter({ hasText: /^A$/ }).click();
    const editor = page.locator('.cm-content:visible');
    await editor.waitFor();
    await fontsReady(page);
    await assert('opened A through the tree', true, (await editor.innerText()).includes('Original A.'));
    if (options.mode !== 'dev') {
        const style = app.identity.files.find(file => /^assets\/index-[^/]+\.css$/.test(file.path));
        if (!style) throw new Error('CSS initiator control requires the emitted app stylesheet');
        const styleUrl = new URL(style.path, app.url).href;
        const fetchedBytes = await page.evaluate(async url => (await (await fetch(url)).arrayBuffer()).byteLength, styleUrl);
        await assert('same stylesheet fetched through fetch has its raw byte length', style.bytes, fetchedBytes);
        const control = await binding.check();
        const types = control.browserUrls.filter(row => row.url === styleUrl).map(row => row.type);
        await assert('CSS control exercised stylesheet and fetch initiators', true, types.includes('stylesheet') && types.includes('fetch'));
        report.data.cssInitiatorControl = { path: style.path, sha256: style.sha256, bytes: style.bytes, types };
    }
    await editMode(page);
    await editor.click();
    await page.keyboard.press('ControlOrMeta+End');
    await typeText(page, `\n\n${sentence}`);
    // Only read externally: no save command, no app import and no editor dispatch.
    const deadline = Date.now() + 15000;
    let disk = '';
    while (Date.now() < deadline) {
        disk = await readWitness(page, { name: 'Toolbox Vault', path: 'A.md', report });
        if (disk.includes(sentence)) break;
        await page.waitForTimeout(100);
    }
    const before = await readCounters(page);
    report.data.counters = before;
    await assert('autosave witness on disk', true, disk.includes(sentence));
    const aPath = 'A.md';
    await assert('A write count', expectedCounts.createWritable, before.records.filter(r => r.op === 'createWritable' && r.path === aPath && r.ok).length);
    await assert('A closed-write count', expectedCounts.close, before.records.filter(r => r.op === 'close' && r.path === aPath && r.ok).length);
    await assert('no removal', expectedCounts.removeEntry, before.records.filter(r => r.op === 'removeEntry').length);
    await assert('markdown workers', expectedCounts.workerStart, [...startupCounters.records, ...before.records].filter(r => r.op === 'workerStart').length);
    report.data.counters = before;
    const synchronized = await readWitness(page, { name: 'Toolbox Vault', path: 'A.md', report,
        afterCompletedCloses: { path: 'A.md', count: 1 } });
    await assert('completed-close barrier reads the saved file', disk, synchronized);
    let closeWaitFault;
    try { await readWitness(page, { name: 'Toolbox Vault', path: 'A.md', report,
        afterCompletedCloses: { path: 'A.md', count: 2, timeoutMs: 100, intervalMs: 10 } }); }
    catch (error) { closeWaitFault = error.name; }
    await assert('missing completed close fails as harness fault', 'HarnessFault', closeWaitFault);
    await assert('close wait reports the completed count, not opens', 1, report.data.completedCloseWaits.at(-1).observed);
    // Fault the outside binary witness, not app code: prove transient retries and
    // exhaustion without depending on an OS lock race happening on this machine.
    await page.evaluate(() => {
        const prototype = FileSystemFileHandle.prototype, original = prototype.getFile;
        window.__bmeWitnessFault = { remaining: 2, restore: () => { prototype.getFile = original; } };
        prototype.getFile = function (...args) {
            if (this.name === 'pixel.png' && window.__bmeWitnessFault.remaining-- > 0) throw new DOMException('Injected open-writer lock', 'NotReadableError');
            return original.apply(this, args);
        };
    });
    try {
        const retriesBefore = report.data.witnessRetries?.length ?? 0;
        const image = await readWitness(page, { name: 'Toolbox Vault', path: '.Assets/pixel.png', binary: true, report });
        await assert('retry witness returns fresh image bytes', fixtures['.Assets/pixel.png'].toString('hex'), image.toString('hex'));
        await assert('two transient lock retries recorded', 2, report.data.witnessRetries.length - retriesBefore);
        await page.evaluate(() => { window.__bmeWitnessFault.remaining = Infinity; });
        let exhausted;
        try { await readWitness(page, { name: 'Toolbox Vault', path: '.Assets/pixel.png', attempts: 3, delayMs: 5, report }); }
        catch (error) { exhausted = error.name; }
        await assert('unclosed writer fails as bounded harness fault', 'HarnessFault', exhausted);
        await assert('exhausted retry is recorded', true, report.data.witnessRetries.at(-1).exhausted);
    } finally { await page.evaluate(() => { window.__bmeWitnessFault.restore(); delete window.__bmeWitnessFault; }); }
    const saved = await waitForVault(page, async ({ name, sentence }) => {
        const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
        return (await (await (await root.getFileHandle('A.md')).getFile()).text()).includes(sentence);
    }, { report, arg: { name: 'Toolbox Vault', sentence } });
    await assert('async filesystem condition awaits actual saved bytes', true, saved);
    let timedOut;
    try {
        await waitForVault(page, async ({ name }) => {
            const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
            return (await (await (await root.getFileHandle('A.md')).getFile()).text()).includes('A marker that was never typed.');
        }, { timeoutMs: 1000, intervalMs: 25, report, arg: { name: 'Toolbox Vault' } });
    } catch (error) { timedOut = error.name; }
    await assert('async false filesystem condition never passes', 'HarnessFault', timedOut);
    await assert('timeout records actual false, not Promise truthiness', false, report.data.vaultWaits.at(-1).lastObserved);
    await page.locator('.tree-item').filter({ hasText: /^B$/ }).click();
    await page.locator('.cm-content:visible').filter({ hasText: 'Original B.' }).waitFor();
    await page.locator('.tree-item').filter({ hasText: /^A$/ }).click();
    await page.locator('.cm-content:visible').filter({ hasText: sentence }).waitFor();
    const beforeReload = await readCounters(page);
    report.data.reload.result = await forceReload(page, { arm });
    await page.locator('.vault-switcher').waitFor();
    await page.locator('.cm-content:visible').filter({ hasText: sentence }).waitFor();
    await assert('reload restored A on screen', true, await page.locator('.cm-content:visible').innerText().then(text => text.includes(sentence)));
    await assert('reload retained A on disk', disk, await readWitness(page, { name: 'Toolbox Vault', path: 'A.md', report }));
    await assert('no page errors', [], errors);
    const afterReload = await readCounters(page);
    report.data.counters = { beforeReload, afterReload };
    const all = [...startupCounters.records.filter(r => !['createWritable', 'close'].includes(r.op)), ...beforeReload.records, ...afterReload.records];
    await assert('A write count across switching and restore', 1, all.filter(r => r.op === 'createWritable' && r.path === aPath && r.ok).length);
    await assert('A close count across switching and restore', 1, all.filter(r => r.op === 'close' && r.path === aPath && r.ok).length);
    await assert('no removal across switching and restore', 0, all.filter(r => r.op === 'removeEntry').length);
    await assert('no workers across switching and restore', 0, all.filter(r => r.op === 'workerStart').length);
    await fontsReady(page);
    report.data.screenshot = resolve(options.scratch, 'reports', `${report.data.name}-${report.data.runId}.png`);
    await page.screenshot({ path: report.data.screenshot });
    await resetCounters(page);
    await page.locator('.tree-item').filter({ hasText: /^Opaque(?:\.epub)?$/ }).click();
    const iframe = page.locator('iframe.epub-reader-frame');
    await iframe.waitFor();
    const frame = page.frameLocator('iframe.epub-reader-frame');
    await frame.getByText('Opaque frame witness is visible.', { exact: true }).waitFor();
    await assert('EPUB control uses the sandboxed reader', 'allow-scripts', await iframe.getAttribute('sandbox'));
    await assert('EPUB control has an opaque origin', 'null', await frame.locator('body').evaluate(() => self.origin));
    if (initMutant) await assert('subframe missing-FSA fault actually applied', ['undefined', 'undefined', 'undefined'],
        await frame.locator('body').evaluate(() => [typeof FileSystemHandle, typeof FileSystemDirectoryHandle, typeof FileSystemFileHandle]));
    await assert('host-only counters do not enter the opaque realm', false, await frame.locator('body').evaluate(() => '__bmeCounters' in window));
    await assert('no page errors after opaque EPUB open', [], errors);
    const epubCounters = await readCounters(page);
    await assert('EPUB frame control never writes', 0, epubCounters.records.filter(record => record.op === 'createWritable').length);
    await assert('EPUB frame control really starts its workers', true, epubCounters.records.some(record => record.op === 'workerStart'));
    report.data.epubControl = { counterScope: 'after note-restore witness', counters: epubCounters,
        loss: 'window-only instrumentation; frame and worker contents belong to V-01b',
        screenshot: resolve(options.scratch, 'reports', `${report.data.name}-epub-${report.data.runId}.png`) };
    await frame.locator('body').evaluate(async () => { await document.fonts.ready; });
    await fontsReady(page);
    await page.screenshot({ path: report.data.epubControl.screenshot });
} catch (error) {
    report.fail(error);
} finally {
    if (requests) report.data.requests = await requests.read().catch(error => { report.fail(error); return []; });
    requests?.stop();
    if (binding) await binding.check().catch(error => report.fail(error));
    await binding?.stop().catch(error => report.fail(error));
    await session?.close().catch(error => report.fail(error));
    await app?.stop().catch(error => report.fail(error));
    console.log(await report.finish());
}
if (!report.data.passed) process.exitCode = 1;
