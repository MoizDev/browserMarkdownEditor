import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openBrowser } from '../../lib/browser.mjs';
import { installVault, waitForVault } from '../../lib/vault.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const url = option('--url', 'http://localhost:6302/');
const out = option('--out', '/Users/adham/Developer/bme-impl/scratch/c-b/C-17a/run');
const theme = option('--theme', 'light');
const candidate = args.includes('--mirror');
const consoleOnly = args.includes('--console-only');
const { browser, context, identity } = await openBrowser({ contextOptions: { viewport: { width: 1440, height: 900 } } });
await installVault(context, { name: 'lm-vault' });
const page = await context.newPage();
const result = { url, browser: identity, theme, ok: false };
const keys = ['theme', 'editorFontSize', 'tabSize', 'vaultSessions', 'fileScrollAnchors'];
await mkdir(out, { recursive: true });
await page.addInitScript(theme => {
    if (!sessionStorage.getItem('lm-fixture-seeded')) {
        localStorage.setItem('theme', theme);
        localStorage.setItem('editorFontSize', '22');
        localStorage.setItem('tabSize', '7');
        sessionStorage.setItem('lm-fixture-seeded', '1');
    }
}, theme);
const report = { data: result };
async function mirrorHas(expected) {
    await waitForVault(page, expected => new Promise((resolve, reject) => {
        const request = indexedDB.open('bme-local-mirror');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction('entries', 'readonly');
            const all = tx.objectStore('entries').getAll();
            all.onsuccess = () => { db.close(); const values = new Map(all.result.map(entry => [entry.key, entry.value])); resolve(Object.entries(expected).every(([key, value]) => values.get(key) === value)); };
            all.onerror = () => { db.close(); reject(all.error); };
        };
    }), { arg: expected, report });
}
async function hideSnapshot() {
    const blank = await context.newPage();
    await blank.goto('about:blank');
    await blank.bringToFront();
    await page.bringToFront();
    await blank.close();
}
try {
    await page.goto(url);
    await page.evaluate(async () => {
        const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('lm-vault', { create: true });
        for (const name of ['alpha', 'beta', 'gamma']) {
            const stream = await (await root.getFileHandle(`${name}.md`, { create: true })).createWritable();
            await stream.write(`# ${name}\n\n` + Array.from({ length: 400 }, (_, i) => `Paragraph ${i} in ${name}.\n\n`).join(''));
            await stream.close();
        }
    });
    await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
    for (const name of ['alpha', 'beta', 'gamma']) {
        await page.locator(`.tree-item[data-path="${name}.md"]`).click();
        await page.waitForFunction(name => document.querySelector('.cm-content')?.textContent.includes(`Paragraph 0 in ${name}`), name);
    }
    const scroller = page.locator('.cm-scroller').filter({ visible: true });
    await scroller.hover();
    await page.mouse.wheel(0, 1500);
    await page.waitForFunction(() => (document.querySelector('.cm-scroller')?.scrollTop ?? 0) > 500);
    await page.waitForFunction(() => localStorage.getItem('fileScrollAnchors')?.includes('gamma.md') && ['alpha.md', 'beta.md', 'gamma.md'].every(name => localStorage.getItem('vaultSessions')?.includes(name)));
    result.before = await page.evaluate(keys => Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)])), keys);
    if (candidate) {
        await page.waitForFunction(() => localStorage.getItem('bme.lsMirror') !== null);
        // Hide is a real lifecycle checkpoint for not-yet-migrated writers.
        await hideSnapshot();
        await mirrorHas(result.before);
    }
    assert.equal(result.before.theme, theme);
    assert.equal(result.before.editorFontSize, '22');
    assert.equal(result.before.tabSize, '7');
    if (!consoleOnly) await page.screenshot({ path: path.join(out, 'before.png'), fullPage: true });
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.locator('.vault-switcher').waitFor();
    if (candidate) await page.getByText('Settings restored after another tab reset them', { exact: true }).waitFor();
    result.after = await page.evaluate(keys => Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)])), keys);
    await page.screenshot({ path: path.join(out, 'after.png'), fullPage: true });
    assert.deepEqual(result.after, result.before, 'settings, sessions and scroll records must survive the clear');
    if (args.includes('--notice-api')) {
        // App already consumed the notice; an additional take must be empty.
        result.notice = await page.evaluate(async () => {
            const storage = await import('/src/utils/storage.ts');
            return { first: storage.takeRestoreNotice(), second: storage.takeRestoreNotice() };
        });
        assert.deepEqual(result.notice, { first: null, second: null });
    }
    if (candidate) {
        const resetter = await context.newPage();
        await resetter.route('**/external-reset', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><p>Another window</p>' }));
        await resetter.goto(new URL('external-reset', url).href);
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await resetter.evaluate(() => localStorage.clear());
        await page.bringToFront();
        const size = page.locator('.setting-row').filter({ hasText: 'Editor font size' }).locator('input[type="range"]');
        await size.focus();
        await size.press('ArrowRight');
        await page.waitForFunction(() => localStorage.getItem('theme') !== null && localStorage.getItem('tabSize') !== null && localStorage.getItem('vaultSessions')?.includes('alpha.md'));
        assert.equal(await page.evaluate(() => localStorage.getItem('editorFontSize')), '23', 'live-window setting wins over backup');
        await page.locator('.settings-close-btn').click();
        await resetter.close();
        await page.reload();
        await page.locator('.vault-switcher').waitFor();
        assert.equal(await page.evaluate(() => localStorage.getItem('editorFontSize')), '23');
        result.twoWindows = true;

        // This is an actual application removeItem path, not a fake deletion.
        await page.evaluate(() => localStorage.setItem('terminalFontSize', '20'));
        // A real reload also exercises the legacy-writer reconciliation after
        // first paint; headless tab activation need not change visibilityState.
        await page.reload();
        await page.locator('.vault-switcher').waitFor();
        await mirrorHas({ terminalFontSize: '20' });
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await page.getByRole('button', { name: 'Reset to Defaults', exact: true }).click();
        assert.equal(await page.evaluate(() => localStorage.getItem('terminalFontSize')), null);
        await page.reload();
        await page.locator('.vault-switcher').waitFor();
        await mirrorHas({ terminalFontSize: null });
        await page.evaluate(() => localStorage.clear());
        await page.reload();
        await page.locator('.vault-switcher').waitFor();
        assert.equal(await page.evaluate(() => localStorage.getItem('terminalFontSize')), null, 'removed font key must not resurrect');
        result.tombstone = true;
        await page.screenshot({ path: path.join(out, 'dark-restored.png'), fullPage: true });
    }
    result.ok = true;
} catch (error) {
    result.error = error.stack;
    console.error(`FAIL storage-restore ${error.message.replace(/\s+/g, ' ')}`);
    process.exitCode = 1;
} finally {
    if (!consoleOnly) await writeFile(path.join(out, 'report.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
    await browser.close();
}
