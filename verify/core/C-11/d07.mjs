import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { args, launch, openFile, backlinks, graph, editor, saveText, reload } from './browser.mjs';

const cases = [
    ['E01_https', '[web](https://example.com/README.md)'],
    ['E01_http', '[web](http://example.com/README.md)'],
    ['E02_protocol', '[web](//example.com/README.md)'],
    ['E02_www', '[web](www.example.com/README.md)'],
    ['E02_email', '[mail](notes@example.md)'],
    ['E02_file', '[file](file:///README.md)'],
    ['E02_custom', '[custom](custom:README.md)'],
    ['E02_drive', '[drive](C:/README.md)'],
    ['E02_root_drive', '[drive](/C:/README.md)'],
    ['E02_unc', '[unc](\\\\server\\share\\README.md)'],
    ['E03_title', '[web](https://example.com/README.md "title")'],
    ['E03_query', '[web](https://example.com/README.md?q=1)'],
    ['E03_fragment', '[web](https://example.com/README.md#part)'],
    ['E03_parentheses', '[web](https://example.com/(part)/README.md)'],
    ['E04_local', '[local](README.md)', 'README.md'],
    ['E04_root', '[root](/README.md)', 'README.md'],
    ['E04_space', '[space](Space%20Note.md)', 'Space Note.md'],
    ['E04_folder', '[folder](folder/Prefixed.md)', 'folder/Prefixed.md'],
    ['E04_dot', '[dot](folder/../README.md)', 'README.md'],
    ['E04_encoded_dot', '[dot](folder/%2e%2e/README.md)', 'README.md'],
    ['E05_label_external', '[https://example.com/README.md](https://other.invalid/README.md)'],
    ['E05_label_local', '[https://example.com/README.md](folder/Prefixed.md)', 'folder/Prefixed.md'],
    ['E06_percent', '[bad](Bad%ZZ.md)'],
    ['E06_control', '[bad](https:\t//example.com/README.md)'],
    ['E06_traversal', '[bad](../README.md)'],
    ['E06_deep_traversal', '[bad](folder/../../README.md)'],
    ['E06_encoded_scheme', '[bad](https%3A%2F%2Fexample.com%2FREADME.md)'],
    ['E06_encoded_slashes', '[bad](%2F%2Fexample.com/README.md)'],
    ['E06_encoded_drive', '[bad](C%3A/README.md)'],
    ['E06_encoded_control', '[bad](https%09:/README.md)'],
    ['E06_encoded_traversal', '[bad](%2e%2e/README.md)'],
    ['E06_fragment_only', '[bad](#README.md)'],
];
const targets = ['README.md', 'Space Note.md', 'folder/Prefixed.md'];
const files = Object.fromEntries([...targets.map(name => [name, `# Target ${name}\n`]), ...cases.map(([name, link]) => [`${name}.md`, `# ${name}\n\n${link}\n`])]);
const expected = Object.fromEntries(targets.map(target => [target, cases.filter(row => row[2] === target).map(row => `${row[0]}.md`).sort()]));
const out = args.out ?? '/Users/adham/Developer/bme-impl/scratch/c-e/C-11-D07';
const report = { fixture: files, expected, phases: {}, driver: createRequire(import.meta.url)('playwright/package.json').version, idbShim: false };
await mkdir(out, { recursive: true });
let browser;
try {
    const run = await launch(files); browser = run.browser;
    const { page, errors } = run;
    report.browser = browser.version();
    assert.equal(report.browser, '157.0.8103.39'); assert.equal(report.driver, '1.63.0');
    for (const [name] of cases) await openFile(page, `${name}.md`);
    async function phase(name) {
        const result = report.phases[name] = {};
        await openFile(page, 'E01_https.md');
        result.href = await page.locator('.cm-content a.cm-external-link').getAttribute('href');
        assert.equal(result.href, 'https://example.com/README.md', 'external reader anchor changed');
        result.graph = await graph(page);
        await page.locator('.graph-canvas-wrap canvas').screenshot({ path: `${out}/${name}.png` });
        await editor(page);
        result.backlinks = {};
        for (const target of targets) { await openFile(page, target); result.backlinks[target] = await backlinks(page); }
        for (const target of targets) {
            const got = result.backlinks[target].sources;
            const extra = got.filter(source => !expected[target].includes(source));
            if (extra.length) throw new Error(`FAIL D07-external ${target}: unexpected ${extra.join(',')}`);
            const missing = expected[target].filter(source => !got.includes(source));
            if (missing.length) throw new Error(`FAIL D07-local ${target}: missing ${missing.join(',')}`);
            assert.equal(result.backlinks[target].count, expected[target].length, `backlink multiplicity ${target}`);
        }
        assert.equal(result.graph.paint.nodes.length, Object.keys(files).length, 'unresolved URL/path node exists');
        assert.equal(result.graph.paint.edges.length, cases.filter(row => row[2]).length, 'wrong graph edge count');
    }
    await phase('cold');
    await saveText(page, 'E01_https.md', files['E01_https.md'] + '\nSaved through the editor.\n');
    await page.keyboard.press('Meta+e');
    await phase('saved');
    await reload(page);
    await phase('reloaded');
    assert.deepEqual(errors, []);
    report.result = 'PASS'; console.log('PASS C-11 D07 cold/save/reload');
} catch (error) {
    report.result = 'FAIL'; report.error = error.stack; process.exitCode = 1;
    console.log(error.message.split('\n')[0]);
} finally {
    await browser?.close();
    await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2) + '\n');
}
