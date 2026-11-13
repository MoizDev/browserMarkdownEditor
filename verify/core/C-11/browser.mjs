import { chromium } from 'playwright';
import assert from 'node:assert/strict';

export const args = Object.fromEntries(process.argv.slice(2).map(arg => {
    const at = arg.indexOf('=');
    return [arg.slice(2, at), arg.slice(at + 1)];
}));
export const url = args.url ?? 'http://localhost:6364/';
export const chrome = '/Users/adham/Developer/bme-impl/scratch/browsers/157.0.8103.39/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

export async function launch(files) {
    const browser = await chromium.launch({ executablePath: chrome, headless: true });
    try { return await openVault(browser, files); }
    catch (error) { await browser.close(); throw error; }
}

async function openVault(browser, files) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    const errors = [];
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    await context.route('**/*', route => ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
    await context.addInitScript(() => {
        if (typeof FileSystemDirectoryHandle === 'undefined') return;
        const grant = handle => {
            handle.queryPermission = async () => 'granted';
            handle.requestPermission = async () => 'granted';
            return handle;
        };
        const getDir = FileSystemDirectoryHandle.prototype.getDirectoryHandle;
        FileSystemDirectoryHandle.prototype.getDirectoryHandle = async function (...a) { return grant(await getDir.apply(this, a)); };
        window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('C11Links', { create: true });
        window.__completedCloses = Object.create(null);
        const createWritable = FileSystemFileHandle.prototype.createWritable;
        FileSystemFileHandle.prototype.createWritable = async function (...a) {
            const handle = this;
            const writable = await createWritable.apply(this, a);
            const close = writable.close.bind(writable);
            writable.close = async (...b) => {
                const result = await close(...b);
                try {
                    const vault = await (await navigator.storage.getDirectory()).getDirectoryHandle('C11Links');
                    const parts = await vault.resolve(handle);
                    if (parts) {
                        const path = parts.join('/');
                        window.__completedCloses[path] = (window.__completedCloses[path] ?? 0) + 1;
                    }
                } catch { /* A moved handle cannot identify a path; the witness times out. */ }
                return result;
            };
            return writable;
        };
        const proto = CanvasRenderingContext2D.prototype;
        const clear = proto.clearRect, move = proto.moveTo, line = proto.lineTo, arc = proto.arc, fill = proto.fill;
        const state = new WeakMap();
        proto.clearRect = function (...a) {
            if (this.canvas.closest('.graph-view')) {
                window.__graphPaint = { nodes: [], edges: [] };
                state.set(this, {});
            }
            return clear.apply(this, a);
        };
        proto.moveTo = function (x, y) {
            if (state.has(this)) state.get(this).move = { x, y };
            return move.call(this, x, y);
        };
        proto.lineTo = function (x, y) {
            if (this.canvas.closest('.graph-view') && state.get(this)?.move) window.__graphPaint.edges.push({ from: state.get(this).move, to: { x, y } });
            return line.call(this, x, y);
        };
        proto.arc = function (...a) {
            if (state.has(this)) state.get(this).arc = { x: a[0], y: a[1], r: a[2] };
            return arc.apply(this, a);
        };
        proto.fill = function (...a) {
            if (this.canvas.closest('.graph-view') && state.get(this)?.arc) window.__graphPaint.nodes.push({ ...state.get(this).arc, color: this.fillStyle });
            return fill.apply(this, a);
        };
    });
    const page = await context.newPage();
    await page.goto(url);
    await page.evaluate(async files => {
        const vault = await (await navigator.storage.getDirectory()).getDirectoryHandle('C11Links', { create: true });
        for (const [path, text] of Object.entries(files)) {
            const parts = path.split('/');
            let dir = vault;
            for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
            const writer = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
            await writer.write(text); await writer.close();
        }
    }, files);
    await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
    await page.locator('.tree-item').first().waitFor();
    return { browser, page, errors };
}

export async function openFile(page, path) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
        const parent = page.locator(`.tree-item[data-path="${parts.slice(0, i).join('/')}"]`);
        const child = page.locator(`.tree-item[data-path="${parts.slice(0, i + 1).join('/')}"]`);
        if (!await child.isVisible()) await parent.click();
    }
    await page.locator(`.tree-item[data-path="${path}"]`).click();
    await page.locator('.cm-content').waitFor();
    await page.waitForFunction(path => document.querySelector('.tab.is-active')?.getAttribute('data-tooltip') === path, path);
}

export async function backlinks(page) {
    await page.locator('.backlinks-toggle').click();
    await page.getByRole('dialog', { name: 'Linked mentions' }).waitFor();
    const result = { count: Number(await page.locator('.backlinks-count').textContent()), sources: await page.locator('.backlink-item').evaluateAll(items => items.map(item => item.getAttribute('data-tooltip')).sort()) };
    await page.getByRole('button', { name: 'Close linked mentions', exact: true }).click();
    return result;
}

export async function graph(page) {
    await page.getByRole('button', { name: 'Neural Brain — graph view', exact: true }).click();
    await page.locator('.graph-canvas-wrap canvas').waitFor();
    await page.mouse.move(0, 0);
    let previous = '', stable = 0;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        const current = await page.evaluate(() => JSON.stringify(window.__graphPaint));
        stable = current && current === previous ? stable + 1 : 0;
        if (stable >= 2) return page.evaluate(() => ({ paint: window.__graphPaint, stats: document.querySelector('.graph-stats').textContent }));
        previous = current;
        await page.waitForTimeout(250);
    }
    throw new Error('graph never settled');
}

export async function editor(page) {
    await page.getByRole('button', { name: 'Back to the editor', exact: true }).click();
    await page.locator('.cm-content').waitFor();
}

export async function saveText(page, path, text) {
    await openFile(page, path);
    if (!await page.locator('.cm-content[contenteditable="true"]').isVisible()) await page.keyboard.press('Meta+e');
    await page.locator('.cm-content').click();
    await page.keyboard.press('Meta+a');
    await page.keyboard.insertText(text);
    const completed = await page.evaluate(path => window.__completedCloses[path] ?? 0, path);
    await page.keyboard.press('Meta+s');
    const witness = await readWitness(page, {
        name: 'in-app save', path,
        afterCompletedCloses: { path, count: completed + 1, timeoutMs: 10000, intervalMs: 50 },
    });
    assert.equal(witness.text, text, `saved bytes differ at ${path}`);
    return witness;
}

// Mirrors V-01a readWitness: fence on successful closes (including seed and
// outside writes), then ONE read, retrying only transient NotReadableError.
export async function readWitness(page, { name, path, report, afterCompletedCloses }) {
    const { path: closePath, count, timeoutMs, intervalMs } = afterCompletedCloses;
    const deadline = Date.now() + timeoutMs;
    let observed = 0;
    while (Date.now() < deadline) {
        observed = await page.evaluate(path => window.__completedCloses[path] ?? 0, closePath);
        if (observed >= count) break;
        await page.waitForTimeout(intervalMs);
    }
    if (observed < count) throw new Error(`HARNESS-FAULT completed-close timeout ${name}: ${closePath} ${observed}<${count}`);
    for (let attempt = 1; attempt <= 3; attempt++) {
        const result = await page.evaluate(async path => {
            try {
                const parts = path.split('/');
                let dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('C11Links');
                for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
                return { text: await (await (await dir.getFileHandle(parts.at(-1))).getFile()).text() };
            } catch (error) { return { error: { name: error.name, message: error.message } }; }
        }, path);
        if (!result.error) {
            const witness = { name, path, afterCompletedCloses, observedCompletedCloses: observed, attempts: attempt, text: result.text };
            if (report) (report.witnesses ??= []).push(witness);
            return witness;
        }
        if (result.error.name !== 'NotReadableError' || attempt === 3) throw new Error(`HARNESS-FAULT readWitness ${path}: ${result.error.name}: ${result.error.message}`);
        await page.waitForTimeout(intervalMs);
    }
}

export async function reload(page) {
    const previous = await activePath(page);
    await page.evaluate(() => { window.__beforeReload = true; });
    await page.reload();
    assert.equal(await page.evaluate(() => window.__beforeReload), undefined, 'hash-only navigation is not a reload');
    await page.locator('.tree-item').first().waitFor();
    if (previous) await page.waitForFunction(path => document.querySelector('.tab.is-active')?.getAttribute('data-tooltip') === path && !!document.querySelector('.cm-content'), previous);
}

export async function activePath(page) {
    return page.locator('.tab.is-active').getAttribute('data-tooltip');
}
