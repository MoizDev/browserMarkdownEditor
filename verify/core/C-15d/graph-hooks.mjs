import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
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
const report = { fixture, idbShim: false, dpr: 1, arms: {} };
await mkdir(out, { recursive: true });

async function chunks(dir) {
    const result = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) result.push(...await chunks(file));
        else if (/\.(?:js|html)$/.test(file)) result.push([file, await readFile(file, 'utf8')]);
    }
    return result;
}

async function scan(dir, benchmark) {
    const served = await chunks(dir);
    assert(served.length, `no served chunks in ${dir}`);
    const found = served.filter(([, text]) => /__perf|bme-perf-hooks-plant-7f3a|PERF_PLANT/.test(text)).map(([file]) => file);
    assert.equal(found.length > 0, benchmark, `${benchmark ? 'benchmark lacks' : 'production exposes'} the C9 plant/hooks`);
    if (benchmark) assert(served.some(([, text]) => /publications/.test(text)), 'benchmark lacks graph publication hook');
    return { chunks: served.length, plantedChunks: found };
}

async function prepare(context, url) {
    await context.route('**/*', route => {
        const requested = new URL(route.request().url());
        return ['localhost', '127.0.0.1'].includes(requested.hostname) ? route.continue() : route.abort();
    });
    await context.addInitScript(() => {
        // Init scripts also run in initial/opaque frames without a storage API.
        if (typeof FileSystemDirectoryHandle === 'undefined') return;
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

async function arm(browser, name, url, benchmark) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
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
            assert.equal(await page.evaluate(() => '__perf' in window), false, 'production exposes __perf');
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
        if (benchmark) {
            await page.getByRole('button', { name: 'Back to the editor', exact: true }).click();
            const empty = await readGraph(page);
            assert.deepEqual(empty.positions, { ids: [], ring: [] }, 'unmounted graph retains positions');
            assert.deepEqual(empty.edges, [], 'unmounted graph retains edges');
            assert.equal(empty.steps, 0, 'unmounted graph retains step count');
            assert.equal(empty.publications, 0, 'unmounted graph retains publications');
        }
        return data;
    } finally {
        await context.close();
    }
}

let browser;
try {
    if (args['prod-dist']) report.productionScan = await scan(args['prod-dist'], false);
    if (args['bench-dist']) report.benchmarkScan = await scan(args['bench-dist'], true);
    assert(args['bench-url'] || args['prod-url'], 'supply --bench-url=URL and/or --prod-url=URL');
    browser = await chromium.launch({ executablePath: chrome, headless: true });
    report.browser = browser.version();
    if (args['bench-url']) report.arms.benchmark = await arm(browser, 'benchmark', args['bench-url'], true);
    if (args['prod-url']) report.arms.production = await arm(browser, 'production', args['prod-url'], false);
    if (report.arms.benchmark && report.arms.production) {
        const benchmark = report.arms.benchmark, production = report.arms.production;
        assert.deepEqual(benchmark.paint, production.paint, 'benchmark hook perturbs the drawn positions');
        for (const key of ['initialDom', 'initialDisk', 'finalDom', 'finalDisk']) assert.deepEqual(benchmark[key], production[key], `benchmark changes ${key}`);
        assert.deepEqual(await readFile(path.join(out, 'benchmark-settled.png')), await readFile(path.join(out, 'production-settled.png')), 'settled canvas screenshots differ');
    }
    report.result = 'PASS';
} catch (error) {
    report.result = 'FAIL'; report.error = error.stack;
    process.exitCode = 1;
} finally {
    await browser?.close();
    await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
}
