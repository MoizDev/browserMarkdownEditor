#!/usr/bin/env node
import { resolve } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { prepareApp, serveApp } from '../lib/serve.mjs';
import { openBrowser } from '../lib/browser.mjs';
import { installVault, seedVault, readWitness } from '../lib/vault.mjs';
import { installCounters, resetCounters } from '../lib/counters.mjs';
import { instrumentTargets } from '../lib/targets.mjs';
import { opaqueFrameEpub } from '../lib/epubFixture.mjs';
import { bindServedBodies } from '../lib/identity.mjs';
import { createReport } from '../lib/report.mjs';
import { fontsReady } from '../lib/input.mjs';

const options = { root: resolve(process.env.BME_ROOT ?? '.'),
    scratch: resolve(process.env.BME_SCRATCH ?? '/Users/adham/Developer/bme-impl/scratch/v-a-targets'),
    port: Number(process.env.BME_PORT ?? 6165), mode: process.env.BME_MODE ?? 'production' };
const debuggingPort = Number(process.env.BME_DEBUG_PORT ?? 6166);
const vaultName = 'Worker Counter Vault';
const pdf = await PDFDocument.create();
pdf.setCreationDate(new Date(0)); pdf.setModificationDate(new Date(0));
pdf.addPage([612, 792]).drawText('Worker instrumentation control', { x: 72, y: 700, size: 18 });
const fixtures = { 'Probe.pdf': await pdf.save(), 'Counter.epub': opaqueFrameEpub(), 'Control.md': 'One native worker file read.\n' };
if (process.argv.includes('--prepare')) {
    await prepareApp(options);
    console.log(resolve(options.scratch, 'prepared.json'));
    process.exit(0);
}
const noRecursion = process.argv.includes('--no-recursion-mutant');
const skipWorker = process.argv.includes('--skip-worker-mutant');
const noAutoAttach = process.argv.includes('--control-auto-attach-off');
const resumeOnly = process.argv.includes('--control-resume-only');
const evaluateControl = ['trivial', 'location', 'name'].find(value => process.argv.includes(`--control-evaluate-${value}`));
if (noRecursion && skipWorker) throw new Error('Choose one target mutant at a time');
const report = await createReport({ ...options, name: `worker-targets-${options.mode}${noRecursion ? '-no-recursion' : skipWorker ? '-skip-worker' : ''}`, fixtures,
    debuggingPort, instrumentationControl: noAutoAttach ? 'auto-attach OFF; not an acceptance run' : resumeOnly ? 'auto-attach ON, resume without evaluate; not an acceptance run' : evaluateControl ? `single evaluate (${evaluateControl}); not an acceptance run` : null, gate: {
        witness: 'real annotated-PDF save and EPUB open, worker replies/Blob reads, one labelled planted OPFS read',
        identity: 'served build binding and every announced worker has a pre-start instrumentation receipt',
        mutant: 'dedicated pdfBuild worker resumed without instrumentation must fail uncounted worker; recursive child arm remains part2',
        falsePass: 'only the window saw activity; require worker-origin records and exact positive worker FS read',
        loss: 'pausing changes timing; frames explicitly deferred; logical termination is not CPU cessation (tail ≤2s)',
    }, expected: { pdfBuilderTargets: 1, appWorkerFileReads: 0, appWorkerFileWrites: 0, plantedFileReads: 1 } });
let app, session, binding, targets;
const assert = async (...args) => { await binding.check(); await targets.check(); report.assert(...args); };
try {
    app = await serveApp({ ...options, build: false });
    report.data.build = app.identity;
    session = await openBrowser({ debuggingPort });
    report.data.browser = session.identity;
    await installVault(session.context, { name: vaultName });
    await installCounters(session.context, { vaultName, postMessages: true, blobReads: true });
    const page = await session.context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    binding = await bindServedBodies(session.context, { identity: app.identity, origin: app.url, buildMode: options.mode, report });
    targets = await instrumentTargets(page, { debuggingPort, vaultName, report, fault: { skipRecursiveAutoAttach: noRecursion, noAutoAttach, resumeOnly, evaluateControl, ...(skipWorker ? { skipWorkerUrl: 'pdfBuild\\.worker' } : {}) } });
    await page.goto(app.url);
    await seedVault(page, { name: vaultName, files: fixtures });
    await resetCounters(page);
    await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
    await page.locator('.vault-switcher').waitFor();
    await page.locator('.tree-item').filter({ hasText: /^Probe(?:\.pdf)?$/ }).click();
    await page.locator('.pdf-viewer-page canvas:visible').first().waitFor();
    report.data.pdfViewerMounted = true;
    report.data.headerButtons = await page.locator('.editor-slot-header button').evaluateAll(buttons => buttons.map(button => ({ aria: button.getAttribute('aria-label'), tooltip: button.dataset.tooltip, text: button.textContent })));
    await fontsReady(page);
    await page.locator('.editor-slot-header').getByRole('button', { name: 'Toggle view/annotate mode', exact: true }).click();
    const canvas = page.locator('.tl-container:visible').first();
    await canvas.waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('.tl-container img')].some(image => image.complete && image.naturalWidth > 0));
    await fontsReady(page);
    const box = await canvas.boundingBox();
    if (!box) throw new Error('PDF annotation canvas has no visible box');
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.keyboard.press('d');
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 20 });
    await page.mouse.up();
    await page.locator('.tl-shape[data-shape-type="draw"]').first().waitFor();
    const saved = await readWitness(page, { name: vaultName, path: 'Probe.pdf', binary: true, report,
        afterCompletedCloses: { path: 'Probe.pdf', count: 1, timeoutMs: 30000 } });
    report.data.pdfActionCompleted = { changed: !saved.equals(Buffer.from(fixtures['Probe.pdf'])), bytes: saved.length, pdfHeader: saved.subarray(0, 5).toString() };
    await assert('PDF control saved a changed genuine PDF', true, saved.subarray(0, 5).toString() === '%PDF-' && !saved.equals(Buffer.from(fixtures['Probe.pdf'])));
    await assert('saved PDF still has its page', 1, (await PDFDocument.load(saved)).getPageCount());
    const pdfReadout = await targets.read();
    const builders = pdfReadout.targets.filter(target => target.type === 'worker' && /pdfBuild\.worker/.test(target.url));
    await assert('one actual app PDF builder, not duplicate instrumentation', 1, builders.length);
    await assert('PDF builder emitted a worker reply', true, pdfReadout.records.some(record => record.targetId === builders[0].targetId && record.op === 'postMessage' && record.direction === 'from-worker'));
    report.data.pdfControl = pdfReadout;

    await page.locator('.tree-item').filter({ hasText: /^Counter(?:\.epub)?$/ }).click();
    const frame = page.frameLocator('iframe.epub-reader-frame');
    await frame.getByText('Opaque frame witness is visible.', { exact: true }).waitFor();
    const epubReadout = await targets.read();
    const archives = epubReadout.targets.filter(target => target.type === 'worker' && /archive\.worker/.test(target.url));
    await assert('EPUB archive worker actually mounted', true, archives.length > 0);
    await assert('archive worker reads its immutable Blob', true, epubReadout.records.some(record => archives.some(target => target.targetId === record.targetId) && record.op === 'blobRead' && record.ok));
    await assert('archive worker emitted a reply', true, epubReadout.records.some(record => archives.some(target => target.targetId === record.targetId) && record.op === 'postMessage' && record.direction === 'from-worker'));
    const workerFs = epubReadout.records.filter(record => record.targetType === 'worker' && ['getFile', 'createWritable'].includes(record.op));
    await assert('real app workers receive bytes, not filesystem handles', 0, workerFs.length);
    report.data.epubControl = epubReadout;

    // This is explicitly a control OF THE INSTRUMENT, not an app entry point or
    // a claimed feature. Existing app workers correctly perform no FSA reads.
    report.data.plantedControl = { kind: 'instrument control, not an app gate', name: 'bme-opfs-read-control' };
    const nativeRead = await page.evaluate(async ({ vaultName }) => {
        const source = `postMessage({phase:'top-level',instrumented:'__bmeCounters' in globalThis});
        onmessage = async ({data}) => {
            const root = await navigator.storage.getDirectory();
            const dir = await root.getDirectoryHandle(data.vaultName);
            const file = await (await dir.getFileHandle('Control.md')).getFile();
            const text = new TextDecoder().decode(await file.arrayBuffer());
            postMessage({text});
        };`;
        const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
        const worker = new Worker(url, { name: 'bme-opfs-read-control' });
        window.__bmePlantedWorker = { worker, url };
        return new Promise((resolve, reject) => {
            let instrumentedAtTop = false;
            worker.onerror = error => reject(new Error(error.message));
            worker.onmessage = ({ data }) => {
                if (data.phase === 'top-level') { instrumentedAtTop = data.instrumented; return; }
                resolve({ text: data.text, instrumentedAtTop });
            };
            worker.postMessage({ vaultName });
        });
    }, { vaultName });
    await assert('worker prelude precedes its first user instruction', true, nativeRead.instrumentedAtTop);
    await assert('planted native read returns fixture bytes', fixtures['Control.md'], nativeRead.text);
    const all = await targets.read();
    report.data.plantedControl.readout = all;
    const planted = all.targets.filter(target => target.workerName === 'bme-opfs-read-control');
    await assert('exactly one instrument-control target', 1, planted.length);
    const reads = all.records.filter(record => record.op === 'getFile' && record.path === 'Control.md');
    await assert('positive worker FSA control counted once', 1, reads.filter(record => record.targetId === planted[0].targetId && record.ok).length);
    await assert('both top-level and reply messages counted', 2, all.records.filter(record => record.targetId === planted[0].targetId && record.op === 'postMessage' && record.direction === 'from-worker').length);
    const windowReads = all.window.records.filter(record => record.op === 'getFile' && record.path === 'Control.md').length;
    await assert('merged readout contains both window and worker reads', windowReads + 1, reads.length);
    await page.evaluate(() => {
        window.__bmePlantedWorker.worker.terminate();
        URL.revokeObjectURL(window.__bmePlantedWorker.url);
        delete window.__bmePlantedWorker;
    });
    report.data.finalTargets = await targets.check();
    await assert('no unhandled page errors', [], errors);
    report.data.recursionMutant = { requested: noRecursion, status: 'child-worker control and deliberate uninstrumented arm belong to V-01b part2' };
    await fontsReady(page);
    report.data.screenshot = resolve(options.scratch, 'reports', `worker-targets-${report.data.runId}.png`);
    await page.screenshot({ path: report.data.screenshot });
} catch (error) { report.fail(error); }
finally {
    if (targets) await targets.check().catch(error => report.fail(error));
    await targets?.stop().catch(error => report.fail(error));
    if (binding) await binding.check().catch(error => report.fail(error));
    await binding?.stop().catch(error => report.fail(error));
    await session?.close().catch(error => report.fail(error));
    await app?.stop().catch(error => report.fail(error));
    console.log(await report.finish());
}
if (!report.data.passed) process.exitCode = 1;
