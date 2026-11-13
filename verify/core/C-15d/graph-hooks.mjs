import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

// Drives only the real app. An independent OPFS writer saves the link while
// the graph stays mounted; the app's real observer/poll publishes the result.
// Coordinates come from the screenshot/C9, never imported application modules.
const args = Object.fromEntries(process.argv.slice(2).map(a => {
    const at = a.indexOf('=');
    return [a.slice(2, at), a.slice(at + 1)];
}));
const out = path.resolve(args.out ?? '/Users/adham/Developer/bme-impl/scratch/c-e/C-15d');
const chrome = args.chrome ?? '/Users/adham/Developer/bme-impl/scratch/browsers/157.0.8103.39/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const fixture = {
    'A.md': '# A\n\n[[B]]\n',
    'B.md': '# B\n\n[[C]]\n',
    'C.md': '# C\n\n[[D]]\n',
    'D.md': '# D\n\n[[E]]\n',
    'E.md': '# E\n',
};
const ids = Object.keys(fixture);
const edges = [['A.md', 'B.md'], ['B.md', 'C.md'], ['C.md', 'D.md'], ['D.md', 'E.md']];
const require = createRequire(import.meta.url);
const report = { fixture, idbShim: false, dpr: 1, driver: require('playwright/package.json').version, expectedBrowser: '157.0.8103.39', expectedCommit: args.commit, arms: {} };
await mkdir(out, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const anchors = /__perf|bme-perf-hooks-plant-7f3a|PERF_PLANT|get publications\s*\(/;

function fail(reason, detail) {
    const error = new Error(`FAIL ${reason} ${detail}`);
    error.reason = reason;
    throw error;
}

function identity(condition, detail) {
    if (!condition) fail('identity', detail);
}

async function buildIdentity(prefix) {
    const name = prefix === 'bench' ? 'benchmark' : 'production';
    const manifest = JSON.parse(await readFile(args[`${prefix}-identity`], 'utf8'));
    report.arms[name] = { identity: manifest, scripts: [] };
    identity(manifest.commit === args.commit, `${name} commit ${manifest.commit} != ${args.commit}`);
    identity(manifest.mode === (name === 'benchmark' ? 'benchmark' : 'production'), `${name} wrong mode`);
    const expectedPatch = args[`${prefix}-patch`];
    identity(expectedPatch ? manifest.tree.patchSha256 === expectedPatch : manifest.tree.clean === true, `${name} source tree/patch differs`);
    identity(Object.keys(manifest.files).some(file => file.endsWith('.js')), `${name} empty script inventory`);
    return manifest;
}

function observeScripts(context, manifest, url, name) {
    const pending = [], actual = [], observed = new Set();
    const origin = new URL(url).origin;
    context.on('response', response => {
        const request = response.request();
        if (request.resourceType() !== 'script' && !new URL(response.url()).pathname.endsWith('.js')) return;
        pending.push((async () => {
            const bytes = await response.body();
            let owner = 'worker';
            try { owner = request.frame() ? 'page' : 'worker'; } catch { /* Worker requests have no frame. */ }
            actual.push({ url: response.url(), bytes, owner, status: response.status() });
        })().catch(error => { actual.push({ url: response.url(), error: error.message }); }));
    });
    return async () => {
        await Promise.all(pending);
        const scanned = report.arms[name].scripts;
        const check = (record, source) => {
            if (record.error || record.status !== 200) fail('setup', `${name} script response ${record.url}: ${record.error ?? record.status}`);
            identity(new URL(record.url).origin === origin, `${name} script is not from its own origin: ${record.url}`);
            const file = decodeURIComponent(new URL(record.url).pathname).replace(/^\//, '');
            const sha256 = hash(record.bytes);
            if (manifest) identity(manifest.files[file] === sha256, `${name} served body differs from build identity: ${file}`);
            const anchor = record.bytes.toString('utf8').match(anchors)?.[0];
            scanned.push({ url: record.url, file, sha256, source, owner: record.owner, anchor: anchor ?? null });
            observed.add(file);
            if (name === 'production' && anchor) fail('P-anchor', `${anchor} ${record.url}`);
        };
        for (const record of actual) check(record, 'app-request');
        if (manifest) {
            // The manifest is only an inventory/hash identity, never the content
            // oracle: even lazy chunks are fetched from this preview's origin.
            for (const file of Object.keys(manifest.files).filter(file => file.endsWith('.js') && !observed.has(file))) {
                const response = await context.request.get(new URL(file, url).href);
                check({ url: response.url(), bytes: await response.body(), status: response.status(), owner: 'supplemental' }, 'supplemental-browser-context-fetch');
            }
        }
        if (name === 'benchmark' && !scanned.some(script => script.source === 'app-request' && script.anchor)) fail('B-control', 'no anchor in a script the app actually fetched');
    };
}

async function prepare(context, url) {
    await context.route('**/*', route => {
        const requested = new URL(route.request().url());
        return ['localhost', '127.0.0.1'].includes(requested.hostname) ? route.continue() : route.abort();
    });
    await context.addInitScript(() => {
        // Init scripts also run in initial/opaque frames without a storage API.
        if (typeof FileSystemDirectoryHandle === 'undefined') return;
        let perf;
        window.__hookObservation = { rootWrites: 0, reports: 0 };
        Object.defineProperty(window, '__perf', {
            configurable: true,
            get: () => perf,
            set: value => { window.__hookObservation.rootWrites++; perf = value; },
        });
        const dispatch = EventTarget.prototype.dispatchEvent;
        EventTarget.prototype.dispatchEvent = function (event) {
            if (event.detail?.caller && event.detail?.path && typeof event.detail?.seq === 'number') window.__hookObservation.reports++;
            return dispatch.call(this, event);
        };
        const grant = handle => {
            handle.queryPermission = async () => 'granted';
            handle.requestPermission = async () => 'granted';
            return handle;
        };
        const getDir = FileSystemDirectoryHandle.prototype.getDirectoryHandle;
        FileSystemDirectoryHandle.prototype.getDirectoryHandle = async function (...a) {
            return grant(await getDir.apply(this, a));
        };
        window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('C15Graph', { create: true });
        // A draw observer at the platform boundary, independent of C9. It sees
        // the actual canvas arguments; the screenshot remains the pixel oracle.
        const clear = CanvasRenderingContext2D.prototype.clearRect;
        CanvasRenderingContext2D.prototype.clearRect = function (...a) {
            if (this.canvas.closest('.graph-view')) window.__graphPaint = { arcs: [], edges: 0 };
            return clear.apply(this, a);
        };
        const arc = CanvasRenderingContext2D.prototype.arc;
        CanvasRenderingContext2D.prototype.arc = function (...a) {
            if (this.canvas.closest('.graph-view')) window.__graphPaint?.arcs.push(a.slice(0, 3));
            return arc.apply(this, a);
        };
        const line = CanvasRenderingContext2D.prototype.lineTo;
        CanvasRenderingContext2D.prototype.lineTo = function (...a) {
            if (this.canvas.closest('.graph-view') && window.__graphPaint) window.__graphPaint.edges++;
            return line.apply(this, a);
        };
    });
    const page = await context.newPage();
    await page.goto(url);
    await page.evaluate(async files => {
        const vault = await (await navigator.storage.getDirectory()).getDirectoryHandle('C15Graph', { create: true });
        for (const [name, text] of Object.entries(files)) {
            const handle = await vault.getFileHandle(name, { create: true });
            const writer = await handle.createWritable();
            await writer.write(text);
            await writer.close();
        }
    }, fixture);
    await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
    await page.locator('.tree-item').filter({ hasText: /^A$/ }).waitFor();
    await page.getByRole('button', { name: 'Neural Brain — graph view', exact: true }).click();
    await page.locator('.graph-stats').filter({ hasText: '5 notes · 4 links' }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.mouse.move(0, 0);
    return page;
}

async function readGraph(page) {
    return page.evaluate(() => {
        const graph = window.__perf?.graph;
        return graph ? { positions: graph.positions(), edges: graph.snapshot(), publications: graph.publications, steps: graph.steps } : null;
    });
}

async function disk(page) {
    return page.evaluate(async names => {
        const vault = await (await navigator.storage.getDirectory()).getDirectoryHandle('C15Graph');
        return Object.fromEntries(await Promise.all(names.map(async name => [name, await (await (await vault.getFileHandle(name)).getFile()).text()])));
    }, ids);
}

async function pixelCentre(page, png, rgb) {
    return page.evaluate(async ({ encoded, rgb }) => {
        const image = new Image();
        image.src = `data:image/png;base64,${encoded}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0);
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        let count = 0, sumX = 0, sumY = 0;
        for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
            const at = (y * canvas.width + x) * 4;
            if (data[at] === rgb[0] && data[at + 1] === rgb[1] && data[at + 2] === rgb[2] && data[at + 3] === 255) {
                count++; sumX += x + 0.5; sumY += y + 0.5;
            }
        }
        return { count, x: sumX / count, y: sumY / count, width: canvas.width, height: canvas.height };
    }, { encoded: png.toString('base64'), rgb });
}

function projectedA(positions, size) {
    const last = positions.ring.at(-1);
    assert(last, 'no recorded simulation step');
    const degrees = [1, 2, 2, 2, 1];
    const radius = degrees.map(degree => 3 + 26 * (degree / 2) ** 1.7);
    const left = Math.min(...last.x.map((x, i) => x - radius[i]));
    const right = Math.max(...last.x.map((x, i) => x + radius[i]));
    const top = Math.min(...last.y.map((y, i) => y - radius[i]));
    const bottom = Math.max(...last.y.map((y, i) => y + radius[i]));
    const scale = Math.max(0.2, Math.min(2.5, (size.width - 72) / (right - left), (size.height - 72) / (bottom - top)));
    return { x: size.width / 2 + (last.x[0] - (left + right) / 2) * scale, y: size.height / 2 + (last.y[0] - (top + bottom) / 2) * scale };
}

async function saveOutsideApp(page) {
    await page.evaluate(async () => {
        const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('C15Graph');
        const writer = await (await dir.getFileHandle('E.md')).createWritable();
        await writer.write('# E\n\n[[A]]\n');
        await writer.close();
    });
}

async function arm(browser, name, url, manifest) {
    const benchmark = name === 'benchmark';
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const scan = observeScripts(context, manifest, url, name);
    const errors = [];
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    try {
        const page = await prepare(context, url);
        const data = {};
        if (benchmark) {
            const first = await readGraph(page);
            assert(first, 'benchmark graph hook is missing after the real graph opened');
            assert.deepEqual(first.edges, edges);
            assert.deepEqual(first.positions.ids, ids);
            await page.waitForTimeout(500);
            const later = await readGraph(page);
            assert(later.steps > first.steps, 'working simulation steps did not advance in 500 ms');
            await page.waitForFunction(() => window.__perf.graph.steps >= 300);
            const settled = await readGraph(page);
            assert.equal(settled.steps, 300, 'fresh layout did not settle after exactly 300 working steps');
            assert.equal(settled.positions.ring.length, 300);
            assert.deepEqual(settled.positions.ring.map(frame => frame.step), Array.from({ length: 300 }, (_, i) => i + 1));
            for (const frame of settled.positions.ring) {
                assert.equal(frame.x.length, 5); assert.equal(frame.y.length, 5);
                assert(frame.x.every(Number.isFinite) && frame.y.every(Number.isFinite));
            }
            await page.waitForTimeout(1000);
            assert.deepEqual(await readGraph(page), settled, 'steps/positions keep changing after physics rests (frame-count mutant)');
            await page.evaluate(() => {
                const positions = window.__perf.graph.positions();
                positions.ids.reverse(); positions.ring[0].x[0] = 123456;
                window.__perf.graph.snapshot().pop();
            });
            assert.deepEqual(await readGraph(page), settled, 'a caller can mutate simulation/hook data through a read');
            const png = await page.locator('.graph-canvas-wrap canvas').screenshot({ path: path.join(out, `${name}-settled.png`) });
            // A.md hashes to palette index 1, violet #8b5cf6 (hand counted).
            const centre = await pixelCentre(page, png, [139, 92, 246]);
            assert(centre.count > 20, 'sample node has no painted pixels in the screenshot');
            const projected = projectedA(settled.positions, centre);
            assert(Math.hypot(centre.x - projected.x, centre.y - projected.y) <= 1, `painted node differs from reported positions: ${JSON.stringify({ centre, projected })}`);
            data.hook = { first: first.steps, later: later.steps, settled: settled.steps, publications: settled.publications, ring: settled.positions.ring.length, centre, projected };
        } else {
            if (await page.evaluate(() => window.__perf !== undefined)) fail(name === 'dev' ? 'D-hook' : 'P-hook', `${name} exposes __perf`);
            // Production has no step surface. Observe the platform draw arguments
            // stop changing, rather than assuming a fixed duration means settled.
            let stable = false;
            for (let i = 0; i < 30 && !stable; i++) {
                const before = await page.evaluate(() => JSON.stringify(window.__graphPaint));
                await page.waitForTimeout(1000);
                stable = before === await page.evaluate(() => JSON.stringify(window.__graphPaint));
            }
            assert(stable, 'production graph never settled');
            await page.locator('.graph-canvas-wrap canvas').screenshot({ path: path.join(out, `${name}-settled.png`) });
        }
        data.paint = await page.evaluate(() => window.__graphPaint);
        assert.equal(data.paint.arcs.length, 5, 'renderer did not paint five nodes');
        assert.equal(data.paint.edges, 4, 'renderer did not draw the four reported edges');
        data.initialDom = await page.locator('.graph-view').innerText();
        data.initialDisk = await disk(page);
        const publications = benchmark ? (await readGraph(page)).publications : null;
        await saveOutsideApp(page);
        await page.locator('.graph-stats').filter({ hasText: '5 notes · 5 links' }).waitFor({ timeout: 30000 });
        if (benchmark) {
            const changed = await readGraph(page);
            assert.equal(changed.publications, publications + 1, 'one saved topology edit did not publish exactly once');
            assert.deepEqual(changed.edges, [...edges, ['E.md', 'A.md']]);
            data.afterPublications = changed.publications;
        }
        data.finalDom = await page.locator('.graph-view').innerText();
        data.finalDisk = await disk(page);
        assert.deepEqual(errors, [], 'browser raised an application error');
        await page.getByRole('button', { name: 'Back to the editor', exact: true }).click();
        if (benchmark) {
            const empty = await readGraph(page);
            assert.deepEqual(empty.positions, { ids: [], ring: [] }, 'unmounted graph retains positions');
            assert.deepEqual(empty.edges, [], 'unmounted graph retains edges');
            assert.equal(empty.steps, 0, 'unmounted graph retains step count');
            assert.equal(empty.publications, 0, 'unmounted graph retains publications');
        } else {
            data.hooks = await page.evaluate(() => ({ rootUndefined: window.__perf === undefined, keyUndefined: window.__perf?.graph === undefined, ...window.__hookObservation }));
            if (!data.hooks.rootUndefined || !data.hooks.keyUndefined || data.hooks.rootWrites || data.hooks.reports) fail(name === 'dev' ? 'D-hook' : 'P-hook', JSON.stringify(data.hooks));
        }
        await scan();
        Object.assign(report.arms[name], data);
        return data;
    } catch (error) {
        // An anchor leak must keep its own reason even when runtime exposure
        // would also fail. A setup/identity error is never a mutant kill.
        if (!error.reason || ['P-hook', 'D-hook'].includes(error.reason)) await scan();
        if (error.code === 'ERR_ASSERTION') fail(benchmark ? 'hand-count' : name === 'dev' ? 'D-render' : 'P-render', error.message);
        if (error.name === 'TimeoutError') fail(`${name === 'benchmark' ? 'B' : name === 'dev' ? 'D' : 'P'}-flow`, error.message);
        throw error;
    } finally {
        await context.close();
    }
}

let browser;
try {
    for (const key of ['commit', 'prod-url', 'bench-url', 'dev-url', 'prod-identity', 'bench-identity', 'dev-root', 'dev-terminal']) if (!args[key]) fail('setup', `missing --${key}`);
    identity(report.driver === '1.63.0', `Playwright ${report.driver} != 1.63.0`);
    browser = await chromium.launch({ executablePath: chrome, headless: true });
    report.browser = browser.version();
    identity(report.browser === report.expectedBrowser, `Chrome ${report.browser} != ${report.expectedBrowser}`);
    const production = await buildIdentity('prod');
    const benchmark = await buildIdentity('bench');
    // The supervised serve terminal is part of the setup identity, not an app
    // diagnostic route. Its explicit positional Vite root must be this clean tree.
    const root = path.resolve(args['dev-root']);
    const dev = report.arms.dev = { identity: { root, commit: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), status: execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }) }, scripts: [], loss: 'Dev serves source text with dead guarded hook code; text exclusion is not claimed.' };
    const terminal = JSON.parse(execFileSync('hc', ['get', args['dev-terminal']], { encoding: 'utf8' }));
    dev.identity.terminal = terminal;
    identity(dev.identity.commit === args.commit && !dev.identity.status, 'dev worktree is not clean at expected commit');
    identity(terminal.state === 'live' && path.resolve(terminal.cwd) === root && terminal.argv.some((value, i) => value === root && /(?:^|\/)vite$/.test(terminal.argv[i - 1] ?? '')), 'dev terminal does not launch Vite with the expected explicit root');
    identity(terminal.argv[terminal.argv.indexOf('--port') + 1] === new URL(args['dev-url']).port && terminal.argv.includes('--strictPort'), 'dev URL does not match the supervised strict port');
    dev.identity.mode = terminal.argv.includes('--mode') ? terminal.argv[terminal.argv.indexOf('--mode') + 1] : 'development';
    identity(dev.identity.mode === (args['dev-mode'] ?? 'development'), 'dev mode differs from the requested control');
    await arm(browser, 'production', args['prod-url'], production);
    await arm(browser, 'benchmark', args['bench-url'], benchmark);
    await arm(browser, 'dev', args['dev-url'], null);
    const b = report.arms.benchmark, p = report.arms.production;
    try {
        assert.deepEqual(b.paint, p.paint, 'benchmark hook perturbs the drawn positions');
        for (const key of ['initialDom', 'initialDisk', 'finalDom', 'finalDisk']) assert.deepEqual(b[key], p[key], `benchmark changes ${key}`);
        assert.deepEqual(await readFile(path.join(out, 'benchmark-settled.png')), await readFile(path.join(out, 'production-settled.png')), 'settled canvas screenshots differ');
    } catch (error) {
        if (error.code === 'ERR_ASSERTION') fail('PB-parity', error.message);
        throw error;
    }
    report.result = 'PASS';
    console.log('PASS C-15d P/B/D');
} catch (error) {
    report.result = 'FAIL'; report.error = error.stack;
    report.reason = error.reason ?? 'setup';
    console.log(error.reason ? error.message.split('\n')[0] : `FAIL setup ${error.message.split('\n')[0]}`);
    process.exitCode = error.reason && !['setup', 'identity'].includes(error.reason) ? 1 : 2;
} finally {
    await browser?.close();
    await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(`Report: ${path.join(out, 'report.json')}`);
}
