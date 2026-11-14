import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { counts, driver, fullTree, launch, opened, option, pick, seed, url } from './browser.mjs';

const resultPath = option('--result');
const result = { url, driver, cases: [], ok: true };
for (const scenario of ['iterator-error', 'hidden-styles-reuse']) {
    const { browser, page, errors } = await launch();
    const item = { scenario, browser: browser.version(), ok: false };
    try {
        if (scenario === 'iterator-error') {
            await seed(page, 'walk-old', { 'ready.md': '# old vault\n' });
            await seed(page, 'walk-broken', { 'broken/a.md': '# first\n', 'broken/b.md': '# second\n', 'safe/ok.md': '# safe\n' });
            await seed(page, 'walk-next', { 'after.md': '# next vault\n' });
            await pick(page, 'walk-old');
            assert.equal(await opened(page, 'walk-old'), true);
            await page.evaluate(() => { window.__walkFault = { name: 'broken', after: 1 }; });
            await pick(page, 'walk-broken');
            await page.waitForFunction(() => window.__walkFault === null && window.__walk.active === 0);
            assert.equal(await page.getByRole('button', { name: 'Switch vault — walk-old', exact: true }).isVisible(), true, 'failed walk must keep the old root');
            assert.deepEqual(await page.locator('.nav-files-container .tree-item[data-path]').evaluateAll(rows => rows.map(row => row.dataset.path)), ['ready.md'], 'no partial replacement tree may publish');
            await pick(page, 'walk-next');
            assert.equal(await opened(page, 'walk-next'), true, 'next vault must open in the same app');
            item.tree = await fullTree(page, ['after.md']);
        } else {
            const name = 'walk-reuse';
            await seed(page, name, {
                'stable/kept.md': '# kept\n',
                'stable/.appearance.json': JSON.stringify({ version: 2, entries: { 'kept.md': { color: 'red' } }, icons: {} }),
                'elsewhere/start.md': '# start\n',
                '.Assets/hidden.md': '# hidden asset\n',
                '.Garbage/hidden.md': '# hidden trash\n',
                '.git/hidden.md': '# hidden git\n',
                'stable/.Assets/hidden.md': '# nested hidden\n',
            });
            await pick(page, name);
            assert.equal(await opened(page, name), true);
            await fullTree(page, ['elsewhere', 'elsewhere/start.md', 'stable', 'stable/kept.md']);
            await page.waitForFunction(() => window.__walkObserverActive > 0);
            await page.waitForFunction(() => document.querySelector('.tree-item[data-path="stable/kept.md"] .tree-item-icon')?.style.getPropertyValue('--entry-color').includes('--folder-red'));
            item.color = await page.evaluate(() => {
                const icon = document.querySelector('.tree-item[data-path="stable/kept.md"] .tree-item-icon svg');
                const expected = document.createElement('span');
                expected.style.color = getComputedStyle(document.documentElement).getPropertyValue('--folder-red');
                return { actual: getComputedStyle(icon).color, expected: expected.style.color };
            });
            assert.equal(item.color.actual, item.color.expected, 'captured folder appearance must actually colour the icon');
            await page.evaluate(() => {
                window.__keptRow = document.querySelector('.tree-item[data-path="stable/kept.md"]');
                window.__keptMutations = 0;
                window.__keptObserver = new MutationObserver(records => { window.__keptMutations += records.length; });
                window.__keptObserver.observe(window.__keptRow, { attributes: true, childList: true, characterData: true, subtree: true });
            });
            await seed(page, name, { 'elsewhere/new.md': '# external change\n' });
            await page.locator('.tree-item[data-path="elsewhere/new.md"]').waitFor({ state: 'attached' });
            item.reuse = await page.evaluate(() => ({ sameRow: window.__keptRow === document.querySelector('.tree-item[data-path="stable/kept.md"]'), mutations: window.__keptMutations }));
            assert.deepEqual(item.reuse, { sameRow: true, mutations: 0 }, 'unchanged row must retain its DOM without repainting its contents');
            item.tree = await fullTree(page, ['elsewhere', 'elsewhere/new.md', 'elsewhere/start.md', 'stable', 'stable/kept.md']);
            const snapshot = await counts(page);
            for (const hidden of ['.Assets', '.Garbage', '.git']) assert.equal(snapshot.perDir[hidden] ?? 0, 0, `must never enumerate hidden ${hidden}`);
        }
        assert.deepEqual(errors, [], 'unexpected browser errors');
        item.ok = true;
    } catch (error) {
        item.reason = 'hand-count';
        item.error = error.stack;
        result.ok = false;
        console.error(`FAIL hand-count ${scenario} ${error.message.replace(/\s+/g, ' ')}`);
    } finally {
        result.cases.push(item);
        await browser.close();
    }
}
if (resultPath) {
    await mkdir(path.dirname(resultPath), { recursive: true });
    await writeFile(resultPath, JSON.stringify(result, null, 2) + '\n');
}
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 1;
