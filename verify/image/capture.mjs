import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { openBrowser } from '../lib/browser.mjs';
import { bindServedBodies } from '../lib/identity.mjs';
import { createReport } from '../lib/report.mjs';
import { installVault, seedVault } from '../lib/vault.mjs';
import { fontsReady } from '../lib/input.mjs';
import { decodePng, sha256 } from '../lib/picture/png.mjs';

const options = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
    if (!['--dist', '--input', '--metadata', '--out', '--dpr', '--theme'].includes(argv[i]) || !argv[i + 1] || options[argv[i]] !== undefined) throw new Error('Expected unique --dist, --input, --metadata, --out and --dpr values');
    options[argv[i]] = argv[i + 1];
}
const dpr = Number(options['--dpr']);
const theme = options['--theme'] ?? 'dark';
if (!['dark', 'light'].includes(theme)) throw new Error('Picture theme must be dark or light');
if (![1, 1.25, 2].includes(dpr) || !options['--dist'] || !options['--input'] || !options['--metadata'] || !options['--out']) throw new Error('Missing picture capture options or unsupported DPR');
const out = resolve(options['--out']);
const dist = resolve(options['--dist']);
const inputBytes = await readFile(options['--input']);
const input = JSON.parse(inputBytes);
const metadata = JSON.parse(await readFile(options['--metadata'], 'utf8'));
const sceneFixture = name => ({ ...input.scenes[name], dpr, theme, scenario: `${input.scenes[name].scenario.replace('default-dark', theme)}/${theme}` });
const files = Object.fromEntries(input.files.map(file => [file.path, file.encoding === 'base64' ? Buffer.from(file.content, 'base64') : file.content]));
const ledger = await createReport({ scratch: out, name: 'V-06-picture', fixtures: { 'input-vault.json': inputBytes, ...files },
    gate: 'V-06', dpr, requestedTheme: theme, image: metadata.image, build: metadata.build,
    environment: { node: process.version, platform: process.platform, arch: process.arch, translation: metadata.translation, translationSource: 'Integrator/operator-declared VM configuration, not inferred from uname' },
    losses: ['One ARM host only; the second-host x86/ARM comparison is not covered.', 'Software WebGL2 offered is an environment check, not a new platform GPU golden.', 'Functional raw-byte interception disables HTTP cache; these are not signed benchmark timings.'],
});
const report = ledger.data;
const captureStarted = performance.now();
report.costEstimateOnly = 'UNQUALIFIED environment-cost reading, not a benchmark or signed performance comparison';
report.status = 'failed';
report.frames = [];
report.captureOptions = { animations: 'disabled', caret: 'hide', scale: 'device' };
let browserRun;
let binding;
let page;
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.png': 'image/png', '.svg': 'image/svg+xml' };
const contrastingPixels = image => {
    let count = 0;
    for (let i = 0; i < image.data.length; i += 4) {
        if (Math.max(Math.abs(image.data[i] - image.data[0]), Math.abs(image.data[i + 1] - image.data[1]), Math.abs(image.data[i + 2] - image.data[2])) > 32) count++;
    }
    return count;
};
const server = createServer(async (request, response) => {
    try {
        const path = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
        const relative = path === '/' ? 'index.html' : path.slice(1);
        const file = resolve(dist, relative);
        if (!file.startsWith(`${dist}/`) || relative.split('/').some(part => part === '..' || part.includes('\\'))) throw new Error('Unsafe path');
        const bytes = await readFile(file);
        response.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream', 'Content-Length': bytes.length });
        response.end(bytes);
    } catch {
        response.writeHead(404);
        response.end();
    }
});

try {
    if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('The picture gate must execute in the pinned Linux amd64 image');
    if (!['rosetta', 'qemu', 'native-x86'].includes(metadata.translation)) throw new Error('Declare the actual VM translation method');
    const fontManifestBytes = await readFile('/opt/fonts/manifest.json');
    if (sha256(fontManifestBytes) !== metadata.image.fontManifestSha256) throw new Error('Image font manifest differs from the lock');
    const fontManifest = JSON.parse(fontManifestBytes);
    for (const font of fontManifest.fonts) {
        const bytes = await readFile(`/opt/fonts/files/${font.file}`);
        if (bytes.length !== font.bytes || sha256(bytes) !== font.sha256) throw new Error(`Image font changed: ${font.file}`);
    }
    report.fontEnvironment = {
        manifestSha256: sha256(fontManifestBytes), files: fontManifest.fonts.length,
        configuredFaces: await readFile('/opt/fonts/fontconfig-list.txt', 'utf8'),
        policy: 'Only repository-shipped faces; absent platform families use the explicitly configured bundled fallback, never downloaded/system fonts',
    };
    const fontLines = report.fontEnvironment.configuredFaces.trim().split('\n');
    if (!fontLines.length || fontLines.some(line => !line.startsWith('/opt/fonts/files/'))) throw new Error('Fontconfig sees an unreviewed system font');
    await new Promise((accept, reject) => { server.once('error', reject); server.listen(6180, '127.0.0.1', accept); });
    const origin = 'http://127.0.0.1:6180';
    browserRun = await openBrowser({ executablePath: '/opt/chrome-linux64/chrome',
        contextOptions: { viewport: { width: 1440, height: 1000 }, deviceScaleFactor: dpr, locale: 'en-US', timezoneId: 'UTC' },
        launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--force-color-profile=srgb'] },
    });
    report.browser = browserRun.identity;
    const probe = await browserRun.context.newPage();
    report.softwareWebgl = await probe.evaluate(() => {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: false });
        if (!gl) return { offered: false };
        const debug = gl.getExtension('WEBGL_debug_renderer_info');
        const result = { offered: true, renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR), version: gl.getParameter(gl.VERSION), attributes: gl.getContextAttributes() };
        gl.getExtension('WEBGL_lose_context')?.loseContext();
        return result;
    });
    await probe.close();
    await installVault(browserRun.context, { name: input.name });
    binding = await bindServedBodies(browserRun.context, { identity: metadata.build, origin, mode: 'raw-route', buildMode: 'production', report: ledger,
        blockExternalOrigins: ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'],
    });
    page = await browserRun.context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    report.actualDpr = await page.evaluate(() => window.devicePixelRatio);
    await binding.check();
    ledger.assert('browser DPR is the declared picture DPR', dpr, report.actualDpr);
    await binding.check();
    ledger.assert('image browser offers WebGL2', true, report.softwareWebgl.offered);
    await binding.check();
    ledger.assert('software renderer is SwiftShader, not silent 2D/native GPU', true, /swiftshader/i.test(report.softwareWebgl.renderer ?? ''));
    await seedVault(page, { name: input.name, files });
    await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
    if (theme === 'light') await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click();
    await page.waitForFunction(theme => (document.documentElement.dataset.theme ?? 'dark') === theme, theme);
    await page.locator('.tree-file').filter({ has: page.locator('.tree-item-label', { hasText: /^Every construct$/ }) }).click();
    await page.locator('.cm-content[contenteditable="false"]').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent?.includes('BME-CONSTRUCTS-v1'));
    await fontsReady(page);
    await page.mouse.move(0, 0);
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    await binding.check();
    ledger.assert('real note opened in Reading mode', true, await page.locator('.cm-content[contenteditable="false"]').isVisible());
    report.theme = await page.evaluate(() => document.documentElement.dataset.theme ?? 'dark');
    await binding.check();
    ledger.assert('declared fixture theme', theme, report.theme);
    const noteMarker = await page.locator('.cm-line').filter({ hasText: 'BME-CONSTRUCTS-v1' }).screenshot({ path: resolve(out, 'note-marker.png'), ...report.captureOptions });
    await binding.check();
    ledger.assert('note marker actually paints contrasting pixels', true, contrastingPixels(decodePng(noteMarker)) > 10);
    const note = await page.locator('.cm-scroller').screenshot({ path: resolve(out, 'note.png'), ...report.captureOptions });
    report.frames.push({ name: 'note', file: 'note.png', fixture: sceneFixture('note'), sha256: sha256(note) });
    report.requestedBodyFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    try {
        const session = await browserRun.context.newCDPSession(page);
        await session.send('DOM.enable');
        await session.send('CSS.enable');
        const { root } = await session.send('DOM.getDocument', { depth: 0 });
        const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.cm-content' });
        report.notePlatformFonts = (await session.send('CSS.getPlatformFontsForNode', { nodeId })).fonts;
        await session.detach();
    } catch (error) { report.fontReadoutLoss = error.message; }
    await page.locator('.tree-file').filter({ has: page.locator('.tree-item-label', { hasText: /^geometry\.pdf$/ }) }).click();
    await page.locator('.pdf-viewer').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('.pdf-viewer-page .textLayer')?.textContent?.includes('GEN-01-p01-control-r0'));
    await page.waitForFunction(() => document.querySelector('.pdf-viewer-page canvas')?.width > 0);
    await fontsReady(page);
    const pdf = await page.locator('.pdf-viewer-page canvas').first().screenshot({ path: resolve(out, 'pdf.png'), ...report.captureOptions });
    const pdfImage = decodePng(pdf);
    let colored = 0;
    for (let i = 0; i < pdfImage.data.length; i += 4) {
        if (Math.max(pdfImage.data[i], pdfImage.data[i + 1], pdfImage.data[i + 2]) - Math.min(pdfImage.data[i], pdfImage.data[i + 1], pdfImage.data[i + 2]) > 100) colored++;
    }
    await binding.check();
    ledger.assert('real PDF has colored fiducial pixels', true, colored > 100);
    report.frames.push({ name: 'pdf', file: 'pdf.png', fixture: { ...sceneFixture('pdf'), background: [255, 255, 255] }, sha256: sha256(pdf) });
    await page.locator('.tree-file').filter({ has: page.locator('.tree-item-label', { hasText: /^classic-one-stroke(?:\.tldraw)?$/ }) }).click();
    const drawing = page.locator('.tl-container');
    await drawing.waitFor({ state: 'visible' });
    await page.locator('.tl-shape[data-shape-type="draw"]').waitFor({ state: 'visible' });
    await fontsReady(page);
    await page.mouse.move(0, 0);
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    await binding.check();
    ledger.assert('the real classic drawing contains its authored stroke', 1, await page.locator('.tl-shape[data-shape-type="draw"]').count());
    const box = await page.locator('.tl-shape[data-shape-type="draw"]').boundingBox();
    if (!box) throw new Error('Visible stroke has no screen bounds');
    // Include paper around even a horizontal stroke: a tight all-black box is real ink,
    // not a blank surface, but has no internal variance by which to witness its paint.
    const x = Math.max(0, box.x - 4), y = Math.max(0, box.y - 4);
    const clip = { x, y, width: Math.min(1440 - x, box.width + 8), height: Math.min(1000 - y, box.height + 8) };
    const inkBytes = await page.screenshot({ path: resolve(out, 'drawing-ink.png'), clip, ...report.captureOptions });
    await binding.check();
    ledger.assert('stroke paints contrasting pixels, not just an empty shape DOM', true, contrastingPixels(decodePng(inkBytes)) > 10);
    const drawingBytes = await drawing.screenshot({ path: resolve(out, 'drawing.png'), ...report.captureOptions });
    report.frames.push({ name: 'drawing', file: 'drawing.png', fixture: sceneFixture('drawing'), sha256: sha256(drawingBytes) });
    await binding.check();
    ledger.assert('the app raised no page errors', [], errors);
    report.status = 'passed';
} catch (error) {
    ledger.fail(error);
    report.error = error.stack;
    process.exitCode = 1;
    if (page && !page.isClosed()) await page.screenshot({ path: resolve(out, 'failure.png'), ...report.captureOptions }).catch(() => {});
} finally {
    if (binding) {
        try { await binding.check(); } catch (error) { ledger.fail(error); report.status = 'failed'; process.exitCode = 1; }
        await binding.stop();
    }
    await browserRun?.close();
    await new Promise(accept => server.close(accept));
    try {
        report.peakContainerBytes = Number((await readFile('/sys/fs/cgroup/memory.peak', 'utf8')).trim());
        if (!Number.isSafeInteger(report.peakContainerBytes) || report.peakContainerBytes <= 0) {
            report.peakContainerBytes = null;
            report.memoryLoss = 'invalid cgroup peak value';
        }
    } catch (error) { report.peakContainerBytes = null; report.memoryLoss = `cgroup peak unavailable: ${error.message}`; }
    report.elapsedMs = performance.now() - captureStarted;
    report.reportPath = await ledger.finish();
    await writeFile(resolve(out, 'capture.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    process.stdout.write(`${JSON.stringify({ status: report.status, dpr, frames: report.frames, peakContainerBytes: report.peakContainerBytes, report: report.reportPath })}\n`);
}
