import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { fixtures, partialFixture } from './fixtures.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(arg => {
    const split = arg.indexOf('=');
    return [arg.slice(2, split), arg.slice(split + 1)];
}));
const companion = args.companion === 'true';
const cases = companion ? [partialFixture()] : fixtures;
const output = args.out || '/Users/adham/Developer/bme-impl/scratch/c-d/C-13/table';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { scope: companion ? 'benchmark companion: initially partial parse' : 'production primary',
    url: args.url, browser: null, playwright: createRequire(import.meta.url)('playwright/package.json').version,
    dpr: 1, rows: [], failures: [], pageErrors: [], scripts: [], changes: [], losses: [
        'No new timing budget is claimed; the companion observes parse coverage only.',
        'Copy preserves source bytes between marker rows, including container prefixes.',
    ] };
const check = (condition, reason) => { if (!condition) report.failures.push(`FAIL ${reason}`); };
let browser, context, page;
const pending = [], identityErrors = [];
async function finishScriptIdentity() {
    let consumed = 0;
    while (consumed < pending.length) {
        const batch = pending.slice(consumed);
        consumed += batch.length;
        await Promise.all(batch);
    }
    if (identityErrors.length) throw Object.assign(new Error(`Script identity collection: ${identityErrors.join('\n')}`), { setupFault: true });
}
await mkdir(output, { recursive: true });

async function search(page, query, reached) {
    await page.keyboard.press('Meta+f');
    const input = page.locator('.cm-search input[name="search"]');
    await input.waitFor();
    await input.fill(query);
    await input.press('Enter');
    if (reached) await reached();
    await input.fill('');
    await input.press('Escape');
    await page.locator('.cm-search').waitFor({ state: 'detached' });
}

async function panelShot(page, content, path) {
    const diagram = content.locator('.cm-mermaid-widget');
    let box;
    if (await diagram.count()) box = await diagram.first().boundingBox();
    else {
        const top = await content.locator('.cm-live-codeblock-start').first().boundingBox();
        const bottom = await content.locator('.cm-live-codeblock-end').last().boundingBox();
        assert.ok(top && bottom, 'a visible panel must have first/last rows');
        box = { x: Math.min(top.x, bottom.x), y: top.y,
            width: Math.max(top.width, bottom.width), height: bottom.y + bottom.height - top.y };
    }
    assert.ok(box, 'rendered block has a visible box');
    const viewport = page.viewportSize();
    const x = Math.max(0, Math.floor(box.x) - 32), y = Math.max(0, Math.floor(box.y) - 2);
    const width = Math.min(viewport.width - x, Math.ceil(box.x + box.width) + 32 - x);
    const height = Math.min(viewport.height - y, Math.ceil(box.y + box.height) + 2 - y);
    return page.screenshot({ path, clip: { x, y, width, height }, animations: 'disabled', caret: 'hide' });
}

async function snapshot(content) {
    return content.evaluate(element => {
        const clone = element.cloneNode(true);
        for (const node of clone.querySelectorAll('style, script')) node.remove();
        return {
            text: clone.textContent,
            start: element.querySelector('.cm-live-codeblock-start')?.textContent ?? null,
            end: element.querySelector('.cm-live-codeblock-end')?.textContent ?? null,
            diagrams: element.querySelectorAll('.cm-mermaid-widget').length,
            svgs: element.querySelectorAll('.cm-mermaid-widget svg').length,
            labels: Array.from(element.querySelectorAll('.cm-mermaid-widget svg .nodeLabel'), node => node.textContent.trim()),
            copies: element.querySelectorAll('.cm-codeblock-copy').length,
        };
    });
}

try {
    assert.ok(args.url && args.identity, 'supply --url=origin --identity=build.identity.json');
    assert.equal(report.playwright, '1.63.0', 'driver identity');
    report.identity = JSON.parse(await readFile(args.identity, 'utf8'));
    assert.equal(report.identity.mode, companion ? 'benchmark' : 'production', 'build mode identity');
    assert.equal(execFileSync('git', ['cat-file', '-t', report.identity.commit], { encoding: 'utf8' }).trim(), 'commit', 'recorded build commit exists');
    if (report.identity.tree.patchSha256) {
        assert.ok(args.patch, 'mutant identity requires its patch');
        assert.equal(sha256(await readFile(args.patch)), report.identity.tree.patchSha256, 'mutant patch identity');
    }
    const executablePath = (await readFile('/Users/adham/Developer/bme-impl/scratch/browsers/CHROME', 'utf8')).trim();
    browser = await chromium.launch({ executablePath, headless: true });
    report.browser = browser.version();
    assert.equal(report.browser, '157.0.8103.39', 'browser identity');
    context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1,
        permissions: ['clipboard-read', 'clipboard-write'] });
    context.on('response', response => {
        const request = response.request();
        if (new URL(response.url()).origin !== new URL(args.url).origin
            || (request.resourceType() !== 'script' && !/javascript/.test(response.headers()['content-type'] || ''))) return;
        pending.push((async () => {
            const path = decodeURIComponent(new URL(response.url()).pathname).replace(/^\//, '');
            const hash = sha256(await response.body());
            assert.equal(hash, report.identity.files[path], `served script identity ${path}`);
            report.scripts.push({ url: response.url(), sha256: hash });
        })().catch(error => identityErrors.push(error.stack)));
    });
    page = await context.newPage();
    page.on('pageerror', error => report.pageErrors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).origin === new URL(args.url).origin ? route.continue() : route.abort());
    await page.addInitScript(({ companion }) => {
        const grant = handle => {
            handle.queryPermission = handle.requestPermission = async () => 'granted';
            return handle;
        };
        const getDir = FileSystemDirectoryHandle.prototype.getDirectoryHandle;
        FileSystemDirectoryHandle.prototype.getDirectoryHandle = async function (...args) { return grant(await getDir.apply(this, args)); };
        window.showDirectoryPicker = async () => grant(await (await navigator.storage.getDirectory()).getDirectoryHandle('fence-table', { create: true }));
        window.__c13Writes = 0;
        const createWritable = FileSystemFileHandle.prototype.createWritable;
        FileSystemFileHandle.prototype.createWritable = function (...args) { window.__c13Writes++; return createWritable.apply(this, args); };
        if (companion) window.addEventListener('wheel', event => {
            if (event.isTrusted && !window.__c13WheelParse) window.__c13WheelParse = { ...window.__perf?.editor?.parse };
        }, { capture: true });
    }, { companion });
    const navigation = await page.goto(args.url);
    assert.ok(navigation?.ok(), 'the built app origin is available');
    await page.evaluate(async cases => {
        const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('fence-table', { create: true });
        for (const item of cases) {
            const stream = await (await dir.getFileHandle(item.name + '.md', { create: true })).createWritable();
            await stream.write(item.source); await stream.close();
        }
    }, cases);
    assert.equal(await page.evaluate(() => window.__c13Writes), cases.length, 'write observer seed positive control');
    report.setupComplete = true;
    await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
    for (const item of cases) {
        const row = { name: item.name, expected: { closed: item.closed, diagram: item.diagram, code: item.code },
            sourceSha256: sha256(item.source), control: item.control };
        report.rows.push(row);
        await page.locator(`.tree-item[data-path="${item.name}.md"]`).click();
        await page.locator(`.editor-slot-title[data-tooltip="${item.name}.md"]`).waitFor();
        const content = page.locator('.cm-content:visible');
        await content.locator('.cm-line.cm-live-heading').filter({ hasText: item.heading }).waitFor();
        assert.equal(await content.getAttribute('contenteditable'), 'false', 'Reading mode must hide rather than reveal source by its caret');
        if (companion) {
            row.initialParse = await page.evaluate(() => window.__perf?.editor?.parse);
            if (!row.initialParse) throw Object.assign(new Error('benchmark companion requires C9 editor hooks'), { setupFault: true });
            await page.locator('.cm-scroller:visible').hover();
            await page.mouse.wheel(0, 1000000000);
            row.atViewportJump = await page.evaluate(() => window.__c13WheelParse);
            if (!row.atViewportJump || row.atViewportJump.idle || row.atViewportJump.treeLength >= item.source.length) {
                throw Object.assign(new Error('initially-partial fixture did not reach the partial-parse precondition'), { setupFault: true });
            }
            await page.waitForFunction(length => window.__perf.editor.parse.idle && window.__perf.editor.parse.treeLength === length, item.source.length);
            row.completeParse = await page.evaluate(() => window.__perf.editor.parse);
        }
        await search(page, item.endQuery, async () => {
            if (item.closed) await content.locator('.cm-line.cm-live-heading').filter({ hasText: item.complete }).waitFor();
            else await page.waitForFunction(() => [...document.querySelectorAll('.cm-live-codeblock-end, .cm-mermaid-widget')].some(node => {
                const box = node.getBoundingClientRect();
                return box.height > 0 && box.bottom > 76 && box.top < innerHeight;
            }));
        });
        const outside = content.locator('.cm-line.cm-live-heading').filter({ hasText: item.closed ? item.complete : item.heading });
        await outside.click({ position: { x: 120, y: 10 } });
        const diagram = content.locator('.cm-mermaid-widget');
        if (await diagram.count()) await diagram.locator('svg').waitFor({ timeout: 20000 });
        if ((item.control || companion) && !item.diagram && item.code.includes('const ')) {
            await content.locator('.cm-live-codeblock span').filter({ hasText: /^const$/ }).first().waitFor();
        }
        await page.evaluate(async () => {
            await document.fonts.ready;
            // Mermaid requests a CM measure after its SVG lands; give that
            // measure and the scroll-anchor settle their normal paint turns.
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        });
        await page.mouse.move(5, 450);
        row.reading = await snapshot(content);
        row.screenshot = join(output, `${item.name}.png`);
        const image = await panelShot(page, content, row.screenshot);
        row.imageSha256 = sha256(image);
        check(row.reading.diagrams === (item.diagram ? 1 : 0), `render ${item.name} diagram eligibility`);
        if (item.diagram) {
            check(row.reading.svgs === 1 && row.reading.copies === 0, `render ${item.name} SVG without Copy panel`);
            check([...new Set(row.reading.labels)].sort().join(',') === 'A,B', `render ${item.name} actual node labels A/B`);
        } else {
            check(row.reading.start?.trim() === '', `fence ${item.name} opening marker hidden`);
            check(item.closed ? row.reading.end?.trim() === ''
                : !item.lastBodyLine.trim() || row.reading.end?.includes(item.lastBodyLine.trimStart()), `fence ${item.name} final row ownership`);
            check(row.reading.copies === 1, `copy ${item.name} one Copy button`);
        }
        if (row.reading.copies) {
            const marker = `C13 fresh ${item.name} ${Date.now()}`;
            await page.evaluate(value => navigator.clipboard.writeText(value), marker);
            await content.getByRole('button', { name: 'Copy code', exact: true }).click();
            await content.locator('.cm-codeblock-copy-done').waitFor();
            row.clipboard = await page.evaluate(() => navigator.clipboard.readText());
            check(row.clipboard !== marker, `copy ${item.name} fresh native clipboard result`);
            if (!item.diagram) check(row.clipboard === item.code, `copy ${item.name} body bytes only`);
        } else row.clipboard = null;

        await page.keyboard.press('Meta+e');
        await page.waitForFunction(() => document.querySelector('.cm-content')?.contentEditable === 'true');
        const bodyLine = content.locator('.cm-line').filter({ hasText: item.caretQuery }).first();
        if (!await bodyLine.isVisible()) {
            // Empty panels have no body glyph to click, and diagrams hide the
            // source altogether. Enter through their real visible surface.
            const surface = await content.locator('.cm-mermaid-widget').count()
                ? content.locator('.cm-mermaid-widget') : content.locator('.cm-live-codeblock-start');
            await surface.click({ position: { x: 120, y: 8 } });
        }
        await bodyLine.click();
        assert.equal(await content.evaluate(element => document.activeElement === element), true, 'a real editable caret holds the keyboard');
        row.editing = await snapshot(content);
        check(row.editing.diagrams === 0, `reveal ${item.name} caret reveals source`);
        check(row.editing.start?.includes(item.opening.trim().replace(/^(?:>|-)\s*/, '')), `reveal ${item.name} opener visible`);
        if (item.closed) check(row.editing.end?.includes(item.closing.trim().replace(/^>\s*/, '')), `reveal ${item.name} closer visible`);
        const awayHeading = item.closed ? item.complete : item.heading;
        await search(page, awayHeading);
        await content.locator('.cm-line.cm-live-heading').filter({ hasText: awayHeading }).click({ position: { x: 120, y: 10 } });
        if (item.diagram) await content.locator('.cm-mermaid-widget svg').waitFor({ timeout: 20000 });
        row.away = await snapshot(content);
        check(row.away.diagrams === (item.diagram ? 1 : 0), `away ${item.name} diagram eligibility restored`);
        if (!item.diagram) check(row.away.start?.trim() === '' && (!item.closed || row.away.end?.trim() === ''), `away ${item.name} fences hidden again`);
        await page.keyboard.press('Meta+e');
        await page.waitForFunction(() => document.querySelector('.cm-content')?.contentEditable === 'false');
    }
    check(report.pageErrors.length === 0, 'render no app page errors');
    check(await page.evaluate(() => window.__c13Writes) === cases.length, 'bytes no app write in display/copy/caret-only flow');
    for (const item of cases) {
        const actual = await page.evaluate(async name => {
            const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('fence-table');
            const bytes = await (await (await dir.getFileHandle(name + '.md')).getFile()).arrayBuffer();
            return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
        }, item.name);
        check(actual === sha256(item.source), `bytes ${item.name} original source retained`);
    }
    await finishScriptIdentity();
    assert.ok(report.scripts.length, 'the browser must fetch app scripts');
    if (args.reference) {
        const before = JSON.parse(await readFile(join(args.reference, 'report.json'), 'utf8'));
        const previous = new Map(before.rows.map(row => [row.name, row]));
        for (const row of report.rows) {
            const old = previous.get(row.name);
            assert.ok(old?.reading && old.screenshot, `reference row ${row.name} exists`);
            const fields = ['text', 'start', 'end', 'diagrams', 'svgs', 'copies'];
            const changed = fields.filter(field => old.reading[field] !== row.reading[field]);
            if (old.clipboard !== row.clipboard) changed.push('clipboard');
            if (changed.length) report.changes.push({ name: row.name, fields: changed, before: old.screenshot, after: row.screenshot });
            if (row.control) check(row.imageSha256 === sha256(await readFile(old.screenshot)), `pixels ${row.name} valid backtick control is identical`);
        }
    }
    report.passed = report.failures.length === 0;
    process.exitCode = report.passed ? 0 : 1;
} catch (error) {
    report.passed = false;
    let failure = error;
    try { await finishScriptIdentity(); }
    catch (identityError) { report.observedFailure = error.stack; failure = identityError; }
    report.error = failure.stack;
    if (page) {
        report.failureDOM = await page.evaluate(() => ({
            text: document.body.innerText,
            editable: document.querySelector('.cm-content')?.contentEditable,
            focus: document.activeElement?.tagName,
            starts: [...document.querySelectorAll('.cm-live-codeblock-start')].map(node => node.textContent),
            ends: [...document.querySelectorAll('.cm-live-codeblock-end')].map(node => node.textContent),
        })).catch(() => null);
        await page.screenshot({ path: join(output, 'failure.png'), animations: 'disabled', caret: 'hide' }).catch(() => {});
    }
    const invalid = !report.setupComplete || failure.setupFault;
    report.failures.push(`${invalid ? 'INVALID' : 'FAIL render'} ${failure.message}`);
    process.exitCode = invalid ? 2 : 1;
} finally {
    await context?.close();
    await browser?.close();
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    for (const failure of report.failures) console.log(failure);
    console.log(JSON.stringify({ scope: report.scope, passed: report.passed, browser: report.browser,
        playwright: report.playwright, rows: report.rows.length, scripts: report.scripts.length,
        failures: report.failures, changes: report.changes, output }, null, 2));
}
