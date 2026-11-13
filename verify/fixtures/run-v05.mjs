import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { generateCorpus, recordManifests, REPO } from './lib/corpus.mjs';
import { compareNames, jsonBytes, sha256 } from './lib/output.mjs';
import { resolveExternal } from './fetch-external.mjs';
const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i++) {
    if (['--clock-mutant', '--record-manifests'].includes(args[i]))
        options[args[i].slice(2)] = true;
    else if (['--out', '--url', '--browser'].includes(args[i]) && args[i + 1])
        options[args[i].slice(2)] = args[++i];
    else
        throw new Error(`Unknown/missing option ${args[i]}`);
}
if (!options.out || !options.url)
    throw new Error('Usage: node verify/fixtures/run-v05.mjs --out <fresh scratch directory> --url <loopback app origin> [--record-manifests] [--clock-mutant]');
const out = resolve(options.out);
if (out.startsWith(REPO))
    throw new Error('Run artifacts must be outside the repository');
const origin = new URL(options.url);
if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))
    throw new Error('V-05 only drives a loopback app');
const pin = JSON.parse(await readFile(resolve(REPO, 'verify/browser-pin.json'), 'utf8'));
const executablePath = options.browser ?? `/Users/adham/Developer/bme-impl/scratch/browsers/${pin.version}/${pin.executable}`;
await mkdir(out, { recursive: false });
const report = { gate: 'V-05', status: 'failed', losses: ['One machine only; second-machine determinism not covered.', 'OPFS is not real-disk behaviour.', 'Fixture licence proposal is not owner approval.'], mutant: !!options['clock-mutant'] };
let browser;
let page;
try {
    report.build = { sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim(), configuration: 'production preview; scratch Vite config', sourceStatus: execFileSync('git', ['status', '--short'], { cwd: REPO, encoding: 'utf8' }).trim() };
    report.externalInputs = await Promise.all(['OLD-A1', 'OLD-R1', 'OLD-R2', 'OLD-R4'].map(id => resolveExternal(id, { cache: resolve(out, 'external-cache') })));
    const first = await generateCorpus(resolve(out, 'a'), { clockMutant: report.mutant });
    const second = await generateCorpus(resolve(out, 'b'), { clockMutant: report.mutant });
    assert.deepEqual(first, second, 'V-05 determinism: generator outputs differ between independent invocations');
    for (const record of first) {
        const a = await readFile(resolve(out, 'a', record.invocation, record.file));
        const b = await readFile(resolve(out, 'b', record.invocation, record.file));
        assert.ok(a.equals(b), `V-05 determinism bytes: ${record.id}`);
    }
    report.determinism = { status: 'passed', files: first.length, fixtures: first.map(({ id, sha256, bytes }) => ({ id, sha256, bytes })) };
    if (!options['record-manifests']) {
        const expected = [];
        for (const stream of ['core', 'platform']) {
            const manifest = JSON.parse(await readFile(resolve(REPO, 'verify/fixtures', stream, 'manifest.json'), 'utf8'));
            assert.equal(manifest.schema, 1);
            assert.equal(manifest.stream, stream);
            expected.push(...manifest.fixtures.map(record => ({ stream, ...record })));
        }
        assert.deepEqual([...first].sort((a, b) => compareNames(a.id, b.id)), expected.sort((a, b) => compareNames(a.id, b.id)), 'VER-06: generated fixture identity changed; review the corpus, do not weaken its gate');
        const pdfManifest = JSON.parse(await readFile(resolve(REPO, 'verify/fixtures/pdf/manifest.json'), 'utf8'));
        const aliases = pdfManifest.fixtures.filter(record => record.canonicalManifest === 'verify/fixtures/platform/manifest.json');
        assert.deepEqual(aliases.map(({ id, sha256, bytes }) => ({ id, sha256, bytes })).sort((a, b) => compareNames(a.id, b.id)), first.filter(record => record.invocation === 'platform/geometry').map(({ id, sha256, bytes }) => ({ id, sha256, bytes })).sort((a, b) => compareNames(a.id, b.id)), 'GEN-01 PDF aliases drifted from the canonical platform corpus');
    }
    const index = await (await fetch(origin)).text();
    assert.ok(index.includes('/assets/') && !index.includes('/@vite/client'), 'V-05 must drive a production preview, not a dev server');
    report.build.indexSha256 = sha256(index);
    browser = await chromium.launch({ executablePath, headless: true });
    assert.equal(browser.version(), pin.version, 'Wrong browser identity');
    report.browser = { version: browser.version(), executablePath, driver: pin.driver, app: origin.origin, reloadArm: 'none; fresh context only' };
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    await context.route('**/*', route => {
        const url = new URL(route.request().url());
        return url.origin === origin.origin || ['blob:', 'data:'].includes(url.protocol) ? route.continue() : route.abort();
    });
    page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    // V-01a was not merged when this package was authored; this is the skill's documented
    // sketch, deliberately kept here until adoption of the shared toolbox can be reviewed.
    await page.addInitScript(() => {
        const grant = handle => {
            handle.queryPermission = async () => 'granted';
            handle.requestPermission = async () => 'granted';
            return handle;
        };
        const getDirectory = FileSystemDirectoryHandle.prototype.getDirectoryHandle;
        FileSystemDirectoryHandle.prototype.getDirectoryHandle = async function (...args) { return grant(await getDirectory.apply(this, args)); };
        window.showDirectoryPicker = async () => grant(await (await navigator.storage.getDirectory()).getDirectoryHandle('V05-Fixture', { create: true }));
    });
    await page.goto(origin.href);
    const vault = JSON.parse(await readFile(resolve(out, 'a/core/vault-100/vault-100.json'), 'utf8'));
    const pdf = await readFile(resolve(out, 'a/platform/geometry/geometry.pdf'));
    await page.evaluate(async ({ files, pdf }) => {
        const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('V05-Fixture', { create: true });
        for (const entry of [...files, { path: 'geometry.pdf', encoding: 'base64', content: pdf }]) {
            const parts = entry.path.split('/');
            let directory = root;
            for (const part of parts.slice(0, -1))
                directory = await directory.getDirectoryHandle(part, { create: true });
            const handle = await directory.getFileHandle(parts.at(-1), { create: true });
            const writer = await handle.createWritable();
            await writer.write(entry.encoding === 'base64' ? Uint8Array.from(atob(entry.content), char => char.charCodeAt(0)) : entry.content);
            await writer.close();
        }
    }, { files: vault.files, pdf: pdf.toString('base64') });
    await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
    await page.locator('.tree-file').filter({ has: page.locator('.tree-item-label', { hasText: /^Every construct$/ }) }).click();
    const content = page.locator('.cm-content[contenteditable="false"]');
    await content.waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent?.includes('BME-CONSTRUCTS-v1'));
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: resolve(out, 'constructs-reading-top.png') });
    const scroller = page.locator('.cm-scroller');
    let imageWitness = false;
    for (const fraction of [0.3, 0.4, 0.65, 1]) {
        await scroller.evaluate((element, fraction) => { element.scrollTop = (element.scrollHeight - element.clientHeight) * fraction; }, fraction);
        await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
        await page.evaluate(() => document.fonts.ready);
        if (await page.locator('.cm-image-widget img').count()) {
            await page.waitForFunction(() => [...document.querySelectorAll('.cm-image-widget img')].every(image => image.complete && image.naturalWidth > 0));
            imageWitness = true;
        }
        assert.equal(await page.locator('.cm-image-placeholder.error').count(), 0, 'Generated note has a missing asset');
        await page.screenshot({ path: resolve(out, `constructs-reading-${fraction}.png`) });
    }
    assert.ok(imageWitness, 'The note never rendered its authored checker image');
    await scroller.evaluate(element => { element.scrollTop = 0; });
    assert.equal(await page.evaluate(() => !!window.BME_FIXTURE_EXECUTED), false, 'Literal HTML fixture executed');
    report.note = { path: 'Every construct.md', mode: 'Reading', vaultNotes: vault.noteCount, screenshot: 'constructs-reading-top.png' };
    await page.locator('.tree-file').filter({ has: page.locator('.tree-item-label', { hasText: /^geometry\.pdf$/ }) }).click();
    await page.locator('.pdf-viewer').waitFor({ state: 'visible' });
    await page.waitForFunction(() => [...document.querySelectorAll('.pdf-viewer-page canvas')].some(canvas => canvas.width > 0 && canvas.height > 0));
    await page.waitForFunction(() => document.querySelector('.pdf-viewer-page .textLayer')?.textContent?.includes('GEN-01-p01-control-r0'));
    const pixels = await page.locator('.pdf-viewer-page canvas').first().evaluate(canvas => {
        const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let nonWhite = 0;
        let colored = 0;
        for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] && Math.min(data[i], data[i + 1], data[i + 2]) < 200)
                nonWhite++;
            if (data[i + 3] && Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]) > 100)
                colored++;
        }
        return { nonWhite, colored, width: canvas.width, height: canvas.height };
    });
    assert.ok(pixels.nonWhite > 100 && pixels.colored > 100, 'PDF pane mounted without the generated fiducial pixels');
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: resolve(out, 'geometry-pdf.png') });
    assert.deepEqual(errors, [], 'The app raised page errors');
    report.pdf = { path: 'geometry.pdf', pane: 'pdf-viewer', engine: 'classic pdf.js', marker: 'GEN-01-p01-control-r0', pixels, screenshot: 'geometry-pdf.png' };
    if (options['record-manifests'])
        await recordManifests(first);
    report.status = 'passed';
}
catch (error) {
    report.error = error.stack;
    if (page && !page.isClosed()) {
        await page.screenshot({ path: resolve(out, 'failure.png') }).catch(() => { });
        report.diagnostic = await page.evaluate(() => ({
            images: [...document.querySelectorAll('.cm-image-widget img')].map(image => ({ source: image.getAttribute('src'), complete: image.complete, width: image.naturalWidth })),
            imagePlaceholders: [...document.querySelectorAll('.cm-image-placeholder')].map(element => element.textContent),
            pdfPages: document.querySelectorAll('.pdf-viewer-page').length,
        })).catch(() => null);
    }
    process.exitCode = 1;
}
finally {
    await browser?.close();
    await writeFile(resolve(out, 'report.json'), jsonBytes(report));
    process.stdout.write(`${JSON.stringify(report)}\n`);
}
