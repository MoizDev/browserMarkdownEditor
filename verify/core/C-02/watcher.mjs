import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { counts, driver, fullTree, launch, manifestFor, opened, option, pick, seed, url } from './browser.mjs';

const resultPath = option('--result');
const { browser, page, errors } = await launch();
const result = { url, driver, browser: browser.version(), idbShim: false, ok: false };
try {
    const name = 'walk-watcher';
    const initial = { 'ready.md': '# ready\n' };
    await seed(page, name, initial);
    await pick(page, name);
    assert.equal(await opened(page, name), true, 'initial vault must open');
    result.observer = await page.evaluate(() => typeof FileSystemObserver === 'function');
    if (!result.observer) throw Object.assign(new Error('native observer unavailable for this arm'), { invalid: true });
    try {
        await page.waitForFunction(() => window.__walkObserverActive > 0, undefined, { timeout: 5000 });
    } catch (error) { throw Object.assign(new Error(`native observer never subscribed: ${error.message}`), { invalid: true }); }
    const before = await counts(page);
    const added = {};
    for (let i = 0; i < 12; i++) added[`Folder${i}/Sub/note.md`] = '# hi\n';
    await seed(page, name, added);
    result.newFolderVisible = await page.locator('.tree-item[data-path="Folder0"]').waitFor({ state: 'attached', timeout: 5000 }).then(() => true, () => false);
    result.counts = await counts(page);
    result.listings = result.counts.started - before.started;
    result.oldReadyVisible = await page.locator('.tree-item[data-path="ready.md"]').isVisible();
    assert.equal(result.newFolderVisible, true, 'new nested folders never reach the tree');
    assert.equal(result.oldReadyVisible, true, 'existing note must remain visible');
    await seed(page, name, { 'after.md': '# a later observer batch\n' });
    await page.locator('.tree-item[data-path="after.md"]').waitFor({ state: 'attached', timeout: 5000 });
    result.afterVisible = true;
    const tree = await fullTree(page, manifestFor({ ...initial, ...added, 'after.md': '# a later observer batch\n' }));
    result.paths = tree.paths;
    result.counts = tree.counts;
    assert.deepEqual(errors, [], 'browser errors');
    result.ok = true;
} catch (error) {
    result.reason = error.invalid ? 'INVALID setup' : 'hand-count';
    result.error = error.stack;
    console.error(`${error.invalid ? 'INVALID setup' : 'FAIL hand-count'} watcher ${error.message.replace(/\s+/g, ' ')}`);
    process.exitCode = error.invalid ? 2 : 1;
} finally {
    if (resultPath) {
        await mkdir(path.dirname(resultPath), { recursive: true });
        await writeFile(resultPath, JSON.stringify(result, null, 2) + '\n');
    }
    console.log(JSON.stringify(result, null, 2));
    await browser.close();
}
