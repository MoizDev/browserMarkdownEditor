import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const [url, artifactArg, identityPath] = process.argv.slice(2);
assert(url && artifactArg && identityPath, 'Usage: node verify/core/C-03/reproduce.mjs URL ARTIFACT_DIR BUILD_IDENTITY');
const build = JSON.parse(await readFile(identityPath, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const artifacts = resolve(artifactArg);
await mkdir(artifacts, { recursive: true });
const driver = createRequire(import.meta.url)('playwright/package.json').version;
assert.equal(driver, '1.63.0');
const browser = await chromium.launch({ headless: true, executablePath: '/Users/adham/Developer/bme-impl/scratch/browsers/157.0.8103.39/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' });
const identity = { browser: browser.version(), driver, commit: build.commit, mode: build.mode, tree: build.tree, url, idbShim: false, excludedCloses: 'fixture/outside writes' };
assert.equal(identity.browser, '157.0.8103.39');
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
const scripts = [];
const scriptReads = [];
const scriptErrors = [];
page.context().on('response', response => {
    if (response.request().resourceType() === 'script' || /javascript/.test(response.headers()['content-type'] ?? '')) {
        scriptReads.push(response.body().then(body => {
            const path = decodeURIComponent(new URL(response.url()).pathname).replace(/^\//, '');
            const sha256 = hash(body);
            scripts.push({ url: response.url(), path, sha256 });
            if (sha256 !== build.files[path]) scriptErrors.push(`Served script identity mismatch: ${path}`);
        }).catch(error => scriptErrors.push(error.message)));
    }
});
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
await page.addInitScript(() => {
    const paths = new WeakMap();
    const grant = handle => {
        handle.queryPermission = async () => 'granted';
        handle.requestPermission = async () => 'granted';
        return handle;
    };
    const root = navigator.storage.getDirectory.bind(navigator.storage);
    navigator.storage.getDirectory = async () => {
        const handle = await root();
        paths.set(handle, '');
        return grant(handle);
    };
    const childPath = (parent, name) => [paths.get(parent) ?? `?${parent.name}`, name].filter(Boolean).join('/');
    const getDirectory = FileSystemDirectoryHandle.prototype.getDirectoryHandle;
    FileSystemDirectoryHandle.prototype.getDirectoryHandle = async function (name, ...args) {
        const handle = await getDirectory.call(this, name, ...args);
        paths.set(handle, childPath(this, name));
        return grant(handle);
    };
    const getFile = FileSystemDirectoryHandle.prototype.getFileHandle;
    FileSystemDirectoryHandle.prototype.getFileHandle = async function (name, ...args) {
        const handle = await getFile.call(this, name, ...args);
        paths.set(handle, childPath(this, name));
        return handle;
    };
    window.__pick = 'A';
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle(window.__pick);
    delete window.FileSystemObserver;
    const witness = window.__assetWitness = { external: false, writes: [], closes: [], attempts: [], removed: [], holdA: false, held: false, readRetries: 0 };
    const createWritable = FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable = async function (...args) {
        const path = paths.get(this) ?? `?${this.name}`;
        const appWrite = !witness.external;
        if (appWrite) witness.writes.push({ path, t: performance.now() });
        const writable = await createWritable.apply(this, args);
        if (appWrite) {
            const close = writable.close.bind(writable);
            writable.close = async (...args) => {
                await close(...args);
                if (path === 'A/a.md' && witness.holdA) {
                    witness.held = true;
                    await new Promise(resolve => { window.__releaseAWrite = resolve; });
                }
                witness.closes.push({ path, t: performance.now() });
            };
        }
        return writable;
    };
    const remove = FileSystemDirectoryHandle.prototype.removeEntry;
    FileSystemDirectoryHandle.prototype.removeEntry = async function (name, ...args) {
        const path = childPath(this, name);
        const appRemove = !witness.external;
        if (appRemove) witness.attempts.push({ path, t: performance.now() });
        // Invoke the real removal immediately: the wrapper must not introduce
        // an await between the app's final guard and the native call.
        const result = await remove.call(this, name, ...args);
        if (appRemove) witness.removed.push({ path, t: performance.now() });
        return result;
    };
});

async function seed() {
    await page.evaluate(async () => {
        window.__assetWitness.external = true;
        try {
            const root = await navigator.storage.getDirectory();
            for (const [name, notes] of Object.entries({ A: { 'a.md': '# A\n![[x.png]]\n', 'neighbour.md': '# neighbour\n![[x.png]]\n' }, B: { 'other.md': '# unrelated\n' } })) {
                const vault = await root.getDirectoryHandle(name, { create: true });
                for (const [name, text] of Object.entries(notes)) {
                    const writable = await (await vault.getFileHandle(name, { create: true })).createWritable();
                    await writable.write(text);
                    await writable.close();
                }
            }
            const vault = await root.getDirectoryHandle('A');
            const assets = await vault.getDirectoryHandle('.Assets', { create: true });
            const writable = await (await assets.getFileHandle('x.png', { create: true })).createWritable();
            await writable.write(Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='), char => char.charCodeAt(0)));
            await writable.close();
        } finally { window.__assetWitness.external = false; }
    });
}
async function pick(name) {
    await page.evaluate(name => { window.__pick = name; }, name);
    const open = page.getByRole('button', { name: 'Open Vault', exact: true });
    if (await open.isVisible()) await open.click();
    else await page.locator('.vault-switcher').dblclick();
    await page.waitForFunction(name => document.querySelector('.vault-switcher')?.getAttribute('aria-label') === `Switch vault — ${name}`, name);
}
async function snapshot() {
    return page.evaluate(async () => {
        const vault = await (await navigator.storage.getDirectory()).getDirectoryHandle('A');
        const exists = async path => {
            try {
                const parts = path.split('/');
                let dir = vault;
                for (const name of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(name);
                await dir.getFileHandle(parts.at(-1));
                return true;
            } catch (error) { if (error.name === 'NotFoundError') return false; throw error; }
        };
        const read = async name => {
            for (let attempt = 0; ; attempt++) {
                try { return await (await (await vault.getFileHandle(name)).getFile()).text(); }
                catch (error) {
                    if (error.name !== 'NotReadableError' || attempt >= 3) throw error;
                    window.__assetWitness.readRetries++;
                    await new Promise(resolve => setTimeout(resolve, 25));
                }
            }
        };
        return { live: await exists('.Assets/x.png'), retired: await exists('.Garbage/.Assets/x.png'), neighbour: await read('neighbour.md'), saved: await read('a.md'), witness: window.__assetWitness };
    });
}

let entered = false;
try {
    const response = await page.goto(url);
    if (response?.status() !== 200 || hash(await response.body()) !== build.files['index.html']) {
        const error = new Error('Missing app URL or HTML identity mismatch');
        error.invalid = true;
        throw error;
    }
    entered = true;
    await seed();
    await pick('A');
    await page.locator('.tree-item').filter({ hasText: /^a$/ }).click();
    await page.locator('.cm-content').waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('.cm-content img')].some(img => img.complete && img.naturalWidth > 0));
    await page.keyboard.press('Meta+e');
    await page.locator('.cm-content[contenteditable="true"]').waitFor();
    await page.evaluate(() => { window.__assetWitness.holdA = true; });
    await page.locator('.cm-content').click();
    await page.keyboard.press('Meta+a');
    await page.keyboard.insertText('# removed\n');
    await page.locator('.tab-dirty-dot').waitFor();
    await pick('B');
    await page.waitForFunction(() => window.__assetWitness.held);
    await page.evaluate(() => window.__releaseAWrite());
    await page.waitForFunction(() => window.__assetWitness.removed.some(event => event.path === 'A/.Assets/x.png'), null, { timeout: 10000 });
    try {
        await page.waitForFunction(() => window.__assetWitness.closes.filter(event => event.path === 'A/a.md').length >= 1, null, { polling: 25, timeout: 10000 });
    } catch (error) { error.invalid = true; error.harness = true; throw error; }
    const state = await snapshot();
    await page.screenshot({ path: join(artifacts, 'after-switch.png') });
    await Promise.all(scriptReads);
    if (scriptErrors.length) {
        const error = new Error(scriptErrors.join('; '));
        error.invalid = true;
        throw error;
    }
    await writeFile(join(artifacts, 'observation.json'), JSON.stringify({ ...identity, state, errors, scripts }, null, 2));
    assert.deepEqual(errors, []);
    assert.equal(state.saved, '# removed\n');
    assert.equal(state.neighbour, '# neighbour\n![[x.png]]\n');
    assert(state.witness.removed.some(event => event.path === 'A/.Assets/x.png'), 'The native source removal must actually complete');
    assert.equal(state.retired, true, 'The recoverable retired copy must exist');
    if (!state.live) {
        console.error('FAIL D05-preservation shared old-vault asset was retired after switching vaults');
        process.exitCode = 1;
    } else assert.fail('The unfixed reproduction did not reproduce D05');
} catch (error) {
    await page.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {});
    await writeFile(join(artifacts, 'invalid.json'), JSON.stringify({ ...identity, error: error.stack, errors, witness: await page.evaluate(() => window.__assetWitness).catch(() => null) }, null, 2));
    const invalid = error.invalid || !entered;
    console.error(`${invalid ? 'INVALID' : 'FAIL'} D05-${invalid ? (error.harness ? 'harness' : 'identity') : 'flow'} ${error.message}`);
    process.exitCode = invalid ? 2 : 1;
} finally { await browser.close(); }
