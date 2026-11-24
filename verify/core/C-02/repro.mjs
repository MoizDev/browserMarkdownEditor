import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { args, counts, driver, fullTree, launch, manifestFor, opened, option, pick, seed, url } from './browser.mjs';

const ordinary = ['11-nested', '12-nested', '13-chain', 'binary-depth4', '64-wide-leaf'];
const shapes = option('--shapes', args.includes('--all') ? [...ordinary, '0-wide-leaf', '1-wide-leaf', '10000-wide-leaf'].join(',') : ordinary.join(',')).split(',');
const resultPath = option('--result');
const expectedPeak = Number(option('--peak', '12'));
const report = { url, driver, browser: null, idbShim: false, expectedPeak, fixtures: [], ok: true };

function fixture(shape) {
    const files = {};
    if (/^\d+-nested$/.test(shape)) {
        for (let i = 0; i < Number.parseInt(shape); i++) files[`Folder${i}/Sub/note.md`] = '# hi\n';
    } else if (shape === '13-chain') {
        files[Array.from({ length: 13 }, (_, i) => `d${i}`).join('/') + '/note.md'] = '# hi\n';
    } else if (shape === 'binary-depth4') {
        const branch = (prefix, depth) => {
            if (!depth) { files[`${prefix}/note.md`] = '# hi\n'; return; }
            branch(`${prefix}/a`, depth - 1);
            branch(`${prefix}/b`, depth - 1);
        };
        branch('tree', 4);
    } else if (/^\d+-wide-leaf$/.test(shape)) {
        for (let i = 0; i < Number.parseInt(shape); i++) files[`leaf${String(i).padStart(5, '0')}/note.md`] = '# hi\n';
    } else throw new Error(`Unknown fixture: ${shape}`);
    return { files, manifest: manifestFor(files) };
}

for (const shape of shapes) {
    const { browser, page, errors } = await launch();
    report.browser = browser.version();
    const item = { shape, ok: false };
    try {
        const { files, manifest } = fixture(shape);
        const name = `walk-${shape}`;
        await seed(page, name, files);
        const before = await counts(page);
        await pick(page, name);
        // Five seconds reproduces the three known small-vault stalls; this is
        // an observation window, not a timing performance target. The large
        // fixture gets a larger functional deadline, never a relaxed manifest.
        item.opened = await opened(page, name, shape.startsWith('10000-') ? 60000 : 5000);
        item.counts = await counts(page);
        item.listings = item.counts.started - before.started;
        item.welcome = await page.getByRole('button', { name: 'Open Vault', exact: true }).isVisible();
        assert.equal(item.opened, true, `${shape} never committed its complete tree`);
        const tree = await fullTree(page, manifest);
        item.paths = tree.paths;
        item.counts = tree.counts;
        assert.ok(tree.counts.peak <= expectedPeak, `peak ${tree.counts.peak} exceeds ${expectedPeak}`);
        assert.deepEqual(errors, [], 'browser errors');
        item.ok = true;
    } catch (error) {
        item.reason = 'hand-count';
        item.error = error.stack;
        report.ok = false;
        console.error(`FAIL hand-count ${shape} ${error.message.replace(/\s+/g, ' ')}`);
    } finally {
        report.fixtures.push(item);
        console.log(JSON.stringify(item));
        await browser.close();
    }
}
if (resultPath) {
    await mkdir(path.dirname(resultPath), { recursive: true });
    await writeFile(resultPath, JSON.stringify(report, null, 2) + '\n');
}
process.exitCode = report.ok ? 0 : 1;
