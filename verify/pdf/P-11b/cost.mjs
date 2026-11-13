// Real-UI trace collection, never an in-app timer or a microbenchmark. Advisory
// output cannot pass a timed gate; v-c owns calibration/window admission/statistics.
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { loadavg, freemem } from 'node:os';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { loadIdentityToolbox } from '../lib/identityToolbox.mjs';
import { pdfFixtureManifest, readPdfFixture } from '../lib/fixtures.mjs';

const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i]?.replace(/^--/, ''), value = process.argv[i + 1];
    if (!process.argv[i]?.startsWith('--') || !['fixed-root', 'fixed-dist', 'omit-root', 'omit-dist', 'book', 'dense', 'out', 'chrome', 'sessions', 'phase', 'port'].includes(key) || value === undefined || key in options) throw new Error('Unknown, repeated or missing option');
    options[key] = value;
}
for (const key of ['fixed-root', 'fixed-dist', 'omit-root', 'omit-dist', 'book', 'dense', 'out', 'chrome']) if (!options[key]) throw new Error(`Missing --${key}`);
const phase = options.phase ?? 'advisory', sessions = Number(options.sessions ?? 2), port = Number(options.port ?? 6484);
if (!['advisory', 'calibration', 'window'].includes(phase) || !Number.isInteger(sessions) || sessions < 2 || sessions > 40 || sessions % 2 || !Number.isInteger(port) || port < 6000 || port > 6799) throw new Error('Invalid phase, even sessions/arm (2–40), or allocated run port');
const driver = createRequire(import.meta.url)('playwright/package.json').version;
if (driver !== '1.63.0') throw new Error('Wrong Playwright');
const { buildIdentity, bindServedBodies, toolboxIdentity } = await loadIdentityToolbox();
const localManifest = await pdfFixtureManifest();
const bookManifest = process.env.PDF_BOOK_MANIFEST_COMMIT ? await pdfFixtureManifest(process.env.PDF_BOOK_MANIFEST_COMMIT) : localManifest;
const fixtures = [await readPdfFixture('GEN-P11-dense40', options.dense, localManifest), await readPdfFixture('GEN-18-876', options.book, bookManifest)];
const omitPatch = phase === 'calibration' ? undefined : await readFile(resolve(options['omit-root'], 'verify/pdf/P-11b/mutants/omit-remeasure.patch'));
const fixedIdentity = await buildIdentity({ worktree: options['fixed-root'], distDir: options['fixed-dist'] });
const omitIdentity = phase === 'calibration' ? fixedIdentity : await buildIdentity({ worktree: options['omit-root'], distDir: options['omit-dist'], patch: omitPatch });
if (!fixedIdentity.treeClean || !fixedIdentity.files.length || (phase !== 'calibration' && (omitIdentity.treeClean || !omitIdentity.patchSha256))) throw new Error('Incomplete A/B source identity');
const arms = { fixed: { dist: resolve(options['fixed-dist']), identity: fixedIdentity }, omitted: { dist: resolve(phase === 'calibration' ? options['fixed-dist'] : options['omit-dist']), identity: omitIdentity } };
const out = resolve(options.out), origin = `http://localhost:${port}`;
await mkdir(out, { recursive: true });
let currentArm, currentFixture;
const server = createServer(async (request, response) => {
    try {
        const url = new URL(request.url, origin);
        if (url.pathname === '/__fixture.pdf') { response.writeHead(200, { 'content-type': 'application/pdf' }).end(currentFixture.bytes); return; }
        const root = arms[currentArm].dist, filename = resolve(root, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1)));
        if (!filename.startsWith(root + sep)) { response.writeHead(403).end(); return; }
        const contentType = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.woff2': 'font/woff2' }[extname(filename)] ?? 'application/octet-stream';
        response.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' }).end(await readFile(filename));
    } catch { response.writeHead(404).end(); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, 'localhost', resolve); });
const report = { driver, phase, advisory: phase === 'advisory', acceptance: 'NOT EVALUATED: v-c must admit calibrated sessions under the timing-window bound; no open-path 5% claim', toolbox: toolboxIdentity, builds: { fixed: fixedIdentity, omitted: omitIdentity }, sessionsPerArmPerFixture: sessions, sessions: [], summary: [] };
let browser;
const environment = () => {
    const vm = execFileSync('vm_stat', { encoding: 'utf8' });
    const swapIns = Number(vm.match(/^Swapins:\s+(\d+)/m)?.[1]);
    return { load1: loadavg()[0], freeBytes: freemem(), swapIns, power: execFileSync('pmset', ['-g', 'batt'], { encoding: 'utf8' }).trim() };
};
try {
    browser = await chromium.launch({ headless: true, executablePath: options.chrome, args: ['--host-resolver-rules=MAP fonts.googleapis.com ~NOTFOUND, MAP fonts.gstatic.com ~NOTFOUND'] });
    if (browser.version() !== '157.0.8103.39') throw new Error('Wrong Chrome');
    report.browser = browser.version();
    // ABBA blocks balance browser/OS cache history. Every session has a fresh
    // context; no source override or browser request interception is installed.
    const order = Array.from({ length: sessions / 2 }, () => ['fixed', 'omitted', 'omitted', 'fixed']).flat();
    for (const fixture of fixtures) for (const [sessionIndex, arm] of order.entries()) {
        currentArm = arm; currentFixture = fixture;
        const before = environment();
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, permissions: ['clipboard-read', 'clipboard-write'] });
        const page = await context.newPage(), errors = [];
        const binding = await bindServedBodies(context, { identity: arms[arm].identity, origin, mode: 'node-refetch', buildMode: 'production' });
        page.on('pageerror', error => errors.push(error.message));
        const eager = fixture.admission.pages <= 300;
        await page.addInitScript(({ pages, eager }) => {
            localStorage.setItem('theme', 'dark');
            const grant = handle => { handle.queryPermission = handle.requestPermission = async () => 'granted'; return handle; };
            const getDir = FileSystemDirectoryHandle.prototype.getDirectoryHandle;
            FileSystemDirectoryHandle.prototype.getDirectoryHandle = async function (...args) { return grant(await getDir.apply(this, args)); };
            window.showDirectoryPicker = async () => grant(await (await navigator.storage.getDirectory()).getDirectoryHandle('TextCostVault', { create: true }));
            window.textCost = { phases: [], longTasks: [], eager, pages };
            new PerformanceObserver(list => {
                for (const entry of list.getEntries()) window.textCost.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
            }).observe({ type: 'longtask', buffered: true });
            window.beginTextPhase = (name, targets) => {
                const populated = [...document.querySelectorAll('.pdf-viewer-page .textLayer')].filter(layer => layer.querySelector('span')).length;
                window.textCost.current = { name, targets, initiallyBuilt: populated, first: null, populated: null, settled: null };
                window.textCost.phases.push(window.textCost.current);
            };
            window.beginTextPhase('open', eager ? Array.from({ length: pages }, (_, i) => i) : [0, 1]);
            new MutationObserver(() => {
                const phase = window.textCost.current;
                if (!phase || phase.populated !== null) return;
                const layers = [...document.querySelectorAll('.pdf-viewer-page .textLayer')];
                const populated = layers.filter(layer => layer.querySelector('span')).length;
                if (populated > phase.initiallyBuilt && phase.first === null) {
                    phase.first = performance.now(); console.timeStamp(`P11b:${phase.name}:first`);
                }
                if (phase.targets.every(index => layers[index]?.querySelector('span'))) {
                    phase.populated = performance.now(); phase.built = populated - phase.initiallyBuilt;
                    console.timeStamp(`P11b:${phase.name}:populated`);
                    requestAnimationFrame(() => requestAnimationFrame(() => { phase.settled = performance.now(); console.timeStamp(`P11b:${phase.name}:settled`); }));
                }
            }).observe(document, { childList: true, subtree: true });
        }, { pages: fixture.admission.pages, eager });
        await page.goto(origin);
        await page.evaluate(async file => {
            const vault = await (await navigator.storage.getDirectory()).getDirectoryHandle('TextCostVault', { create: true });
            const write = await (await vault.getFileHandle(file, { create: true })).createWritable();
            await write.write(await (await fetch('/__fixture.pdf')).arrayBuffer()); await write.close();
        }, fixture.file);
        await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
        // Refetch before the timed action, then once after it; never during it.
        await binding.check();
        const cdp = await context.newCDPSession(page);
        await cdp.send('Tracing.start', { categories: 'toplevel,devtools.timeline,disabled-by-default-devtools.timeline,v8,blink.console', transferMode: 'ReturnAsStream' });
        await page.locator('.tree-item').filter({ hasText: fixture.file }).click();
        await page.waitForFunction(() => window.textCost.phases.at(-1).settled !== null);
        if (!eager) {
            for (const [name, physicalPage, targets] of [['middle', 450, [448, 449, 450]], ['last', 876, [874, 875]]]) {
                await page.evaluate(({ name, targets }) => window.beginTextPhase(name, targets), { name, targets });
                const input = page.locator('.pdf-viewer-page-input');
                await input.fill(String(physicalPage)); await input.press('Enter');
                await page.waitForFunction(name => window.textCost.current.name === name && window.textCost.current.settled !== null, name);
            }
        }
        const complete = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
        await cdp.send('Tracing.end');
        const { stream } = await complete;
        const chunks = [];
        for (;;) {
            const part = await cdp.send('IO.read', { handle: stream });
            chunks.push(Buffer.from(part.data, part.base64Encoded ? 'base64' : 'utf8'));
            if (part.eof) break;
        }
        await cdp.send('IO.close', { handle: stream });
        const traceBytes = Buffer.concat(chunks), trace = JSON.parse(traceBytes);
        const basename = `${fixture.id}-${sessionIndex}-${arm}`;
        await writeFile(resolve(out, `${basename}.trace.json`), traceBytes);
        const observations = await page.evaluate(() => window.textCost);
        const tracePhases = observations.phases.map(p => summarizeTrace(trace.traceEvents, p));
        const servedBinding = await binding.check();
        if (errors.length) throw new Error(`App error: ${errors.join('; ')}`);
        const after = environment();
        report.sessions.push({ arm, fixture: fixture.admission, sessionIndex, environment: { before, after, swapInsDelta: after.swapIns - before.swapIns, formalValidity: 'not assessed: run-owned processes, VM, lid/thermal, window and own-gate calibrations belong to v-c' }, observations, tracePhases, trace: `${basename}.trace.json`, servedBinding });
        await binding.stop(); await context.close();
        await writeFile(resolve(out, 'result.json'), JSON.stringify(report, null, 2) + '\n');
    }
    for (const fixture of fixtures) {
        const totals = arm => report.sessions.filter(row => row.arm === arm && row.fixture.id === fixture.id).map(row => ({ populatedMs: row.tracePhases.reduce((n, p) => n + p.populatedMs, 0), scriptingMs: row.tracePhases.reduce((n, p) => n + p.scriptingMs, 0), built: row.tracePhases.reduce((n, p) => n + p.built, 0), longTasks: row.tracePhases.reduce((n, p) => n + p.longTasks.length, 0) }));
        const fixed = totals('fixed'), omitted = totals('omitted');
        const median = values => { const sorted = [...values].sort((a, b) => a - b); return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2; };
        const summarize = values => Object.fromEntries(['populatedMs', 'scriptingMs', 'built', 'longTasks'].map(key => [key, median(values.map(row => row[key]))]));
        const a = summarize(fixed), b = summarize(omitted);
        report.summary.push({ fixture: fixture.id, fixed: a, omitted: b, scriptingDeltaMs: a.scriptingMs - b.scriptingMs, estimatedDeltaPerBuiltLayerMs: (a.scriptingMs - b.scriptingMs) / a.built, populatedDeltaMs: a.populatedMs - b.populatedMs, interpretation: 'Advisory difference of total phase scripting, not an isolated helper timer or confidence/no-regression result' });
    }
} catch (error) {
    report.executionError = error.message; throw error;
} finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    await writeFile(resolve(out, 'result.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report.summary, null, 2));

function summarizeTrace(events, phase) {
    const marker = suffix => events.find(event => event.name === 'TimeStamp' && event.args?.data?.message === `P11b:${phase.name}:${suffix}`);
    const first = marker('first'), populated = marker('populated'), settled = marker('settled');
    if (!first || !populated || !settled || !phase.built) throw new Error(`Missing observed trace phase: ${phase.name}`);
    const main = events.filter(event => event.pid === first.pid && event.tid === first.tid && event.ph === 'X' && event.dur > 0 && event.ts < settled.ts && event.ts + event.dur > first.ts);
    const script = main.filter(event => /^(FunctionCall|EvaluateScript|RunMicrotasks|V8\.RunMicrotasks|v8\.execute|V8\.Execute)$/.test(event.name));
    if (!script.length) throw new Error('No main-thread scripting slices observed');
    const intervals = script.map(event => [Math.max(first.ts, event.ts), Math.min(settled.ts, event.ts + event.dur)]).sort((a, b) => a[0] - b[0]);
    let scriptingUs = 0, end = -Infinity;
    for (const [a, b] of intervals) { scriptingUs += Math.max(0, b - Math.max(a, end)); end = Math.max(end, b); }
    const longTasks = main.filter(event => /RunTask$/.test(event.name) && event.dur >= 50_000).map(event => ({ startUs: event.ts, durationMs: event.dur / 1000 }));
    return { name: phase.name, built: phase.built, populatedMs: (populated.ts - first.ts) / 1000, settledMs: (settled.ts - first.ts) / 1000, scriptingMs: scriptingUs / 1000, scriptingPerLayerMs: scriptingUs / (1000 * phase.built), longTasks, source: 'Union of trace scripting intervals on the timestamp marker thread; no nested-duration double counting' };
}
