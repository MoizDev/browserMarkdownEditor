import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { openPreparedBrowser, servePreparedApp, drainTrace } from '../../lib/bench/browser.mjs';
import { processMemory } from '../../lib/bench/machine.mjs';
import { buildIdentity, bindServedBodies } from '../../lib/identity.mjs';
import { installVault, seedVault, readVaultFile } from '../../lib/vault.mjs';
import { editMode, fontsReady } from '../../lib/input.mjs';
import { seedRestore } from './fixtures.mjs';
import { installObservation, inputPromise, savePromise, hookSnapshot } from './observers.mjs';
import { readTrace, traceFrames, saveBusyTime } from './trace.mjs';
const pin = JSON.parse(await readFile(new URL('../../browser-pin.json', import.meta.url), 'utf8'));
const categories = 'toplevel,devtools.timeline,blink.user_timing,disabled-by-default-devtools.timeline.frame';

async function prepareEditor(page, text, drop) {
    await editMode(page); await page.locator('.cm-content').click();
    // Selecting through the end asks the real editor to parse the full note,
    // then returning to the beginning keeps preparation out of the timed edit.
    await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('ArrowRight');
    if (await page.evaluate(() => !!window.__perf?.editor)) await page.waitForFunction(() => window.__perf.editor.parse.idle, null, { timeout: 30000 });
    await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('ArrowLeft');
    const offset = drop ? text.indexOf('![[save-only.png]]') : 2;
    if (offset < 0) throw new Error('Embed-drop source line missing');
    for (let i = 0; i < offset; i++) await page.keyboard.press('ArrowRight');
    if (drop) for (let i = 0; i < '![[save-only.png]]\n'.length; i++) await page.keyboard.press('Shift+ArrowRight');
    await fontsReady(page);
}
async function keySample(page, key) {
    const pending = page.evaluate(inputPromise);
    await page.waitForFunction(() => window.__v08.input?.armed);
    await page.keyboard.press(key);
    return pending;
}
function networkAt(network, pointEpochMs) {
    return { requests: network.requests.filter(x => x.epochMs <= pointEpochMs).length,
        encodedBodyBytes: network.data.filter(x => x.epochMs <= pointEpochMs).reduce((n, x) => n + x.bytes, 0),
        definition: 'Requests started and encoded body bytes received through boundary; HTTP headers excluded, cached body bytes are not fetched bytes.' };
}
async function session({ profile, host, build, fixture, scenario, artifacts }) {
    const opened = await openPreparedBrowser({ profile, url: host.url });
    const { context, browser, page } = opened;
    let binding, cdp, traceStarted = false;
    const errors = [], workers = [], network = { requests: [], data: [], finished: [] };
    const name = `V08-${scenario}`, drop = scenario === 'save-embed-drop';
    const observationOptions = { startup: scenario !== 'pdf-open', kind: fixture.kind, target: fixture.target, drop,
        expectedText: fixture.text?.split('\n')[0].replace(/^#+\s*/, '') ?? '' };
    try {
        await installVault(context, { name });
        await context.addInitScript(installObservation, observationOptions);
        await page.goto(`${host.url}/__bench_reset`);
        await page.evaluate(async name => {
            localStorage.clear();
            try { await (await navigator.storage.getDirectory()).removeEntry(name, { recursive: true }); }
            catch (error) { if (error.name !== 'NotFoundError') throw error; }
        }, name);
        await seedVault(page, { name, files: fixture.files });
        // One actual read of every generated file; no cold-disk claim.
        await page.evaluate(async ({ name, paths }) => {
            const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
            for (const path of paths) {
                let dir = root; const parts = path.split('/');
                for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
                await (await (await dir.getFileHandle(parts.at(-1))).getFile()).arrayBuffer();
            }
        }, { name, paths: Object.keys(fixture.files) });
        await seedRestore(page, { name, id: `fixture-${scenario}`, target: scenario === 'pdf-open' ? null : fixture.target });
        binding = await bindServedBodies(context, { identity: build, origin: host.url, mode: 'node-refetch', buildMode: build.mode });
        page.on('pageerror', error => errors.push(error.message));
        page.on('worker', worker => workers.push({ url: worker.url(), receivedEpochMs: performance.timeOrigin + performance.now() }));
        cdp = await context.newCDPSession(page);
        const browserCDP = await browser.newBrowserCDPSession();
        await cdp.send('Network.enable');
        let epochOffsetMs = null;
        cdp.on('Network.requestWillBeSent', event => {
            epochOffsetMs ??= event.wallTime * 1000 - event.timestamp * 1000;
            network.requests.push({ url: event.request.url, type: event.type, epochMs: event.wallTime * 1000, id: event.requestId });
        });
        cdp.on('Network.dataReceived', event => network.data.push({ id: event.requestId,
            epochMs: event.timestamp * 1000 + epochOffsetMs, bytes: event.encodedDataLength }));
        cdp.on('Network.loadingFinished', event => network.finished.push(event));
        const memoryBefore = await processMemory(browserCDP);
        await cdp.send('Tracing.start', { transferMode: 'ReturnAsStream', categories }); traceStarted = true;
        await page.goto(host.url, { waitUntil: 'commit' });
        let values, details = {};
        if (scenario === 'pdf-open') {
            const row = page.getByText(fixture.target, { exact: true });
            await row.click({ trial: true }); const box = await row.boundingBox();
            await page.evaluate(() => { window.__v08.armOpen = true; });
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            await page.evaluate(() => window.__v08.documentPromise);
            values = [await page.evaluate(() => window.__v08.firstPixels - window.__v08.openStart)];
        } else {
            await page.evaluate(() => window.__v08.documentPromise);
            if (scenario.startsWith('startup-')) values = [await page.evaluate(() => window.__v08.readable)];
            else if (scenario === 'typing') {
                await prepareEditor(page, fixture.text, false);
                details.input = [];
                for (const key of 'abcdefghijklmnopqrst') details.input.push(await keySample(page, key));
                values = details.input.map(x => x.end - x.start);
            } else if (scenario.startsWith('save-')) {
                await prepareEditor(page, fixture.text, drop);
                details.beforeHooks = await page.evaluate(hookSnapshot);
                const complete = page.evaluate(savePromise);
                await page.waitForFunction(() => window.__v08.save.armed);
                details.input = await keySample(page, drop ? 'Backspace' : 'x');
                await complete;
                // A Node timer does not inject sixty Runtime polling tasks/sec
                // into the renderer whose busy-time sum we are measuring.
                await new Promise(resolve => setTimeout(resolve, 1500));
                await page.evaluate(() => performance.mark('bme-v08-trace-tail'));
            } else if (scenario === 'pdf-scroll') {
                const scroll = page.locator('.pdf-viewer-scroll'); const box = await scroll.boundingBox();
                details.scrollBefore = await scroll.evaluate(el => el.scrollTop);
                const finished = page.evaluate(() => new Promise(resolve => { window.__v08.scroll = { times: [], started: false, finish: false, resolve }; }));
                await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
                for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, 400); await new Promise(resolve => setTimeout(resolve, 16)); }
                await page.evaluate(() => { window.__v08.scroll.finish = true; }); await finished;
                details.scrollAfter = await scroll.evaluate(el => el.scrollTop);
                const times = await page.evaluate(() => window.__v08.scroll.times);
                values = times.slice(1).map((t, i) => t - times[i]);
                if (details.scrollAfter <= details.scrollBefore) throw new Error('PDF wheel did not move the camera');
            } else throw new Error(`Unknown scenario ${scenario}`);
        }
        const observation = await page.evaluate(() => JSON.parse(JSON.stringify(window.__v08, (_key, x) => typeof x === 'function' ? undefined : x)));
        const timeOrigin = await page.evaluate(() => performance.timeOrigin);
        await drainTrace(cdp, join(artifacts, 'trace.json')); traceStarted = false;
        const events = await readTrace(join(artifacts, 'trace.json'));
        if (scenario.startsWith('save-')) {
            details.save = saveBusyTime(events); values = [details.save.busyMs];
            details.savedText = await readVaultFile(page, { name, path: fixture.target });
            const expected = drop ? fixture.text.replace('![[save-only.png]]\n', '') : `${fixture.text.slice(0, 2)}x${fixture.text.slice(2)}`;
            if (details.savedText !== expected) throw new Error('Autosave did not write the exact single-edit result');
            if (observation.fs.filter(x => x.op === 'close').length !== 1) throw new Error('Autosave completed more than one document writable');
        }
        const servedBinding = await binding.check();
        if (errors.length) throw new Error(`App errors: ${errors.join('; ')}`);
        await fontsReady(page);
        const capture = join(artifacts, 'document.png'); await page.screenshot({ path: capture });
        const beforeFirstPixels = networkAt(network, timeOrigin + observation.firstPixels);
        const beforeReadable = networkAt(network, timeOrigin + observation.readable);
        return { values, witness: { scenario, target: fixture.target, fixtureHash: fixture.sha256 }, captures: [capture], trace: join(artifacts, 'trace.json'),
            browserVersion: browser.version(), benchProcessAssociations: opened.benchProcessAssociations,
            display: await page.evaluate(() => ({ viewport: { width: innerWidth, height: innerHeight }, width: screen.width, height: screen.height, dpr: devicePixelRatio })),
            metrics: { firstPixelsMs: observation.firstPixels, readableMs: observation.readable, beforeFirstPixels, beforeReadable,
                longTasksBeforeFirstPixels: observation.longTasks.filter(x => x.startTime < observation.firstPixels),
                longTasksBeforeReadable: observation.longTasks.filter(x => x.startTime < observation.readable),
                workersObservedBeforeFirstPixels: workers.filter(x => x.receivedEpochMs <= timeOrigin + observation.firstPixels),
                workersObservedBeforeReadable: workers.filter(x => x.receivedEpochMs <= timeOrigin + observation.readable) },
            observation, details, network, workers, servedBinding, hooks: await page.evaluate(hookSnapshot),
            resources: await page.evaluate(() => performance.getEntriesByType('resource').map(x => ({ name: x.name, transferSize: x.transferSize, encodedBodySize: x.encodedBodySize }))),
            traceFrameIntervals: traceFrames(events), memoryBefore, memoryAfter: await processMemory(browserCDP),
            loss: 'UNQUALIFIED shared-machine smoke, NOT a baseline. Visual boundaries are DOM/backing-store+rAF proxies; worker time is event-receipt time. No native-disk/photonic latency claim.' };
    } catch (error) {
        await page.screenshot({ path: join(artifacts, 'error.png') }).catch(() => {});
        throw error;
    } finally {
        if (traceStarted) await drainTrace(cdp, join(artifacts, 'incomplete-trace.json')).catch(() => {});
        try { await binding?.stop(); } finally { await opened.close(); }
    }
}
export function baselineAdapter({ prepared, fixture, scenario, modes, metricField = 'readableMs' }) {
    return async (_config, reportDir) => {
        const hosts = {}, identities = Object.fromEntries(['A', 'B'].map(arm => [arm, prepared.builds[modes[arm]]]));
        try {
            for (const [i, arm] of ['A', 'B'].entries()) hosts[arm] = await servePreparedApp(identities[arm].dist, 6206 + i, identities[arm]);
        } catch (error) { await Promise.all(Object.values(hosts).map(h => h.close())); throw error; }
        return { identities, driverVersion: pin.driver.split('@')[1], expectedBrowserVersion: pin.version, browserPin: pin,
            async measure({ arm, artifacts, temperature }) {
                const profiles = join(reportDir, 'profiles'); await mkdir(profiles, { recursive: true });
                const profile = await mkdtemp(join(profiles, `${arm}-`));
                try {
                    const args = { profile, host: hosts[arm], build: identities[arm], fixture, scenario };
                    if (temperature === 'warm') { const prime = join(artifacts, 'prime'); await mkdir(prime); await session({ ...args, artifacts: prime }); }
                    const measured = await session({ ...args, artifacts });
                    measured.metricDefinition = _config.metricDefinition;
                    const script = measured.resources.find(x => x.name.startsWith(hosts[arm].url) && x.name.endsWith('.js'));
                    measured.httpCacheWitness = { resource: script, cached: script?.transferSize === 0 && script?.encodedBodySize > 0 };
                    if (!script || measured.httpCacheWitness.cached !== (temperature === 'warm')) throw new Error('Fresh/primed HTTP cache identity failed');
                    if (scenario.startsWith('startup-')) {
                        const fields = { firstPixelsMs: measured.metrics.firstPixelsMs, readableMs: measured.metrics.readableMs,
                            bytesBeforeFirstPixels: measured.metrics.beforeFirstPixels.encodedBodyBytes,
                            requestsBeforeFirstPixels: measured.metrics.beforeFirstPixels.requests,
                            bytesBeforeReadable: measured.metrics.beforeReadable.encodedBodyBytes,
                            requestsBeforeReadable: measured.metrics.beforeReadable.requests,
                            longTaskMsBeforeFirstPixels: measured.metrics.longTasksBeforeFirstPixels.reduce((n, x) => n + Math.min(x.duration, measured.metrics.firstPixelsMs - x.startTime), 0),
                            longTaskMsBeforeReadable: measured.metrics.longTasksBeforeReadable.reduce((n, x) => n + Math.min(x.duration, measured.metrics.readableMs - x.startTime), 0),
                            workersBeforeFirstPixels: measured.metrics.workersObservedBeforeFirstPixels.length,
                            workersBeforeReadable: measured.metrics.workersObservedBeforeReadable.length };
                        if (!(metricField in fields)) throw new Error(`Unknown startup metric field ${metricField}`);
                        measured.values = [fields[metricField]]; measured.startupFields = fields;
                    }
                    return measured;
                } finally { await rm(profile, { recursive: true, force: true }); }
            },
            async recheck() {
                for (const build of Object.values(identities)) {
                    if ((await buildIdentity({ worktree: prepared.reference, distDir: build.dist })).manifestSha256 !== build.manifestSha256) throw new Error('Prepared reference build changed during run');
                }
            },
            async close() { await Promise.all(Object.values(hosts).map(h => h.close())); },
        };
    };
}
