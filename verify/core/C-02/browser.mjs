import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

export const args = process.argv.slice(2);
export const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const chrome = '/Users/adham/Developer/bme-impl/scratch/browsers/157.0.8103.39/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
export const url = option('--url', 'http://localhost:6301/');
export const driver = createRequire(import.meta.url)('playwright/package.json').version;

export async function launch() {
    assert.equal(driver, '1.63.0', 'use the pinned driver');
    const browser = await chromium.launch({ headless: true, executablePath: chrome });
    try {
    assert.equal(browser.version(), '157.0.8103.39', 'use the pinned browser');
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
        const grant = handle => {
            handle.queryPermission = async () => 'granted';
            handle.requestPermission = async () => 'granted';
            return handle;
        };
        const getDir = FileSystemDirectoryHandle.prototype.getDirectoryHandle;
        FileSystemDirectoryHandle.prototype.getDirectoryHandle = async function (...args) {
            return grant(await getDir.apply(this, args));
        };
        window.__walkObserverActive = 0;
        if (typeof FileSystemObserver === 'function') {
            const active = new Set();
            const tokens = new WeakMap();
            const observe = FileSystemObserver.prototype.observe;
            const disconnect = FileSystemObserver.prototype.disconnect;
            FileSystemObserver.prototype.observe = async function (...args) {
                const token = {};
                tokens.set(this, token);
                const result = await observe.apply(this, args);
                if (tokens.get(this) === token) active.add(this);
                window.__walkObserverActive = active.size;
                return result;
            };
            FileSystemObserver.prototype.disconnect = function (...args) {
                tokens.delete(this);
                active.delete(this);
                window.__walkObserverActive = active.size;
                return disconnect.apply(this, args);
            };
        }
        window.__pickVault = 'walk-fixture';
        window.showDirectoryPicker = async () => grant(await (await navigator.storage.getDirectory()).getDirectoryHandle(window.__pickVault));
        const counts = window.__walk = { started: 0, finished: 0, active: 0, peak: 0, perDir: Object.create(null) };
        const entries = FileSystemDirectoryHandle.prototype.entries;
        FileSystemDirectoryHandle.prototype.entries = async function* (...args) {
            counts.started++;
            counts.active++;
            counts.peak = Math.max(counts.peak, counts.active);
            counts.perDir[this.name] = (counts.perDir[this.name] ?? 0) + 1;
            try {
                let yielded = 0;
                for await (const pair of entries.apply(this, args)) {
                    yield pair;
                    yielded++;
                    if (window.__walkFault?.name === this.name && yielded === window.__walkFault.after) {
                        window.__walkFault = null;
                        throw new DOMException('Injected iterator refusal after one entry', 'NotReadableError');
                    }
                }
            } finally {
                counts.active--;
                counts.finished++;
            }
        };
    });
    await page.goto(url);
    return { browser, context, page, errors };
    } catch (error) {
        await browser.close();
        throw error;
    }
}

export async function seed(page, name, files, directories = []) {
    // This is outside the app path: the same native OPFS calls an external
    // writer would make, with no app module imported or callback invoked.
    await page.evaluate(async ({ name, files, directories }) => {
        const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true });
        const directory = async parts => {
            let dir = root;
            for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
            return dir;
        };
        for (const relative of directories) await directory(relative.split('/'));
        for (const [relative, text] of Object.entries(files)) {
            const parts = relative.split('/');
            const dir = await directory(parts.slice(0, -1));
            const writable = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
            await writable.write(text);
            await writable.close();
        }
    }, { name, files, directories });
}

export async function pick(page, name) {
    await page.evaluate(name => { window.__pickVault = name; }, name);
    const open = page.getByRole('button', { name: 'Open Vault', exact: true });
    await open.or(page.locator('.vault-switcher')).first().waitFor({ state: 'visible' });
    if (await open.isVisible()) await open.click();
    else await page.locator('.vault-switcher').dblclick();
}

export async function opened(page, name, timeout = 5000) {
    const switcher = page.getByRole('button', { name: `Switch vault — ${name}`, exact: true });
    return switcher.waitFor({ state: 'visible', timeout }).then(async () => {
        assert.equal(await page.getByRole('button', { name: 'Open Vault', exact: true }).isVisible(), false, 'welcome screen must be gone');
        return true;
    }, () => false);
}

export const counts = page => page.evaluate(() => structuredClone(window.__walk));
export const treePaths = page => page.locator('.nav-files-container .tree-item[data-path]').evaluateAll(rows => rows.map(row => row.dataset.path));

export async function fullTree(page, manifest) {
    const folders = manifest.filter(relative => !relative.endsWith('.md'));
    if (folders.length) {
        const collapse = page.getByRole('button', { name: 'Collapse all', exact: true });
        if (await collapse.isVisible()) await collapse.click();
        await page.getByRole('button', { name: 'Expand all', exact: true }).click();
    }
    // An empty vault has no last row; its named switcher + absent welcome are
    // its completion witness. Every nonempty fixture requires ALL rows and the
    // final expected row, never a quiet enumeration counter or any early row.
    if (manifest.length) {
        await page.waitForFunction(length => document.querySelectorAll('.nav-files-container .tree-item[data-path]').length === length, manifest.length, { timeout: 60000 });
        await page.locator(`.tree-item[data-path="${manifest.at(-1)}"]`).waitFor({ state: 'attached' });
    }
    const actual = await treePaths(page);
    assert.deepEqual(actual.slice().sort(), manifest.slice().sort(), 'the entire expanded tree must equal the fixture manifest');
    const snapshot = await counts(page);
    assert.equal(snapshot.active, 0, 'no enumerator may remain in flight');
    assert.equal(snapshot.started, snapshot.finished, 'every enumerator must finish');
    assert.ok(snapshot.peak <= 12, `enumeration peak ${snapshot.peak} exceeds the unchanged bound of 12`);
    return { paths: actual, counts: snapshot };
}

export function manifestFor(files, directories = []) {
    const paths = new Set(directories);
    for (const relative of Object.keys(files)) {
        const parts = relative.split('/');
        for (let n = 1; n <= parts.length; n++) paths.add(parts.slice(0, n).join('/'));
    }
    return [...paths].sort();
}
