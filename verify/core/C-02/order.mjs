import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { driver, fullTree, launch, manifestFor, opened, option, pick, seed, url } from './browser.mjs';

const resultPath = option('--result');
const referencePath = option('--reference');
const reference = referencePath ? JSON.parse(await readFile(referencePath, 'utf8')) : null;
const result = { url, driver, fixtures: [], ok: true };
for (const shape of ['hostile', '10000-siblings']) {
    const { browser, page, errors } = await launch();
    const item = { shape, browser: browser.version(), ok: false };
    try {
        const names = shape === 'hostile'
            ? ['a.md', 'A.md', 'á.md', 'Á.md', 'ä.md', 'Ä.md', 'a2.md', 'a10.md', '.alpha.md', 'e.md', 'E.md', 'é.md', 'β.md', '中.md', '😀.md', '😊.md']
            : Array.from({ length: 10000 }, (_, i) => `note${String(i).padStart(5, '0')}.md`);
        const files = Object.fromEntries(names.map(name => [name, '# order\n']));
        const vault = `walk-order-${shape}`;
        await seed(page, vault, files);
        await pick(page, vault);
        assert.equal(await opened(page, vault, 60000), true);
        item.tree = await fullTree(page, manifestFor(files));
        if (reference) {
            assert.equal(reference.ok, true, 'reference capture must have succeeded');
            assert.deepEqual(item.tree.paths, reference.fixtures.find(item => item.shape === shape).tree.paths, 'sidebar order changed');
        }
        assert.deepEqual(errors, []);
        item.ok = true;
    } catch (error) {
        item.reason = 'sort-order';
        item.error = error.stack;
        result.ok = false;
        console.error(`FAIL sort-order ${shape} ${error.message.replace(/\s+/g, ' ')}`);
    } finally {
        result.fixtures.push(item);
        await browser.close();
    }
}
if (resultPath) {
    await mkdir(path.dirname(resultPath), { recursive: true });
    await writeFile(resultPath, JSON.stringify(result, null, 2) + '\n');
}
console.log(JSON.stringify({ ok: result.ok, fixtures: result.fixtures.map(item => ({ shape: item.shape, ok: item.ok, paths: item.tree?.paths.length, error: item.error })) }));
process.exitCode = result.ok ? 0 : 1;
