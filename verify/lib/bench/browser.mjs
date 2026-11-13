// The only browser/toolbox adapter. Timed sessions never attach paused targets.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { join, resolve, extname, relative } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { processMemory } from './machine.mjs';
import { scratch } from './lock.mjs';
import { median } from './stats.mjs';
const pin = JSON.parse(await readFile(fileURLToPath(new URL('../../browser-pin.json', import.meta.url)), 'utf8'));
const chromeVersion = pin.version;
const chromePath = join(scratch, 'browsers', chromeVersion, pin.executable);
const sentinel = 'Benchmark sentinel cedar seven forty two';
const vaultName = 'benchmark-vault';
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
    '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
export async function buildIdentity(dist) {
    const files = [];
    async function walk(folder) {
        for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            const path = join(folder, entry.name);
            if (entry.isSymbolicLink()) throw new Error(`Build contains a symlink: ${path}`);
            if (entry.isDirectory()) await walk(path);
            else if (entry.isFile()) {
                const bytes = await readFile(path);
                files.push({ path: relative(dist, path), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
            }
        }
    }
    await walk(dist);
    if (!files.some(f => f.path === 'index.html') || !files.some(f => f.path.endsWith('.js'))) throw new Error(`Not a built app: ${dist}`);
    return { dist, sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'), files };
}
async function serve(dist, port, identity) {
    const root = resolve(dist);
    const server = createServer(async (request, response) => {
        try {
            if (/^https?:\/\//.test(request.url)) { response.writeHead(403).end(); return; }
            const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
            if (pathname === '/__bench_reset') {
                response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }).end('<!doctype html><body>Scenario reset</body>'); return;
            }
            const path = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
            if (!path.startsWith(`${root}/`)) { response.writeHead(403).end(); return; }
            const bytes = await readFile(path);
            response.writeHead(200, { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream',
                'Cache-Control': 'public, max-age=3600', 'X-BME-Build': identity.sha256 });
            response.end(bytes);
        } catch { response.writeHead(404).end(); }
    });
    // Chrome cancels refused proxy CONNECT sockets during startup. ECONNRESET is
    // expected here, not an uncaught process crash that strands the method lock.
    server.on('connection', socket => socket.on('error', () => {}));
    server.on('clientError', (_error, socket) => socket.destroy());
    server.on('connect', (_request, socket) => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'));
    await new Promise((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', accept); });
    return { url: `http://127.0.0.1:${port}`, close: () => new Promise((accept, reject) => server.close(e => e ? reject(e) : accept())) };
}
async function drainTrace(cdp, path) {
    const complete = new Promise(accept => cdp.once('Tracing.tracingComplete', accept));
    await cdp.send('Tracing.end');
    const { stream } = await complete;
    const { open } = await import('node:fs/promises');
    const file = await open(path, 'wx');
    try {
        for (;;) {
            const { data, base64Encoded, eof } = await cdp.send('IO.read', { handle: stream });
            await file.write(base64Encoded ? Buffer.from(data, 'base64') : data);
            if (eof) break;
        }
    } finally { await file.close(); await cdp.send('IO.close', { handle: stream }); }
}
async function session(chromium, profile, url, artifacts, priming, expectedBuild) {
    const context = await chromium.launchPersistentContext(profile, { executablePath: chromePath, headless: true,
        viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'UTC',
        proxy: { server: url, bypass: '127.0.0.1,localhost' } });
    try {
        const browser = context.browser();
        if (!browser || !browser.version().includes(chromeVersion)) throw new Error(`Expected Chrome ${chromeVersion}; got ${browser?.version()}`);
        const page = context.pages()[0] ?? await context.newPage();
        const browserCDP = await browser.newBrowserCDPSession();
        const cdp = await context.newCDPSession(page);
        const pageErrors = [], network = [], cacheEvents = [], cacheResponses = [], outsideRequests = [];
        page.on('pageerror', error => pageErrors.push(error.message));
        // Playwright routing disables HTTP cache, silently making a warm arm cold.
        // Instead a loopback-only rejecting proxy blocks all non-loopback requests
        // without interception; neither remote fonts nor any vault data leave here.
        page.on('request', request => {
            if (new URL(request.url()).origin !== url) outsideRequests.push(request.url());
        });
        await page.addInitScript(({ vaultName, sentinel }) => {
            const grant = handle => {
                handle.queryPermission = async () => 'granted'; handle.requestPermission = async () => 'granted'; return handle;
            };
            const getDir = FileSystemDirectoryHandle.prototype.getDirectoryHandle;
            FileSystemDirectoryHandle.prototype.getDirectoryHandle = async function (...args) { return grant(await getDir.apply(this, args)); };
            window.showDirectoryPicker = async () => grant(await (await navigator.storage.getDirectory()).getDirectoryHandle(vaultName, { create: true }));
            const data = { rafTimes: [], longTasks: [], hookEvents: [], start: null, end: null, hooked: false };
            window.__benchObservation = data;
            new PerformanceObserver(list => data.longTasks.push(...list.getEntries().map(x => ({ startTime: x.startTime, duration: x.duration }))))
                .observe({ type: 'longtask', buffered: true });
            document.addEventListener('click', event => {
                if (event.target.closest('button')?.textContent.trim() !== 'Open Vault' || data.start !== null) return;
                data.start = performance.now(); performance.mark('bme-open-vault-start');
                const frame = time => {
                    data.rafTimes.push(time);
                    const node = document.querySelector('.cm-content');
                    const box = node?.getBoundingClientRect();
                    if (node?.textContent.includes(sentinel) && box?.width > 0 && box?.height > 0 && getComputedStyle(node).visibility !== 'hidden') {
                        requestAnimationFrame(() => {
                            data.end = performance.now(); performance.mark('bme-first-note-paint');
                            performance.measure('bme-open-to-paint', 'bme-open-vault-start', 'bme-first-note-paint');
                        });
                    } else requestAnimationFrame(frame);
                };
                requestAnimationFrame(frame);
            }, true);
        }, { vaultName, sentinel });
        await cdp.send('Network.enable');
        cdp.on('Network.loadingFinished', event => network.push(event));
        cdp.on('Network.requestServedFromCache', event => cacheEvents.push(event));
        cdp.on('Network.responseReceived', ({ requestId, response }) => {
            cacheResponses.push({ requestId, url: response.url, fromDiskCache: response.fromDiskCache,
                fromServiceWorker: response.fromServiceWorker, fromPrefetchCache: response.fromPrefetchCache });
        });
        const response = await page.goto(url, { waitUntil: 'networkidle' });
        if (!response?.ok() || response.headers()['x-bme-build'] !== expectedBuild) throw new Error('Built server identity header mismatch');
        await page.getByRole('button', { name: 'Open Vault', exact: true }).waitFor();
        const fixture = await page.evaluate(async ({ vaultName, sentinel }) => {
            const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(vaultName, { create: true });
            const note = await dir.getFileHandle('first-note.md', { create: true });
            const text = `# ${sentinel}\n\nNon-default browser benchmark fixture.\n`;
            const writer = await note.createWritable(); await writer.write(text); await writer.close();
            // One read before every session: warm disk only, deliberately no cold-disk claim.
            const bytes = await (await note.getFile()).arrayBuffer();
            return { text, sha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('') };
        }, { vaultName, sentinel });
        await page.evaluate(() => document.fonts.ready);
        const memoryBefore = await processMemory(browserCDP);
        const display = await page.evaluate(() => ({ width: screen.width, height: screen.height,
            viewport: { width: innerWidth, height: innerHeight }, dpr: devicePixelRatio, colorDepth: screen.colorDepth }));
        const refreshIntervals = await page.evaluate(() => new Promise(accept => {
            const times = []; const tick = t => { times.push(t); if (times.length === 31) accept(times.slice(1).map((x, i) => x - times[i])); else requestAnimationFrame(tick); };
            requestAnimationFrame(tick);
        }));
        await cdp.send('Tracing.start', { transferMode: 'ReturnAsStream', categories: 'devtools.timeline,disabled-by-default-devtools.timeline.frame,blink.user_timing,disabled-by-default-devtools.screenshot' });
        let observation, actionError;
        try {
            await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
            const row = page.locator('.tree-item').filter({ has: page.locator('.tree-item-label', { hasText: /^first-note(?:\.md)?$/ }) });
            await row.click();
            await page.waitForFunction(() => window.__benchObservation.end !== null);
            await page.evaluate(() => document.fonts.ready);
            if (!(await page.locator('.cm-content').innerText()).includes(sentinel)) throw new Error('First-note witness missing');
            if (pageErrors.length) throw new Error(`App errors: ${pageErrors.join('; ')}`);
            observation = await page.evaluate(() => ({ ...window.__benchObservation,
                mutations: performance.getEntriesByName('bme-mutant-delay').map(x => ({ startTime: x.startTime, duration: x.duration })),
                resources: performance.getEntriesByType('resource').map(x => ({ name: x.name, transferSize: x.transferSize, encodedBodySize: x.encodedBodySize })) }));
            try { await page.screenshot({ path: join(artifacts, 'first-note.png') }); }
            catch (error) { error.invalidCause = `missing capture: ${error.message}`; throw error; }
        } catch (error) { actionError = error; }
        try { await drainTrace(cdp, join(artifacts, 'trace.json')); }
        catch (error) { error.invalidCause = `missing trace: ${error.message}`; actionError ??= error; }
        if (actionError) throw actionError;
        const tracePath = join(artifacts, 'trace.json');
        const trace = JSON.parse(await readFile(tracePath, 'utf8'));
        const traceEvents = trace.traceEvents ?? [];
        if (!['bme-open-vault-start', 'bme-first-note-paint'].every(name => traceEvents.some(event => event.name === name))) {
            throw new Error('Trace is missing the measured input/paint witness marks');
        }
        const traceFrames = {};
        for (const event of traceEvents.filter(x => ['DrawFrame', 'BeginFrame'].includes(x.name))) {
            const key = `${event.name}/${event.pid}/${event.tid}`;
            (traceFrames[key] ??= []).push(event.ts / 1000);
        }
        const traceFrameIntervals = Object.fromEntries(Object.entries(traceFrames).map(([key, times]) => {
            const unique = [...new Set(times)].sort((a, b) => a - b);
            return [key, unique.slice(1).map((x, i) => x - unique[i])];
        }));
        const memoryAfter = await processMemory(browserCDP);
        const values = [observation.end - observation.start];
        if (!values.every(x => Number.isFinite(x) && x > 0)) throw new Error('Invalid observed metric');
        const result = { values, captures: [join(artifacts, 'first-note.png')],
            witness: { text: sentinel, fixture, screenshot: join(artifacts, 'first-note.png') },
            browserVersion: browser.version(), display, refreshIntervals, refreshRateHz: 1000 / median(refreshIntervals),
            observation, trace: tracePath, traceFrameIntervals,
            rafFrameIntervals: observation.rafTimes.slice(1).map((x, i) => x - observation.rafTimes[i]),
            measuredLongTasks: observation.longTasks.filter(x => x.startTime < observation.end && x.startTime + x.duration > observation.start),
            fetchedBytesThroughCapture: network.reduce((sum, x) => sum + x.encodedDataLength, 0),
            network, cacheEvents, cacheResponses, outsideRequests, memoryBefore, memoryAfter,
            hooks: { applicable: false, reason: 'Hook-free V-04 open-path metric; C9 coverage gates NOT covered' },
            scrollCalibration: { applicable: false, reason: 'No wheel input in this metric (VER-03)' } };
        if (priming) {
            // Reset only the scenario's app state, not HTTP/code/shader caches or OPFS.
            // This warm gate measures Open Vault, not restored-session startup (V-08).
            await page.goto(`${url}/__bench_reset`);
            await page.evaluate(async () => {
                localStorage.clear();
                await Promise.all((await indexedDB.databases()).map(db => new Promise((accept, reject) => {
                    const request = indexedDB.deleteDatabase(db.name);
                    request.onsuccess = accept; request.onerror = () => reject(request.error);
                    request.onblocked = () => reject(new Error('Priming state reset blocked'));
                })));
            });
        }
        return result;
    } finally { await context.close(); }
}
export async function openVaultAdapter(config, reportDir) {
    const require = createRequire(import.meta.url);
    const driverVersion = JSON.parse(await readFile(require.resolve('playwright/package.json'), 'utf8')).version;
    if (driverVersion !== '1.63.0') throw new Error(`Expected pinned Playwright 1.63.0, got ${driverVersion}`);
    const { chromium } = await import('playwright');
    await stat(chromePath);
    const identities = {}, servers = {};
    let mutant;
    try {
        for (const [i, arm] of ['A', 'B'].entries()) {
            identities[arm] = await buildIdentity(config.arms[arm].dist);
            servers[arm] = await serve(config.arms[arm].dist, 6200 + i, identities[arm]);
        }
        if (config.methodCheck && identities.A.sha256 !== identities.B.sha256) {
            mutant = JSON.parse(await readFile(join(config.arms.B.dist, 'bench-mutant.json'), 'utf8'));
            if (mutant.kind !== 'measured-open-path-delay' || mutant.controlBuild !== identities.A.sha256
                || mutant.intendedFraction !== 0.1 || !(mutant.delayMs > 0)) throw new Error('Wrong/unidentified open-path mutant');
        }
    } catch (error) { await Promise.all(Object.values(servers).map(s => s.close())); throw error; }
    return { identities, driverVersion, expectedBrowserVersion: chromeVersion, browserPin: pin,
        async measure({ arm, artifacts, temperature }) {
            const profileRoot = join(reportDir, 'profiles'); await mkdir(profileRoot, { recursive: true });
            const profile = await mkdtemp(join(profileRoot, `${arm}-`));
            try {
                let prime;
                if (temperature === 'warm') {
                    const primeArtifacts = join(artifacts, 'prime'); await mkdir(primeArtifacts);
                    prime = await session(chromium, profile, servers[arm].url, primeArtifacts, true, identities[arm].sha256);
                }
                const measured = await session(chromium, profile, servers[arm].url, artifacts, false, identities[arm].sha256);
                // CfT can omit requestServedFromCache for a disk hit. Resource
                // Timing's same-origin transfer=0/body>0 is the independent witness.
                const appScript = measured.observation.resources.find(x => x.name.startsWith(servers[arm].url) && x.name.endsWith('.js'));
                measured.httpCacheWitness = { resource: appScript, cached: appScript?.transferSize === 0 && appScript?.encodedBodySize > 0 };
                if (!appScript || measured.httpCacheWitness.cached !== (temperature === 'warm')) throw new Error('Cold/warm HTTP cache identity witness failed');
                const delays = measured.observation.mutations;
                if (config.methodCheck && (arm === 'A' || !mutant) && delays.length) throw new Error('Unexpected mutant delay in a control arm');
                if (mutant && arm === 'B' && (delays.length !== 1 || delays[0].duration < mutant.delayMs)) throw new Error('Mutant busy-wait witness missing/short');
                return { ...measured, temperature, priming: prime ?? null,
                    profilePolicy: 'Fresh persistent profile per independent session; warm restarts it after one discarded prime; scenario state reset, caches and OPFS retained.' };
            } finally { await rm(profile, { recursive: true, force: true }); }
        },
        async validate(report) {
            if (!mutant) return;
            const samples = report.sessions.filter(s => s.arm === 'B' && s.measurement && (s.validity.valid || config.mode === 'exploratory'));
            const measuredDelayMs = median(samples.map(s => s.measurement.observation.mutations[0].duration));
            report.mutantWitness = { ...mutant, measuredDelayMs,
                delayFractionOfCurrentControl: measuredDelayMs / report.result.medians.A,
                observedRelativeShift: report.result.interval.estimate,
                expectedFraction: 0.10, nearTolerance: 0.03 };
            // A rejected 30% slowdown does not prove rejection of the required 10%.
            // Keep the results, but do not sign off a miscalibrated method witness.
            if (config.mode === 'accepted' && (Math.abs(report.mutantWitness.delayFractionOfCurrentControl - 0.10) > 0.03
                || Math.abs(report.mutantWitness.observedRelativeShift - 0.10) > 0.03)) {
                throw new Error('UNPROVEN method: mutant shift is not near 10% (+/-3 percentage points); recalibrate the scratch mutant, never the gate');
            }
        },
        async recheck() {
            for (const arm of ['A', 'B']) {
                if ((await buildIdentity(config.arms[arm].dist)).sha256 !== identities[arm].sha256) throw new Error(`Build ${arm} changed during the run`);
            }
        },
        async close() { await Promise.all(Object.values(servers).map(s => s.close())); },
    };
}
