import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const [url = 'http://localhost:6340/', output = '/Users/adham/Developer/bme-impl/scratch/c-d/C-13/unfixed'] = process.argv.slice(2);
const driver = createRequire(import.meta.url)('playwright/package.json').version;
const fixture = (name, fence, lang, body, after) => ({
    name, fence, body, diagram: lang === 'mermaid',
    text: `${fence}${lang}\n${body}\n${fence}\n\n${after}\n\n# Complete ${name}`,
});
const fixtures = [
    fixture('BacktickCode', '```', 'js', 'const value = 1;', 'After fence.'),
    fixture('BacktickDiagram', '```', 'mermaid', 'flowchart LR\n A --> B', 'After diagram.'),
    fixture('TildeCode', '~~~', 'js', 'const value = 1;', 'After fence.'),
    fixture('TildeDiagram', '~~~', 'mermaid', 'flowchart LR\n A --> B', 'After diagram.'),
];
const failures = [], rows = [], errors = [];
const check = (value, message) => { if (!value) failures.push(`FAIL E01 ${message}`); };
await mkdir(output, { recursive: true });
const executablePath = (await readFile('/Users/adham/Developer/bme-impl/scratch/browsers/CHROME', 'utf8')).trim();
const browser = await chromium.launch({ headless: true, executablePath });
const report = { browser: browser.version(), playwright: driver, url, rows, failures, pageErrors: errors };
let context;
try {
    assert.equal(driver, '1.63.0', 'pinned driver');
    assert.equal(browser.version(), '157.0.8103.39', 'pinned browser');
    context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1,
        permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
    await page.addInitScript(() => {
        const grant = handle => {
            handle.queryPermission = handle.requestPermission = async () => 'granted';
            return handle;
        };
        const getDirectory = FileSystemDirectoryHandle.prototype.getDirectoryHandle;
        FileSystemDirectoryHandle.prototype.getDirectoryHandle = async function (...args) {
            return grant(await getDirectory.apply(this, args));
        };
        window.showDirectoryPicker = async () => grant(await (await navigator.storage.getDirectory()).getDirectoryHandle('editor-fences', { create: true }));
        window.__c13Writes = 0;
        const createWritable = FileSystemFileHandle.prototype.createWritable;
        FileSystemFileHandle.prototype.createWritable = function (...args) {
            window.__c13Writes++;
            return createWritable.apply(this, args);
        };
    });
    await page.goto(url);
    await page.evaluate(async fixtures => {
        const vault = await (await navigator.storage.getDirectory()).getDirectoryHandle('editor-fences', { create: true });
        for (const { name, text } of fixtures) {
            const stream = await (await vault.getFileHandle(name + '.md', { create: true })).createWritable();
            await stream.write(text);
            await stream.close();
        }
    }, fixtures);
    assert.equal(await page.evaluate(() => window.__c13Writes), fixtures.length, 'the write observer must see all seed writes');
    await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
    for (const item of fixtures) {
        await page.locator(`.tree-item[data-path="${item.name}.md"]`).click();
        await page.locator(`.editor-slot-title[data-tooltip="${item.name}.md"]`).waitFor();
        const content = page.locator('.cm-content:visible');
        await content.locator('.cm-line.cm-live-heading').filter({ hasText: `Complete ${item.name}` }).waitFor();
        assert.equal(await content.getAttribute('contenteditable'), 'false', 'Reading mode must not reveal fences by its caret');
        const widget = content.locator('.cm-mermaid-widget');
        const diagrams = await widget.count();
        if (diagrams) await widget.locator('svg').waitFor({ timeout: 20000 });
        await page.evaluate(() => document.fonts.ready);
        await page.mouse.move(5, 450);
        const row = { name: item.name, editable: await content.getAttribute('contenteditable'),
            visibleText: await content.textContent(), diagrams,
            svg: await widget.locator('svg').count(), copyButtons: await content.locator('.cm-codeblock-copy').count() };
        rows.push(row);
        await page.locator('.cm-scroller:visible').screenshot({ path: join(output, `${item.name}.png`), animations: 'disabled', caret: 'hide' });
        if (item.diagram) {
            check(row.diagrams === 1 && row.svg === 1 && row.copyButtons === 0, `${item.name} must render one diagram and no code panel`);
            if (row.svg) {
                const labels = await widget.locator('svg').textContent();
                check(labels.includes('A') && labels.includes('B'), `${item.name} diagram labels A/B must render`);
            }
        } else {
            check(!row.visibleText.includes(item.fence), `${item.name} both marker rows must be hidden`);
            check(row.copyButtons === 1, `${item.name} one real Copy code button`);
        }
        if (row.copyButtons) {
            const marker = `C13 fresh clipboard ${item.name} ${Date.now()}`;
            await page.evaluate(text => navigator.clipboard.writeText(text), marker);
            const button = content.getByRole('button', { name: 'Copy code', exact: true });
            await button.click();
            await content.locator('.cm-codeblock-copy-done').waitFor();
            row.clipboard = await page.evaluate(() => navigator.clipboard.readText());
            check(row.clipboard !== marker, `${item.name} Copy must replace this run's fresh clipboard marker`);
            check(row.clipboard === item.body, `${item.name} Copy payload must be the body only`);
        }
    }
    check(errors.length === 0, 'no app page errors');
    check(await page.evaluate(() => window.__c13Writes) === fixtures.length, 'Reading and Copy must not start any vault write');
    for (const item of fixtures) {
        const actual = await page.evaluate(async name => {
            const vault = await (await navigator.storage.getDirectory()).getDirectoryHandle('editor-fences');
            return (await (await vault.getFileHandle(name + '.md')).getFile()).text();
        }, item.name);
        check(actual === item.text, `${item.name} source bytes must remain unchanged`);
    }
    report.passed = failures.length === 0;
    process.exitCode = report.passed ? 0 : 1;
} catch (error) {
    report.passed = false;
    report.error = error.stack;
    process.exitCode = 2;
} finally {
    await context?.close();
    await browser.close();
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
}
