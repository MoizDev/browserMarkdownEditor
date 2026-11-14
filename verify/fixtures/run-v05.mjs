import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { generateCorpus, recordManifests, REPO } from './lib/corpus.mjs';
import { compareNames, jsonBytes } from './lib/output.mjs';
import { resolveExternal } from './fetch-external.mjs';
import { buildIdentity, bindServedBodies } from '../lib/identity.mjs';
import { installVault, seedVault } from '../lib/vault.mjs';
import { createReport } from '../lib/report.mjs';
const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i++) {
    if (['--clock-mutant', '--browser-mutant', '--record-manifests', '--block-external'].includes(args[i]))
        options[args[i].slice(2)] = true;
    else if (['--out', '--url', '--browser', '--dist'].includes(args[i]) && args[i + 1])
        options[args[i].slice(2)] = args[++i];
    else
        throw new Error(`Unknown/missing option ${args[i]}`);
}
if (!options.out || !options.url || !options.dist)
    throw new Error('Usage: node verify/fixtures/run-v05.mjs --out <fresh scratch directory> --url <loopback app origin> --dist <emitted production directory> [--record-manifests] [--browser-mutant | --clock-mutant] [--block-external]');
if ((options['clock-mutant'] && options['browser-mutant']) || (options['record-manifests'] && (options['clock-mutant'] || options['browser-mutant']))) {
    throw new Error('Mutants are exclusive and cannot write corpus manifests');
}
const out = resolve(options.out);
if (out.startsWith(REPO))
    throw new Error('Run artifacts must be outside the repository');
const origin = new URL(options.url);
if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))
    throw new Error('V-05 only drives a loopback app');
const pin = JSON.parse(await readFile(resolve(REPO, 'verify/browser-pin.json'), 'utf8'));
const executablePath = options.browser ?? `/Users/adham/Developer/bme-impl/scratch/browsers/${pin.version}/${pin.executable}`;
await mkdir(out, { recursive: false });
const ledger = await createReport({ scratch: out, name: 'V-05',
    gate: 'V-05', status: 'failed', stage: 'preparation',
    losses: ['One machine only; second-machine determinism not covered.', 'OPFS is not real-disk behaviour.', 'Fixture licence proposal is not owner approval.'],
    mutant: options['clock-mutant'] ? 'clock-preparation' : options['browser-mutant'] ? 'seeded-vault-browser' : null,
    network: { mode: options['block-external'] ? 'block-listed-external-origins-opt-in' : 'unrestricted', blockedUrls: [] },
});
const report = ledger.data;
let browser;
let page;
let binding;
try {
    report.build = await buildIdentity({ worktree: REPO, distDir: resolve(options.dist) });
    report.externalInputs = await Promise.all(['OLD-A1', 'OLD-R1', 'OLD-R2', 'OLD-R4'].map(id => resolveExternal(id, { cache: resolve(out, 'external-cache') })));
    const mutations = { clockMutant: !!options['clock-mutant'], browserMutant: !!options['browser-mutant'] };
    const first = await generateCorpus(resolve(out, 'a'), mutations);
    const second = await generateCorpus(resolve(out, 'b'), mutations);
    assert.deepEqual(first, second, 'V-05 determinism: generator outputs differ between independent invocations');
    for (const record of first) {
        const a = await readFile(resolve(out, 'a', record.invocation, record.file));
        const b = await readFile(resolve(out, 'b', record.invocation, record.file));
        assert.ok(a.equals(b), `V-05 determinism bytes: ${record.id}`);
    }
    report.fixtures = Object.fromEntries(first.map(record => [record.id, record.sha256]));
    report.determinism = { status: 'passed', files: first.length, fixtures: first.map(({ id, sha256, bytes }) => ({ id, sha256, bytes })) };
    if (!options['record-manifests']) {
        const expected = [];
        for (const stream of ['core', 'platform']) {
            const manifest = JSON.parse(await readFile(resolve(REPO, 'verify/fixtures', stream, 'manifest.json'), 'utf8'));
            assert.equal(manifest.schema, 1);
            assert.equal(manifest.stream, stream);
            expected.push(...manifest.fixtures.map(record => ({ stream, ...record })));
        }
        const observed = first.map(record => {
            if (!options['browser-mutant'] || record.id !== 'core/vault-100/vault-100.json') {
                return record;
            }
            const baseline = expected.find(entry => entry.id === record.id);
            assert.ok(baseline, 'The browser mutant lost its baseline fixture identity');
            assert.notEqual(record.sha256, baseline.sha256, 'The browser mutant did not change the seeded vault; V-05 is unproven');
            report.mutatedInput = { id: record.id, member: 'Every construct.md', originalSha256: baseline.sha256, mutantSha256: record.sha256, operation: 'checker embed renamed to absent missing-v05-mutant.png by the scratch vault generator' };
            // Only the declared mutant's bytes differ. All other identities, including this
            // record's generator/version/seed, remain under the ordinary frozen-manifest check.
            return { ...record, sha256: baseline.sha256, bytes: baseline.bytes };
        });
        assert.deepEqual(observed.sort((a, b) => compareNames(a.id, b.id)), expected.sort((a, b) => compareNames(a.id, b.id)), 'VER-06: generated fixture identity changed; review the corpus, do not weaken its gate');
        const pdfManifest = JSON.parse(await readFile(resolve(REPO, 'verify/fixtures/pdf/manifest.json'), 'utf8'));
        const aliases = pdfManifest.fixtures.filter(record => record.canonicalManifest === 'verify/fixtures/platform/manifest.json');
        assert.deepEqual(aliases.map(({ id, sha256, bytes }) => ({ id, sha256, bytes })).sort((a, b) => compareNames(a.id, b.id)), first.filter(record => record.invocation === 'platform/geometry').map(({ id, sha256, bytes }) => ({ id, sha256, bytes })).sort((a, b) => compareNames(a.id, b.id)), 'GEN-01 PDF aliases drifted from the canonical platform corpus');
    }
    const driver = `playwright@${createRequire(import.meta.url)('playwright/package.json').version}`;
    assert.equal(driver, pin.driver, 'Wrong installed Playwright driver identity');
    browser = await chromium.launch({ executablePath, headless: true });
    assert.equal(browser.version(), pin.version, 'Wrong browser identity');
    report.browser = { version: browser.version(), executablePath, driver, app: origin.origin, reloadArm: 'none; fresh context only' };
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    binding = await bindServedBodies(context, { identity: report.build, origin: origin.origin, mode: 'raw-route', buildMode: 'production', report: ledger,
        blockExternalOrigins: options['block-external'] ? ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'] : [],
    });
    await installVault(context, { name: 'V05-Fixture' });
    page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin.href);
    const vault = JSON.parse(await readFile(resolve(out, 'a/core/vault-100/vault-100.json'), 'utf8'));
    const pdf = await readFile(resolve(out, 'a/platform/geometry/geometry.pdf'));
    const files = Object.fromEntries(vault.files.map(entry => [entry.path, entry.encoding === 'base64' ? Buffer.from(entry.content, 'base64') : entry.content]));
    files['geometry.pdf'] = pdf;
    files['Mixed 10000 save-path.md'] = await readFile(resolve(out, 'a/core/save-path/Mixed 10000 save-path.md'));
    files['.Assets/save-only.png'] = await readFile(resolve(out, 'a/core/save-path/.Assets/save-only.png'));
    await seedVault(page, { name: 'V05-Fixture', files });
    report.stage = 'browser-note';
    await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
    await page.locator('.tree-file').filter({ has: page.locator('.tree-item-label', { hasText: /^Every construct$/ }) }).click();
    const content = page.locator('.cm-content[contenteditable="false"]');
    await content.waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent?.includes('BME-CONSTRUCTS-v1'));
    report.note = { path: 'Every construct.md', mode: 'Reading', vaultNotes: vault.noteCount, screenshot: 'constructs-reading-top.png', imagesDecoded: false };
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: resolve(out, 'constructs-reading-top.png') });
    const scroller = page.locator('.cm-scroller');
    let imageWitness = false;
    for (const fraction of [0.3, 0.4, 0.65, 1]) {
        await scroller.evaluate((element, fraction) => { element.scrollTop = (element.scrollHeight - element.clientHeight) * fraction; }, fraction);
        await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
        await page.evaluate(() => document.fonts.ready);
        if (await page.locator('.cm-image-widget img').count()) {
            await page.waitForFunction(() => document.querySelector('.cm-image-placeholder.error') || [...document.querySelectorAll('.cm-image-widget img')].every(image => image.complete && image.naturalWidth > 0));
            imageWitness = true;
        }
        await binding.check();
        assert.equal(await page.locator('.cm-image-placeholder.error').count(), 0, 'BROWSER witness: generated note has a missing asset');
        await page.screenshot({ path: resolve(out, `constructs-reading-${fraction}.png`) });
    }
    await binding.check();
    ledger.assert('note rendered its authored checker image', true, imageWitness);
    await scroller.evaluate(element => { element.scrollTop = 0; });
    await binding.check();
    assert.equal(await page.evaluate(() => !!window.BME_FIXTURE_EXECUTED), false, 'Literal HTML fixture executed');
    report.note.imagesDecoded = true;
    report.stage = 'browser-pdf';
    await page.locator('.tree-file').filter({ has: page.locator('.tree-item-label', { hasText: /^geometry\.pdf$/ }) }).click();
    await page.locator('.pdf-viewer').waitFor({ state: 'visible' });
    await page.waitForFunction(() => [...document.querySelectorAll('.pdf-viewer-page canvas')].some(canvas => canvas.width > 0 && canvas.height > 0));
    await page.waitForFunction(() => document.querySelector('.pdf-viewer-page .textLayer')?.textContent?.includes('GEN-01-p01-control-r0'));
    await page.evaluate(() => document.fonts.ready);
    // Read the compositor's screenshot, not the app canvas's drawing context: acquiring a
    // context changes the surface and would fail outright when this pane becomes WebGL.
    const pagePng = PNG.sync.read(await page.locator('.pdf-viewer-page canvas').first().screenshot({ path: resolve(out, 'geometry-page.png') }));
    let nonWhite = 0;
    let colored = 0;
    for (let i = 0; i < pagePng.data.length; i += 4) {
        const [r, g, b, a] = pagePng.data.subarray(i, i + 4);
        if (a && Math.min(r, g, b) < 200) nonWhite++;
        if (a && Math.max(r, g, b) - Math.min(r, g, b) > 100) colored++;
    }
    const pixels = { nonWhite, colored, width: pagePng.width, height: pagePng.height, source: 'Playwright canvas-element screenshot' };
    await binding.check();
    ledger.assert('PDF pane painted its fiducials', true, pixels.nonWhite > 100 && pixels.colored > 100);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: resolve(out, 'geometry-pdf.png') });
    await binding.check();
    assert.deepEqual(errors, [], 'The app raised page errors');
    report.pdf = { path: 'geometry.pdf', pane: 'pdf-viewer', engine: 'classic pdf.js', marker: 'GEN-01-p01-control-r0', pixels, screenshot: 'geometry-pdf.png' };
    report.savePath = { path: 'Mixed 10000 save-path.md', asset: '.Assets/save-only.png', screenshots: [] };
    for (const theme of ['dark', 'light']) {
        if (theme === 'light') await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click();
        await page.waitForFunction(theme => (document.documentElement.dataset.theme ?? 'dark') === theme, theme);
        await page.locator('.tree-file').filter({ has: page.locator('.tree-item-label', { hasText: /^Mixed 10000 save-path$/ }) }).click();
        await page.waitForFunction(() => [...document.querySelectorAll('.cm-content')].some(element => getComputedStyle(element).visibility === 'visible' && element.textContent.includes('BME-SAVE-PATH-v1')));
        const image = page.locator('.cm-image-widget.cm-image-loaded img:visible').first();
        await image.waitFor({ state: 'visible' });
        await image.evaluate(image => image.decode());
        await page.evaluate(() => document.fonts.ready);
        await binding.check();
        ledger.assert(`save-path unique image rendered in ${theme}`, 32, await image.evaluate(image => image.naturalWidth));
        await page.mouse.move(0, 0);
        const screenshot = `save-path-${theme}.png`;
        await page.screenshot({ path: resolve(out, screenshot), animations: 'disabled' });
        report.savePath.screenshots.push(screenshot);
    }
    await page.locator('.tree-file').filter({ has: page.locator('.tree-item-label', { hasText: /^Every construct$/ }) }).click();
    await page.locator('.cm-content[contenteditable="false"]:visible').waitFor({ state: 'visible' });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: resolve(out, 'constructs-reading-light.png'), animations: 'disabled' });
    await binding.check();
    ledger.assert('no page errors across both themes', [], errors);
    if (options['record-manifests'])
        await recordManifests(first);
    report.status = 'passed';
}
catch (error) {
    ledger.fail(error);
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
    if (binding) {
        try {
            const served = await binding.check();
            report.network.blockedUrls = served.blocked.map(row => row.url);
        } catch (error) { ledger.fail(error); report.status = 'failed'; process.exitCode = 1; }
        await binding.stop();
    }
    await browser?.close();
    report.ledgerPath = await ledger.finish();
    await writeFile(resolve(out, 'report.json'), jsonBytes(report));
    process.stdout.write(`${JSON.stringify(report)}\n`);
}
