import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

export const driver = createRequire(import.meta.url)('playwright/package.json').version;
export const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
export const original = '# A\n![[x.png]]\n';
export const edited = '# removed\n\n';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function product(reason, condition, detail) { if (!condition) { const error = new Error(detail); error.reason = reason; throw error; } }
export function invalid(detail) { const error = new Error(detail); error.invalid = true; throw error; }
export async function launch() {
    assert.equal(driver, '1.63.0', 'Wrong Playwright driver');
    const browser = await chromium.launch({ headless: true, executablePath: '/Users/adham/Developer/bme-impl/scratch/browsers/157.0.8103.39/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' });
    assert.equal(browser.version(), '157.0.8103.39', 'Wrong Chrome for Testing');
    return browser;
}

export async function session(browser, arm, dir) {
    await mkdir(dir, { recursive: true });
    const build = JSON.parse(await readFile(arm.identity, 'utf8'));
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors = [], scripts = [], pending = new Set(), responseErrors = [];
    const metadata = { browser: browser.version(), driver, commit: build.commit, mode: build.mode, tree: build.tree, identity: arm.identity, idbShim: false, excludedCloses: 'fixture/outside writes' };
    page.on('pageerror', error => errors.push(error.message));
    context.on('response', response => {
        if (response.request().resourceType() !== 'script' && !/javascript/.test(response.headers()['content-type'] ?? '')) return;
        const work = response.body().then(body => {
            const path = decodeURIComponent(new URL(response.url()).pathname).replace(/^\//, '');
            const hash = sha256(body);
            scripts.push({ url: response.url(), path, sha256: hash, source: body.toString('utf8') });
            if (hash !== build.files[path]) responseErrors.push(`Body identity mismatch ${path}`);
        }).catch(error => responseErrors.push(error.message));
        pending.add(work);
        work.finally(() => pending.delete(work)).catch(() => {});
    });
    await page.route('**/*', route => new URL(route.request().url()).origin === new URL(arm.url).origin ? route.continue() : route.abort());
    await page.addInitScript(() => {
        const paths = new WeakMap(), picked = new Map();
        const grant = handle => { handle.queryPermission = async () => 'granted'; handle.requestPermission = async () => 'granted'; return handle; };
        const root = navigator.storage.getDirectory.bind(navigator.storage);
        navigator.storage.getDirectory = async () => { const handle = await root(); paths.set(handle, ''); return grant(handle); };
        const childPath = (parent, name) => [paths.get(parent) ?? `?${parent.name}`, name].filter(Boolean).join('/');
        const getDirectory = FileSystemDirectoryHandle.prototype.getDirectoryHandle;
        FileSystemDirectoryHandle.prototype.getDirectoryHandle = async function (name, ...args) {
            const handle = await getDirectory.call(this, name, ...args); paths.set(handle, childPath(this, name)); return grant(handle);
        };
        const entries = FileSystemDirectoryHandle.prototype.entries;
        FileSystemDirectoryHandle.prototype.entries = async function* (...args) {
            for await (const [name, handle] of entries.apply(this, args)) { paths.set(handle, childPath(this, name)); if (handle.kind === 'directory') grant(handle); yield [name, handle]; }
        };
        const getHandle = FileSystemDirectoryHandle.prototype.getFileHandle;
        FileSystemDirectoryHandle.prototype.getFileHandle = async function (name, ...args) { const handle = await getHandle.call(this, name, ...args); paths.set(handle, childPath(this, name)); return handle; };
        const getFile = FileSystemFileHandle.prototype.getFile;
        FileSystemFileHandle.prototype.getFile = async function (...args) { const file = await getFile.apply(this, args); paths.set(file, paths.get(this) ?? `?${this.name}`); return file; };
        window.__pick = 'A';
        window.showDirectoryPicker = async () => {
            if (!picked.has(window.__pick)) picked.set(window.__pick, await (await navigator.storage.getDirectory()).getDirectoryHandle(window.__pick));
            return picked.get(window.__pick); // deliberately reuse A's exact handle for A→B→A
        };
        delete window.FileSystemObserver;
        const w = window.__assetWitness = { external: false, writes: [], closes: [], attempts: [], removed: [], failedWrites: [], bodyReads: [],
            holdNote: false, noteHeld: false, noteUsed: false, holdCopy: false, copyHeld: false, copyUsed: false,
            holdProof: false, proofHeld: false, proofUsed: false, failWrite: false, failureUsed: false, readRetries: 0 };
        const arrayBuffer = Blob.prototype.arrayBuffer;
        Blob.prototype.arrayBuffer = async function (...args) {
            const path = paths.get(this) ?? '?';
            if (path === 'A/blocker.txt') w.bodyReads.push({ path, t: performance.now() });
            const bytes = await arrayBuffer.apply(this, args);
            if (path === 'A/blocker.txt' && w.holdProof && !w.proofUsed && w.closes.some(row => row.path === 'A/a.md')) {
                w.proofUsed = true; w.proofHeld = true;
                await new Promise(resolve => { window.__releaseProof = resolve; });
            }
            return bytes;
        };
        const createWritable = FileSystemFileHandle.prototype.createWritable;
        FileSystemFileHandle.prototype.createWritable = async function (...args) {
            const path = paths.get(this) ?? `?${this.name}`, app = !w.external;
            if (app) w.writes.push({ path, t: performance.now() });
            const writable = await createWritable.apply(this, args);
            if (app) {
                const write = writable.write.bind(writable), close = writable.close.bind(writable);
                writable.write = async (...args) => {
                    if (path === 'A/a.md' && w.failWrite && !w.failureUsed) {
                        w.failureUsed = true;
                        await writable.abort(); // no disk commit, no leaked writable lease
                        w.failedWrites.push({ path, t: performance.now() });
                        throw new Error('D05 injected write failure before native write');
                    }
                    return write(...args);
                };
                writable.close = async (...args) => {
                    await close(...args);
                    if (path === 'A/a.md' && w.holdNote && !w.noteUsed) {
                        w.noteUsed = true; w.noteHeld = true;
                        await new Promise(resolve => { window.__releaseNote = resolve; });
                    }
                    if (path === 'A/.Garbage/.Assets/x.png' && w.holdCopy && !w.copyUsed) {
                        w.copyUsed = true; w.copyHeld = true;
                        await new Promise(resolve => { window.__releaseCopy = resolve; });
                    }
                    w.closes.push({ path, t: performance.now() });
                };
            }
            return writable;
        };
        const remove = FileSystemDirectoryHandle.prototype.removeEntry;
        FileSystemDirectoryHandle.prototype.removeEntry = async function (name, ...args) {
            const path = childPath(this, name), app = !w.external;
            if (app) w.attempts.push({ path, t: performance.now() });
            const result = await remove.call(this, name, ...args); // no await before the native invocation
            if (app) w.removed.push({ path, t: performance.now() });
            return result;
        };
    });
    const navigation = await page.goto(arm.url);
    if (navigation?.status() !== 200 || sha256(await navigation.body()) !== build.files['index.html']) invalid('Missing URL or HTML identity mismatch');

    async function seed(files) {
        await page.evaluate(async ({ files, png }) => {
            const w = window.__assetWitness; w.external = true;
            try {
                const root = await navigator.storage.getDirectory();
                for (const [name, notes] of Object.entries(files)) {
                    const vault = await root.getDirectoryHandle(name, { create: true });
                    for (const [path, text] of Object.entries(notes)) {
                        let dir = vault;
                        const parts = path.split('/');
                        for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
                        const writable = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable(); await writable.write(text); await writable.close();
                    }
                }
                const assets = await (await root.getDirectoryHandle('A')).getDirectoryHandle('.Assets', { create: true });
                const writable = await (await assets.getFileHandle('x.png', { create: true })).createWritable();
                await writable.write(Uint8Array.from(atob(png), char => char.charCodeAt(0))); await writable.close();
            } finally { w.external = false; }
        }, { files, png: PNG });
    }
    async function pick(name) {
        await page.evaluate(name => { window.__pick = name; }, name);
        const open = page.getByRole('button', { name: 'Open Vault', exact: true });
        if (await open.isVisible()) await open.click(); else await page.locator('.vault-switcher').dblclick();
        await page.waitForFunction(name => document.querySelector('.vault-switcher')?.getAttribute('aria-label') === `Switch vault — ${name}`, name);
    }
    async function open(name, edit = false) {
        await page.locator('.tree-item').filter({ hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }).click();
        await page.locator('.cm-content').waitFor();
        if (edit && await page.locator('.cm-content').getAttribute('contenteditable') !== 'true') {
            await page.keyboard.press('Meta+e'); await page.locator('.cm-content[contenteditable="true"]').waitFor();
        }
    }
    async function replace(text, perKey = false) {
        await page.locator('.cm-content').click(); await page.keyboard.press('Meta+a');
        if (perKey) await page.keyboard.type(text); else await page.keyboard.insertText(text);
        await page.locator('.tab-dirty-dot').first().waitFor();
    }
    async function closeCount(path, count) {
        try { await page.waitForFunction(({ path, count }) => window.__assetWitness.closes.filter(row => row.path === path).length >= count, { path, count }, { timeout: 10000, polling: 25 }); }
        catch (error) { error.invalid = true; throw error; }
    }
    async function waitJob(path = 'a.md', activation = 1, after = 0) {
        try { await page.waitForFunction(({ path, activation, after }) => (window.__perf?.assetJobs?.completed ?? []).slice(after).some(row => row.path === path && row.activation === activation), { path, activation, after }, { timeout: 10000, polling: 25 }); }
        catch (error) { error.reason = 'B-control'; throw error; }
    }
    async function state() {
        return page.evaluate(async () => {
            const a = await (await navigator.storage.getDirectory()).getDirectoryHandle('A');
            async function file(path) {
                let dir = a; const parts = path.split('/');
                try { for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part); return await (await dir.getFileHandle(parts.at(-1))).getFile(); }
                catch (error) { if (error.name === 'NotFoundError') return null; throw error; }
            }
            async function read(path, binary = false) {
                for (let attempt = 0; ; attempt++) {
                    try { const f = await file(path); return f ? (binary ? Array.from(new Uint8Array(await f.arrayBuffer())) : await f.text()) : null; }
                    catch (error) { if (error.name !== 'NotReadableError' || attempt >= 3) throw error; window.__assetWitness.readRetries++; await new Promise(resolve => setTimeout(resolve, 25)); }
                }
            }
            return { live: await read('.Assets/x.png', true), retired: await read('.Garbage/.Assets/x.png', true), a: await read('a.md'), neighbour: await read('neighbour.md'),
                witness: window.__assetWitness, completed: window.__perf?.assetJobs?.completed ?? [] };
        });
    }
    async function outside(path, text) {
        await page.evaluate(async ({ path, text }) => {
            const w = window.__assetWitness; w.external = true;
            try { const a = await (await navigator.storage.getDirectory()).getDirectoryHandle('A'); const writable = await (await a.getFileHandle(path)).createWritable(); await writable.write(text); await writable.close(); }
            finally { w.external = false; }
        }, { path, text });
    }
    async function drainScripts() {
        while (pending.size) await Promise.all([...pending]);
        if (responseErrors.length) invalid(responseErrors.join('; '));
    }
    async function finish(extra) {
        await drainScripts();
        product('D05-render', errors.length === 0, errors.join('; '));
        await page.screenshot({ path: join(dir, 'screen.png') });
        const manifest = scripts.map(row => ({ url: row.url, path: row.path, sha256: row.sha256 }));
        const result = { ...metadata, ...extra, errors, scripts: manifest };
        await writeFile(join(dir, 'report.json'), JSON.stringify(result, null, 2));
        return result;
    }
    return { page, context, build, metadata, scripts, dir, seed, pick, open, replace, closeCount, waitJob, state, outside, finish, drainScripts };
}
