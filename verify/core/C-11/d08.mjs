import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { args, launch, openFile, activePath, backlinks, graph, saveText, reload } from './browser.mjs';

const files = {
    'source.md': '# Source\n\n[[Note]]\n',
    'a/Note.md': '# FIRST NOTE\n',
    'z/Note.md': '# LAST NOTE\n',
    'unique-source.md': '# Unique source\n\n[[Unique]]\n',
    'Unique.md': '# UNIQUE NOTE\n',
    '.appearance.json': JSON.stringify({ version: 2, entries: {}, icons: {}, order: { '': ['z', 'a', 'source.md', 'Unique.md', 'unique-source.md'] } }),
};
const out = args.out ?? '/Users/adham/Developer/bme-impl/scratch/c-e/C-11-D08';
const probe = args['resolver-probe'] === 'last';
const initialPath = probe ? 'z/Note.md' : 'a/Note.md';
const initialMarker = probe ? 'LAST NOTE' : 'FIRST NOTE';
const report = { fixture: files, resolverProbe: probe, phases: {}, driver: createRequire(import.meta.url)('playwright/package.json').version, idbShim: false };
await mkdir(out, { recursive: true });
let browser;
try {
    const run = await launch(files); browser = run.browser;
    const { page, errors } = run;
    report.browser = browser.version();
    assert.equal(report.browser, '157.0.8103.39'); assert.equal(report.driver, '1.63.0');
    async function followDrawnSourceEdge(name) {
        // Start from source, not the duplicate: either possible graph target
        // then requires a real tab transition before its identity is read.
        await openFile(page, 'source.md');
        const drawing = await graph(page);
        await page.locator('.graph-canvas-wrap canvas').screenshot({ path: `${out}/${name}.png` });
        const box = await page.locator('.graph-canvas-wrap canvas').boundingBox();
        let target;
        for (const edge of drawing.paint.edges) {
            await page.mouse.move(box.x + edge.from.x, box.y + edge.from.y);
            if (await page.locator('.graph-hover-label').textContent() === 'source') { target = edge.to; break; }
        }
        assert(target, 'no painted edge from the real source node');
        await page.mouse.click(box.x + target.x, box.y + target.y);
        await page.waitForFunction(() => document.querySelector('.tab.is-active')?.getAttribute('data-tooltip') !== 'source.md');
        await page.locator('.cm-content').waitFor();
        return { drawing, path: await activePath(page), text: await page.locator('.cm-content').innerText() };
    }
    async function phase(name, expectedPath, marker) {
        const result = report.phases[name] = {};
        await openFile(page, 'source.md');
        const count = await page.locator('.cm-wikilink').count();
        result.variants = [];
        for (let i = 0; i < count; i++) {
            await openFile(page, 'source.md');
            await page.locator('.cm-wikilink').nth(i).click();
            await page.waitForFunction(() => document.querySelector('.tab.is-active')?.getAttribute('data-tooltip') !== 'source.md');
            result.variants.push({ path: await activePath(page), text: await page.locator('.cm-content').innerText() });
        }
        assert(count > 0, 'source has no rendered wikilink');
        result.clickPath = result.variants[0].path;
        result.clickText = result.variants[0].text;
        result.backlinks = await backlinks(page);
        result.graphTarget = await followDrawnSourceEdge(name);
        if (result.graphTarget.path !== expectedPath) throw new Error(`FAIL D08-target graph ${result.graphTarget.path} != ${expectedPath}`);
        if (result.variants.some(variant => variant.path !== result.graphTarget.path)) throw new Error(`FAIL click-graph-agree click ${result.clickPath} != graph ${result.graphTarget.path}`);
        assert.deepEqual(result.variants.map(variant => variant.path), Array(count).fill(expectedPath), 'a wikilink variant opened another duplicate');
        assert(result.clickText.includes(marker), 'duplicate identity marker is missing');
        assert.deepEqual(result.backlinks, { count: 1, sources: ['source.md'] }, 'clicked duplicate lacks its unique source backlink');
        assert(result.graphTarget.text.includes(marker), 'canvas click opened another duplicate');
        await openFile(page, 'unique-source.md');
        await page.locator('.cm-wikilink').click();
        await page.waitForFunction(() => document.querySelector('.tab.is-active')?.getAttribute('data-tooltip') === 'Unique.md');
        assert.deepEqual(await backlinks(page), { count: 1, sources: ['unique-source.md'] }, 'non-duplicate control lost its link');
    }
    await phase('cold', initialPath, initialMarker);
    for (const label of ['File name (Z to A)', 'Modified time (new to old)', 'Custom', 'File name (A to Z)']) {
        await page.getByRole('button', { name: 'Change sort order', exact: true }).click();
        await page.getByRole('menuitemradio', { name: label, exact: true }).click();
        const order = await page.locator('.nav-files-container .tree-item[data-path]').evaluateAll(rows => rows.map(row => row.dataset.path));
        const key = label.replaceAll(/[^A-Za-z0-9]/g, '-');
        await phase(key, initialPath, initialMarker);
        report.phases[key].sidebarOrder = order;
        if (label === 'Custom') assert(order.indexOf('z') < order.indexOf('a'), 'custom order fixture did not change presentation');
    }
    report.aliasSaveWitness = await saveText(page, 'source.md', '# Source\n\n[[Note.md]] [[Note#Heading]] [[Note|alias]]\n');
    await page.keyboard.press('Meta+e');
    await phase('aliases-suffix-heading', initialPath, initialMarker);
    // The graph trip above unmounted the editor, so the following click uses
    // the cached EditorState. Rename the first duplicate through the real UI.
    await openFile(page, 'a/Note.md');
    const first = page.locator('.tree-item[data-path="a/Note.md"]');
    await first.hover();
    await first.getByRole('button', { name: 'Rename', exact: true }).click();
    await first.locator('.inline-rename-input').fill('Other.md');
    await first.locator('.inline-rename-input').press('Enter');
    await page.locator('.tree-item[data-path="a/Other.md"]').waitFor();
    await phase('renamed-first', 'z/Note.md', 'LAST NOTE');
    await reload(page);
    await phase('reloaded', 'z/Note.md', 'LAST NOTE');
    assert.deepEqual(errors, []);
    report.result = 'PASS'; console.log('PASS C-11 D08 canonical/sort/rename/cached/reload');
} catch (error) {
    report.result = 'FAIL'; report.error = error.stack; process.exitCode = 1;
    console.log(error.message.split('\n')[0]);
} finally {
    await browser?.close();
    await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2) + '\n');
}
