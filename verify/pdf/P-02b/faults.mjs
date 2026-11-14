// Headless real-app fault gate. No app module imports or app-internal calls.
import { chromium } from 'playwright';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import { CLASSIC_PDF_FAULT_CASES as CASES } from './cases.mjs';
const [url, identityFile, out, name] = process.argv.slice(2);
if (process.argv.length !== 6 || !url || !identityFile || !out || !CASES.includes(name)) throw new Error(`Usage: faults.mjs <url/> <identity.json> <fresh-out> <${CASES.join('|')}>`);
const origin = new URL(url);
if (origin.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(origin.hostname) || !origin.pathname.endsWith('/') || origin.search || origin.hash) throw new Error('Expected loopback production URL ending in /');
const theme = process.env.THEME || 'dark', dpr = Number(process.env.DPR || 1);
if (!['light', 'dark'].includes(theme) || ![1, 2].includes(dpr)) throw new Error('Unknown theme/DPR');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = JSON.parse(await readFile(identityFile, 'utf8'));
if (identity.schema !== 1 || !/^[a-f0-9]{40}$/.test(identity.commit) || !identity.files?.['index.html']) throw new Error('Invalid artifact identity');
const bootstrap = Object.keys(identity.files).filter(file => /\/pdfClassic\.worker-[^/]+\.js$/.test(file));
if (bootstrap.length !== 1) throw new Error('Expected exactly one native bootstrap asset');
const pin = JSON.parse(await readFile(new URL('../../browser-pin.json', import.meta.url), 'utf8'));
const driver = JSON.parse(await readFile(new URL('../../../node_modules/playwright/package.json', import.meta.url), 'utf8')).version;
if (`playwright@${driver}` !== pin.driver || !process.env.LOCAL_JPX_WITNESS) throw new Error('Pinned driver and local JPX metadata are required');
const jpx = JSON.parse(await readFile(process.env.LOCAL_JPX_WITNESS, 'utf8'));
if (jpx.sha256 !== '8996477e14f43e95fb685733a7ac321cdefc86a37207920657bf20d045143701') throw new Error('Positive JPX witness identity mismatch');
if (name === 'large-scan' && !process.env.LARGE_SCAN_WITNESS) throw new Error('Large-scan metadata is required');
const fixture = name === 'large-scan' ? JSON.parse(await readFile(process.env.LARGE_SCAN_WITNESS, 'utf8')) : name === 'decode' ? {
    file: 'bug_jpx.pdf', path: '/Users/adham/Developer/browserMarkdownEditor/planning/00-evidence/pdf/offscreen/downloads/upstream-fixtures/bug_jpx.pdf',
    sha256: '4010d808557a72278368c05518367735ed186cbdd04974b8506275f9ac40f999', provenance: 'rights-unverified local witness',
} : jpx;
if (name === 'large-scan' && (fixture.sha256 !== '39f23ca9c44cf4f07e469d1c91e3ae8ba39a45a82bcf91a3618504a5ca314d44' || fixture.expected?.sourcePixels !== 69612752 || fixture.expected.width * fixture.expected.height !== fixture.expected.sourcePixels)) throw new Error('Authored A3 scan metadata mismatch');
const bytes = await readFile(fixture.path);
if (sha(bytes) !== fixture.sha256) throw new Error('Fixture bytes mismatch');
await mkdir(out);
const report = { gate: 'P-02b', case: name, theme, dpr, application: { commit: identity.commit, mutant: identity.mutant, identitySha256: sha(await readFile(identityFile)) }, verifierSha256: sha(await readFile(new URL(import.meta.url))), casesSha256: sha(await readFile(new URL('./cases.mjs', import.meta.url))), fixture: { file: fixture.file, sha256: fixture.sha256, provenance: fixture.provenance }, arms: [], bodies: [], faults: [], errors: [], console: [], mainScripts: [], workerTargets: [] };
const browser = await chromium.launch({ headless: true, executablePath: `/Users/adham/Developer/bme-impl/scratch/browsers/${pin.version}/${pin.executable}` });
let faultEnabled = true;
const required = ['open', 'source-unchanged'];
const arm = value => { if (report.arms.includes(value)) throw new Error(`Duplicate arm ${value}`); report.arms.push(value); };
try {
    report.browser = browser.version();
    if (report.browser !== pin.version) throw new Error('Wrong browser');
    const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: dpr });
    const page = await context.newPage();
    const pending = [];
    const cdp = await context.newCDPSession(page);
    await cdp.send('Debugger.enable');
    cdp.on('Debugger.scriptParsed', event => { if (/pdf\.worker/.test(event.url)) report.mainScripts.push(event.url); });
    if (name === 'no-eval') {
        let nextId = 0;
        const calls = new Map();
        const sendWorker = (sessionId, method, params = {}) => new Promise((resolve, reject) => {
            const id = ++nextId, key = `${sessionId}:${id}`;
            const timer = setTimeout(() => { calls.delete(key); reject(new Error(`Worker CDP timed out: ${method}`)); }, 10000);
            calls.set(key, { resolve(value) { clearTimeout(timer); resolve(value); }, reject(error) { clearTimeout(timer); reject(error); } });
            void cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(error => { calls.get(key)?.reject(error); calls.delete(key); });
        });
        cdp.on('Target.receivedMessageFromTarget', ({ sessionId, message }) => {
            const packet = JSON.parse(message), key = `${sessionId}:${packet.id}`;
            const call = calls.get(key);
            if (!call) return;
            calls.delete(key);
            if (packet.error) call.reject(new Error(JSON.stringify(packet.error)));
            else call.resolve(packet.result);
        });
        cdp.on('Target.detachedFromTarget', ({ sessionId }) => {
            for (const [key, call] of calls) if (key.startsWith(`${sessionId}:`)) { call.reject(new Error('Worker detached during guard setup')); calls.delete(key); }
        });
        cdp.on('Target.attachedToTarget', event => {
            const setup = { targetId: event.targetInfo.targetId, url: event.targetInfo.url, type: event.targetInfo.type, waitingForDebugger: event.waitingForDebugger, pausedAt: Date.now() };
            report.workerTargets.push(setup);
            void (async () => {
                if (!event.waitingForDebugger) throw new Error('Worker was not paused before guard installation');
                const guard = await sendWorker(event.sessionId, 'Runtime.evaluate', { expression: "(()=>{globalThis.eval=()=>{throw new Error('eval forbidden')};globalThis.Function=new Proxy(globalThis.Function,{apply(){throw new Error('Function forbidden')},construct(){throw new Error('Function forbidden')}});let blocked=false;try{Function('return 1')}catch{blocked=true;globalThis.postMessage({sourceName:'verify-codegen',targetName:'verify-observer',action:'blocked-control'})}return blocked})()", returnByValue: true });
                if (guard.exceptionDetails || guard.result?.value !== true) throw new Error('Worker guard positive control failed');
                await sendWorker(event.sessionId, 'Runtime.runIfWaitingForDebugger');
                setup.pausedMs = Date.now() - setup.pausedAt;
                setup.guardInstalled = true;
                report.faults.push({ action: 'CDP code-generation guard before first worker script', targetId: setup.targetId, pausedMs: setup.pausedMs });
            })().catch(error => { setup.failure = String(error); report.errors.push(`CDP setup: ${error}`); });
        });
        await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: false });
    }
    page.on('pageerror', error => report.errors.push(String(error)));
    page.on('console', message => report.console.push({ type: message.type(), text: message.text() }));
    await context.route('**/*', route => {
        const request = new URL(route.request().url());
        if (request.origin !== origin.origin) return route.abort();
        const file = decodeURIComponent(request.pathname.slice(origin.pathname.length)) || 'index.html';
        const expected = identity.files[file];
        const operation = (async () => {
            try {
                if (faultEnabled && (name === 'codec-retry' || name === 'fallback') && /\/wasm\/openjpeg\.wasm$/.test(file)
                    || faultEnabled && name === 'codec-retry' && /\/wasm\/openjpeg_nowasm_fallback\.js$/.test(file)) {
                    if (!expected) throw new Error('Fault URL is not in the expected runtime tree');
                    report.faults.push({ file, action: 'abort', expectedSha256: expected.sha256 });
                    await route.abort();
                    return;
                }
                const response = await route.fetch();
                const stock = await response.body();
                const actual = { file, sha256: sha(stock), bytes: stock.length, status: response.status(), matches: !!expected && expected.sha256 === sha(stock) && expected.bytes === stock.length && response.status() === 200 };
                report.bodies.push(actual);
                if (!actual.matches) throw new Error(`Unexpected served bytes: ${file}`);
                if (faultEnabled && name === 'startup-csp' && file === 'index.html') {
                    report.faults.push({ file, action: 'worker-src none', expectedSha256: expected.sha256 });
                    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': "worker-src 'none'" } });
                    return;
                }
                if (faultEnabled && file === bootstrap[0] && ['startup-throw', 'startup-stall', 'version', 'message-shape', 'slow-render'].includes(name)) {
                    let body = stock.toString();
                    if (name === 'startup-throw') body = "throw new Error('P02b startup fault');";
                    if (name === 'startup-stall') body = "globalThis.addEventListener('message',()=>{});";
                    if (name === 'version') {
                        const needle = '"6.1.200"';
                        if (body.split(needle).length !== 2) throw new Error('Version fault anchor must match once');
                        body = body.replace(needle, '"0.0.0"');
                    }
                    if (name === 'slow-render') body = "const nativeInstantiate=WebAssembly.instantiate;WebAssembly.instantiate=(...args)=>nativeInstantiate(...args).then(value=>new Promise(resolve=>setTimeout(()=>resolve(value),12000)));\n" + body;
                    if (name === 'message-shape') body = "const p=globalThis.postMessage.bind(globalThis);globalThis.postMessage=(m,...t)=>p(m?.action==='obj'&&m.data?.[2]==='Image'?{...m,data:[...m.data,'unreviewed-shape']}:m,...t);\n" + body;
                    report.faults.push({ file, action: name, stockSha256: sha(stock), servedSha256: sha(body), servedBytes: Buffer.byteLength(body) });
                    await route.fulfill({ response, body });
                    return;
                }
                await route.fulfill({ response });
            } catch (error) { report.errors.push(`binding: ${error}`); await route.abort().catch(() => {}); }
        })();
        pending.push(operation);
        return operation;
    });
    await page.addInitScript(({ theme, noEval }) => {
        localStorage.setItem('theme', theme);
        const grant = handle => { handle.queryPermission = handle.requestPermission = async () => 'granted'; return handle; };
        const getDirectory = FileSystemDirectoryHandle.prototype.getDirectoryHandle;
        FileSystemDirectoryHandle.prototype.getDirectoryHandle = async function (...args) { return grant(await getDirectory.apply(this, args)); };
        window.showDirectoryPicker = async () => grant(await (await navigator.storage.getDirectory()).getDirectoryHandle('pdf-faults', { create: true }));
        window.__pdfFault = { action: 'not-opened', writes: 0, workers: [], messages: [], requests: [], maxAlive: 0, mainCodegenControl: 0, workerCodegenControl: 0, contextPrevented: 'not-observed', delaySeen: false };
        new MutationObserver(() => { if (document.querySelector('[aria-label="PDF rendering delayed"]')) window.__pdfFault.delaySeen = true; }).observe(document, { childList: true, subtree: true });
        document.addEventListener('contextmenu', event => { queueMicrotask(() => { window.__pdfFault.contextPrevented = event.defaultPrevented; }); });
        const writable = FileSystemFileHandle.prototype.createWritable;
        FileSystemFileHandle.prototype.createWritable = function (...args) { window.__pdfFault.writes++; return writable.apply(this, args); };
        const NativeWorker = Worker;
        const updateAlive = () => { const state = window.__pdfFault; state.maxAlive = Math.max(state.maxAlive, state.workers.filter(row => row.constructed && !row.terminated).length); };
        window.Worker = class extends NativeWorker {
            constructor(...args) {
                const row = { id: window.__pdfFault.workers.length, url: String(args[0]), started: performance.now(), constructed: false, terminated: false, errors: 0 };
                window.__pdfFault.workers.push(row);
                try { super(...args); } catch (error) { row.creationError = String(error); throw error; }
                this.__faultRow = row; row.constructed = true; updateAlive();
                this.addEventListener('error', () => { row.errors++; });
                this.addEventListener('message', ({ data }) => {
                    if (data?.sourceName === 'verify-codegen' && data.action === 'blocked-control') window.__pdfFault.workerCodegenControl++;
                    if (data?.sourceName === 'classic-runtime') window.__pdfFault.messages.push({ worker: row.id, action: data.action, data: data.action === 'runtime-ready' ? data.data : null });
                    if (['obj', 'commonobj'].includes(data?.action)) window.__pdfFault.messages.push({ worker: row.id, action: data.action, target: data.targetName, type: data.data?.[data.action === 'obj' ? 2 : 1], page: data.action === 'obj' ? data.data?.[1] : undefined, nullImage: data.data?.[data.action === 'obj' ? 3 : 2] === null });
                });
            }
            postMessage(message, ...rest) {
                if (message?.action === 'GetDocRequest') window.__pdfFault.requests.push({ worker: this.__faultRow.id, docId: message.data?.docId, version: message.data?.apiVersion, at: performance.now() });
                return super.postMessage(message, ...rest);
            }
            terminate() { this.__faultRow.terminated = true; return super.terminate(); }
        };
        const draw = CanvasRenderingContext2D.prototype.drawImage;
        CanvasRenderingContext2D.prototype.drawImage = function (...args) { this.canvas.__faultAction = window.__pdfFault.action; this.canvas.__faultPaint = performance.now(); return draw.apply(this, args); };
        if (noEval) {
            globalThis.eval = () => { throw new Error('eval forbidden'); };
            globalThis.Function = new Proxy(globalThis.Function, { apply() { throw new Error('Function forbidden'); }, construct() { throw new Error('Function forbidden'); } });
            try { Function('return 1'); } catch { window.__pdfFault.mainCodegenControl++; }
        }
    }, { theme, noEval: name === 'no-eval' });
    async function bind() {
        await page.waitForLoadState('networkidle');
        let done = 0;
        while (done < pending.length) { const batch = pending.slice(done); done = pending.length; await Promise.all(batch); }
        if (!report.bodies.length || report.bodies.some(body => !body.matches) || report.errors.some(error => error.startsWith('binding:'))) throw new Error('Raw served-body identity failed');
    }
    const notice = code => page.getByRole(code === 'render-delayed' ? 'status' : 'alert', { name: code === 'render-delayed' ? 'PDF rendering delayed' : 'PDF rendering incomplete', exact: true }).filter({ hasText: code });
    async function ownNoticeContext(code) {
        await page.evaluate(() => { window.__pdfFault.contextPrevented = 'sentinel-before-right-click'; });
        await notice(code).click({ button: 'right', position: { x: 20, y: 20 } });
        await page.waitForFunction(() => typeof window.__pdfFault.contextPrevented === 'boolean');
        if (!await page.evaluate(() => window.__pdfFault.contextPrevented)) throw new Error('New notice left the native context menu enabled');
        arm('own-notice-context'); required.push('own-notice-context');
    }
    async function paint(action) {
        await page.waitForFunction(action => [...document.querySelectorAll('.pdf-pane:not(.pdf-pane-hidden) .pdf-viewer-page > canvas')].some(canvas => canvas.width && canvas.__faultAction === action && performance.now() - canvas.__faultPaint > 200), action, { timeout: 15000 });
        await bind();
        const landmarks = fixture.expected?.landmarks ?? Array.from({ length: 16 }, (_, i) => ({ x: (16 + (i % 4 + 0.5) * 56) / 256, y: (16 + (Math.floor(i / 4) + 0.5) * 56) / 256, dark: (i % 4 + Math.floor(i / 4)) % 2 === 1 }));
        return page.locator('.pdf-pane:not(.pdf-pane-hidden) .pdf-viewer-page > canvas').first().evaluate((canvas, landmarks) => {
            const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
            let ink = 0;
            for (let i = 0; i < data.length; i += 4) if (Math.min(data[i], data[i + 1], data[i + 2]) < 240) ink++;
            const checker = [];
            for (const point of landmarks) {
                const px = Math.floor(point.x * canvas.width), py = Math.floor(point.y * canvas.height);
                const at = (py * canvas.width + px) * 4;
                checker.push((Math.min(data[at], data[at + 1], data[at + 2]) < 128) === point.dark);
            }
            return { width: canvas.width, height: canvas.height, ink, checker, action: canvas.__faultAction };
        }, landmarks);
    }
    await page.goto(url);
    await page.evaluate(async ({ file, data, second }) => {
        const vault = await (await navigator.storage.getDirectory()).getDirectoryHandle('pdf-faults', { create: true });
        for (const name of second ? [file, 'retry-target.pdf'] : [file]) {
            const handle = await vault.getFileHandle(name, { create: true });
            const writable = await handle.createWritable(); await writable.write(new Uint8Array(data)); await writable.close();
        }
    }, { file: fixture.file, data: [...bytes], second: name === 'worker-kill' });
    const seedWrites = await page.evaluate(() => window.__pdfFault.writes);
    if (seedWrites < 1) throw new Error('Write-counter positive control absent');
    await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
    await page.evaluate(() => { window.__pdfFault.writes = 0; window.__pdfFault.action = 'initial-open'; });
    const started = Date.now();
    await page.locator('.tree-item').filter({ hasText: fixture.file }).first().click();
    arm('open');
    if (['startup-csp', 'startup-throw', 'startup-stall', 'version'].includes(name)) {
        const recovery = name === 'startup-csp' ? 'reload-recovery' : 'retry';
        required.push('startup-notice', recovery);
        await notice('worker-startup-failed').waitFor({ timeout: 8000 });
        report.noticeAfterMs = Date.now() - started;
        if (report.noticeAfterMs > 6500) throw new Error('Worker-startup notice missed its deadline');
        await bind();
        arm('startup-notice');
        await ownNoticeContext('worker-startup-failed');
        const before = await page.evaluate(() => window.__pdfFault.workers.length);
        faultEnabled = false;
        if (name === 'startup-csp') {
            // A document's CSP cannot be removed in place; a real reload uses
            // restored response headers and the same stored OPFS vault.
            await page.reload();
            await page.locator('.pdf-pane:not(.pdf-pane-hidden) .pdf-viewer-page > canvas').first().waitFor();
            const result = await page.waitForFunction(() => [...document.querySelectorAll('.pdf-pane:not(.pdf-pane-hidden) .pdf-viewer-page > canvas')].some(c => c.width && c.__faultPaint), undefined, { timeout: 15000 });
            await result.dispose();
            await bind();
        } else {
            await page.evaluate(() => { window.__pdfFault.action = 'retry'; });
            await notice('worker-startup-failed').getByRole('button', { name: 'Try again', exact: true }).click();
            report.afterRetry = await paint('retry');
            if (!report.afterRetry.checker.every(Boolean) || report.afterRetry.ink === 0) throw new Error('Restored startup Retry did not paint the fixture');
            const after = await page.evaluate(() => window.__pdfFault.workers.length);
            if (after !== before + 1) throw new Error('Retry did not create exactly one replacement worker');
        }
        if (await page.getByRole('alert', { name: 'PDF rendering incomplete', exact: true }).count()) throw new Error('Startup notice survived a healthy retry');
        arm(recovery);
    } else if (['decode', 'codec-retry', 'message-shape'].includes(name)) {
        required.push('failure-notice', 'retry');
        const code = name === 'message-shape' ? 'message-contract-failed' : 'image-decode-failed';
        await notice(code).waitFor({ timeout: 15000 });
        await bind(); arm('failure-notice');
        await ownNoticeContext(code);
        const before = await page.evaluate(() => ({ workers: window.__pdfFault.workers.length, requests: window.__pdfFault.requests.length }));
        if (name === 'decode') {
            report.initialPaint = await paint('initial-open');
            await page.getByRole('button', { name: 'Page thumbnails', exact: true }).click();
            await page.getByText('Thumbnail unavailable', { exact: true }).waitFor();
            arm('thumbnail-placeholder'); required.push('thumbnail-placeholder');
        }
        faultEnabled = false;
        await page.evaluate(() => { window.__pdfFault.action = 'retry'; });
        await notice(code).getByRole('button', { name: 'Try again', exact: true }).click();
        if (name === 'decode') {
            await notice(code).waitFor();
            await page.waitForFunction(before => window.__pdfFault.requests.length > before, before.requests);
            report.afterRetry = await paint('retry');
            await page.getByText('Thumbnail unavailable', { exact: true }).waitFor();
        } else {
            report.afterRetry = await paint('retry');
            if (report.afterRetry.ink === 0 || !report.afterRetry.checker.every(Boolean) || await page.getByRole('alert', { name: 'PDF rendering incomplete', exact: true }).count()) throw new Error('Restored-resource Retry is incomplete');
        }
        const after = await page.evaluate(() => window.__pdfFault.workers.length);
        if (after !== before.workers + (name === 'decode' ? 0 : 1)) throw new Error('Healthy Retry reset a worker, or tainted Retry failed to replace it');
        arm('retry');
    } else {
        if (name === 'slow-render') {
            await notice('render-delayed').waitFor({ timeout: 14000 });
            report.delayNoticeAfterMs = Date.now() - started;
            arm('slow-work-notice'); required.push('slow-work-notice');
            await ownNoticeContext('render-delayed');
        }
        report.initialPaint = await paint('initial-open');
        if (!report.initialPaint.ink || !report.initialPaint.checker.every(Boolean)) throw new Error('Positive JPX reference mask did not paint');
        if (await page.getByRole('alert', { name: 'PDF rendering incomplete', exact: true }).count()) throw new Error('Complete fallback/healthy render has a false warning');
        arm('complete-paint'); required.push('complete-paint');
        if (name === 'large-scan') {
            if (fixture.expected.sourcePixels <= 64 * 1024 * 1024 || report.initialPaint.checker.length !== 25) throw new Error('Large-image boundary witness is incomplete');
            report.largeImage = { sourcePixels: fixture.expected.sourcePixels, encoder: fixture.encoder, elapsedMs: Date.now() - started, classification: 'one functional latency sample under shared load, not a benchmark' };
            await notice('render-delayed').waitFor({ state: 'detached' });
            arm('large-image-boundary'); required.push('large-image-boundary');
        }
        if (name === 'slow-render') {
            await notice('render-delayed').waitFor({ state: 'detached' });
            const workers = await page.evaluate(() => window.__pdfFault.workers);
            if (workers.length !== 1 || workers[0].terminated) throw new Error('Watchdog restarted a legitimate slow render');
            report.completedAfterMs = Date.now() - started;
            if (report.completedAfterMs < 12000) throw new Error('Slow-render delay never occurred');
            arm('slow-work-completes-without-restart'); required.push('slow-work-completes-without-restart');
        }
        if (name === 'fallback') {
            const events = await page.evaluate(() => window.__pdfFault.messages);
            if (!events.some(event => event.action === 'asset-load-failed') || !report.faults.some(fault => fault.action === 'abort')) throw new Error('The complete fallback did not actually encounter the asset fault');
            if (!report.bodies.some(body => /openjpeg_nowasm_fallback\.js$/.test(body.file))) throw new Error('JS fallback was not served');
            arm('fallback-diagnostic'); required.push('fallback-diagnostic');
        }
        if (name === 'worker-kill') {
            const targets = await cdp.send('Target.getTargets');
            const workers = targets.targetInfos.filter(target => target.type === 'worker' && target.url.includes('/pdfClassic.worker-'));
            if (workers.length !== 1) throw new Error('Expected exactly one native renderer target');
            report.workerTargets = workers;
            await page.evaluate(() => { window.__pdfFault.action = 'worker-killed'; });
            const runtimeWorkers = page.workers().filter(worker => worker.url().includes('/pdfClassic.worker-'));
            if (runtimeWorkers.length !== 1) throw new Error('Expected one runtime worker handle');
            const closed = runtimeWorkers[0].waitForEvent('close', { timeout: 5000 });
            // CfT 157 rejects Target.closeTarget for dedicated workers. This
            // CDP Runtime.evaluate invokes only the platform's self.close(),
            // then requires the browser's real target-close event as witness.
            await runtimeWorkers[0].evaluate(() => self.close());
            await closed;
            report.workerClosed = true;
            const before = await page.evaluate(() => ({ workers: window.__pdfFault.workers.length, requests: window.__pdfFault.requests.length }));
            await page.evaluate(() => { window.__pdfFault.action = 'demand-after-death'; });
            const demandedAt = Date.now();
            await page.locator('.tree-item').filter({ hasText: 'retry-target.pdf' }).first().click();
            await page.waitForFunction(count => window.__pdfFault.requests.length > count, before.requests);
            await notice('render-delayed').waitFor({ timeout: 14000 });
            report.delayNoticeAfterMs = Date.now() - demandedAt;
            if (report.delayNoticeAfterMs > 12500) throw new Error('No-progress notice missed its bound');
            if (await page.evaluate(() => window.__pdfFault.workers.length) !== before.workers) throw new Error('Watchdog restarted a worker automatically');
            arm('dead-port-no-progress-notice'); required.push('dead-port-no-progress-notice');
            await ownNoticeContext('render-delayed');
            await page.evaluate(() => { window.__pdfFault.action = 'explicit-restart'; });
            await notice('render-delayed').getByRole('button', { name: 'Try again', exact: true }).click();
            report.afterRetry = await paint('explicit-restart');
            if (!report.afterRetry.ink || !report.afterRetry.checker.every(Boolean)) throw new Error('Explicit restart did not restore the page');
            if (await page.evaluate(() => window.__pdfFault.workers.length) !== before.workers + 1) throw new Error('Explicit restart did not create exactly one replacement');
            await notice('render-delayed').waitFor({ state: 'detached' });
            arm('explicit-restart'); required.push('explicit-restart');
        }
    }
    await bind();
    report.state = await page.evaluate(() => window.__pdfFault);
    if (name === 'no-eval' && (report.state.mainCodegenControl !== 1 || report.state.workerCodegenControl !== 1)) throw new Error('Code-generation guards did not prove both realms');
    if (report.state.maxAlive > 1) throw new Error('More than one native worker was concurrently owned');
    if (report.mainScripts.length) throw new Error('The PDF worker module executed in the main realm');
    const unexpectedErrors = report.errors.filter(error => !(name === 'startup-throw' && error.includes('P02b startup fault')));
    if (unexpectedErrors.length) throw new Error(`Unexpected page/binding errors: ${unexpectedErrors.join('; ')}`);
    if (!['decode', 'worker-kill', 'large-scan'].includes(name) && !report.faults.length) throw new Error('Named fault never fired');
    const afterBytes = await page.evaluate(async file => {
        const vault = await (await navigator.storage.getDirectory()).getDirectoryHandle('pdf-faults');
        const handle = await vault.getFileHandle(file);
        return [...new Uint8Array(await (await handle.getFile()).arrayBuffer())];
    }, fixture.file);
    report.afterSha256 = sha(Buffer.from(afterBytes));
    if (name === 'worker-kill') {
        const second = await page.evaluate(async () => {
            const vault = await (await navigator.storage.getDirectory()).getDirectoryHandle('pdf-faults');
            return [...new Uint8Array(await (await (await vault.getFileHandle('retry-target.pdf')).getFile()).arrayBuffer())];
        });
        report.secondSourceSha256 = sha(Buffer.from(second));
        if (report.secondSourceSha256 !== fixture.sha256) throw new Error('Restart changed the second document');
    }
    if (report.afterSha256 !== fixture.sha256 || report.state.writes !== 0) throw new Error('Displaying/retrying the PDF wrote or changed its bytes');
    arm('source-unchanged');
    if (required.length !== report.arms.length || required.some(value => !report.arms.includes(value))) throw new Error('Required fault arm missing');
    await page.screenshot({ path: resolve(out, 'result.png') });
    report.pass = true;
} catch (error) {
    report.failure = String(error);
    for (const context of browser.contexts()) for (const page of context.pages()) {
        await page.screenshot({ path: resolve(out, 'failure.png') }).catch(() => {});
        report.liveNotices = await page.locator('[role="alert"], .pdf-pane-message').allTextContents().catch(() => []);
        report.state = await page.evaluate(() => window.__pdfFault).catch(() => undefined);
    }
    throw error;
} finally { await browser.close(); await writeFile(resolve(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`); }
console.log(JSON.stringify({ case: name, pass: report.pass, arms: report.arms, workerCount: report.state.workers.length }, null, 2));
