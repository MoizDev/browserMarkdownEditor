// Browser-only gate: inputs and observations go through the real production app.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

const { values } = parseArgs({ options: {
  url: { type: 'string', default: 'http://localhost:6520/' },
  out: { type: 'string', default: '/Users/adham/Developer/bme-impl/scratch/w-b/w-01' },
  chrome: { type: 'string', default: '/Users/adham/Developer/bme-impl/scratch/browsers/157.0.8103.39/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' },
  theme: { type: 'string', default: 'dark' },
  dpr: { type: 'string', default: '1' },
} });
const out = resolve(values.out);
await mkdir(out, { recursive: true });
const old = await readFile(new URL('./fixtures/old.tldraw', import.meta.url), 'utf8');
const native = '{"format":"board","version":[1,0],"kind":"whiteboard","fence":"compat-1: compatibility fence, holds no content, so that builds of this app from before the guard release refuse to edit this file","document":{"schema":{"schemaVersion":999},"store":{}},"records":[\n'
  + '{"type":"sheet","id":"Qm3vL8a0Zt","name":"zebracorn","order":"a0"},\n'
  + '{"type":"end","count":1}\n]}\n';
const report = { gate: 'W-01', theme: values.theme, dpr: Number(values.dpr), agent: 'NOT COVERED (pending-V02)', checks: {}, failures: [], pageErrors: [], network: [] };
const browser = await chromium.launch({ headless: true, executablePath: values.chrome });
report.browser = browser.version();
assert.equal(report.browser, '157.0.8103.39', 'Functional browser pin changed');
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: Number(values.dpr) });
const page = await context.newPage();
const chunks = [];
page.on('response', response => {
  if (/\/assets\/index-[^/]+\.js$/.test(response.url())) chunks.push(response);
  report.network.push({ url: response.url(), status: response.status() });
});
page.on('pageerror', error => report.pageErrors.push(error.message));
const instrument = ({ theme, vaultName }) => {
  localStorage.setItem('theme', theme);
  const grant = h => {
    h.queryPermission = async () => 'granted';
    h.requestPermission = async () => 'granted';
    return h;
  };
  const getDir = FileSystemDirectoryHandle.prototype.getDirectoryHandle;
  FileSystemDirectoryHandle.prototype.getDirectoryHandle = async function (...args) {
    return grant(await getDir.apply(this, args));
  };
  window.showDirectoryPicker = async () => grant(await (await navigator.storage.getDirectory()).getDirectoryHandle(vaultName, { create: true }));
  window.__w01Writes = [];
  const writable = FileSystemFileHandle.prototype.createWritable;
  FileSystemFileHandle.prototype.createWritable = async function (...args) {
    window.__w01Writes.push(this.name);
    return writable.apply(this, args);
  };
};
await page.addInitScript(instrument, { theme: values.theme, vaultName: 'W01-vault' });

const check = async (name, action) => {
  try { report.checks[name] = await action() ?? true; }
  catch (error) { report.checks[name] = false; report.failures.push(`${name}: ${error.message}`); }
};
try {
  await page.goto(values.url);
  // The scratch build emits this receipt; matching it to the network response
  // prevents an old server on the right port from answering for the candidate.
  await check('identity', async () => {
    const receipt = await (await page.request.get(new URL('w01-build.json', values.url).href)).json();
    assert.match(receipt.commit, /^[0-9a-f]{40}$/);
    assert.equal(receipt.mode, 'production');
    const entries = chunks.filter(response => new URL(response.url()).pathname === `/${receipt.mainFile}`);
    assert.equal(entries.length, 1, 'Expected the application entry chunk from the network');
    const main = entries[0];
    const sha256 = createHash('sha256').update(await main.body()).digest('hex');
    assert.equal(sha256, receipt.mainSha256, 'Fetched main chunk differs from build receipt');
    report.identity = { ...receipt, mainUrl: main.url(), observedMainSha256: sha256, engine: 'legacy-tldraw-host', backend: 'production-browser' };
  });
  await page.evaluate(async ({ native, old }) => {
    const vault = await (await navigator.storage.getDirectory()).getDirectoryHandle('W01-vault', { create: true });
    for (const [name, content] of Object.entries({ 'board.drawing': native, 'old.tldraw': old, 'note.md': '# Note\npositivecontrol\n' })) {
      const stream = await (await vault.getFileHandle(name, { create: true })).createWritable();
      await stream.write(content);
      await stream.close();
    }
    const trash = await vault.getDirectoryHandle('.Garbage', { create: true });
    for (const [name, content] of [['trashed.drawing', native], ['trashed.tldraw', old]]) {
      const stream = await (await trash.getFileHandle(name, { create: true })).createWritable();
      await stream.write(content);
      await stream.close();
    }
  }, { native, old });
  await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
  const board = page.locator('.tree-item').filter({ hasText: /^board\.drawing$/ });
  await board.waitFor();
  await check('drawing-icon', async () => {
    const icon = await board.locator('.tree-item-icon > svg').innerHTML();
    const legacyIcon = await page.locator('.tree-item').filter({ hasText: /^old\.tldraw$/ }).locator('.tree-item-icon > svg').innerHTML();
    report.legacyDrawingIcon = legacyIcon;
    assert.equal(icon, legacyIcon, 'Native and legacy drawing icons differ');
    return { sameAsLegacy: true, svg: icon };
  });
  await board.click();
  await page.locator('.editor-slot').waitFor();
  await check('unsupported-editor', async () => {
    await page.locator('.unread-pane').waitFor({ timeout: 5000 });
    assert.match(await page.locator('.unread-pane').innerText(), /not supported|cannot open|can’t open/i);
    assert.equal(await page.locator('.cm-editor').count(), 0, 'A native drawing reached CodeMirror');
    assert.equal(await page.locator('.tl-container').count(), 0, 'A native drawing reached tldraw');
  });
  await page.evaluate(() => { window.__w01Writes = []; });
  await page.keyboard.press('Meta+e');
  const slot = await page.locator('.editor-slot-body').boundingBox();
  assert.ok(slot, 'Drawing slot was not shown');
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('a');
    await page.mouse.move(slot.x + 100, slot.y + 140 + i * 5);
    await page.mouse.down();
    await page.mouse.move(slot.x + 250, slot.y + 145 + i * 5, { steps: 3 });
    await page.mouse.up();
  }
  // More than the canvas serialization + App autosave debounce. Reading the
  // bytes as well catches a write that an instrumentation mistake hid.
  await page.waitForTimeout(2500);
  await check('zero-writes', async () => {
    const observed = await page.evaluate(async () => {
      const vault = await (await navigator.storage.getDirectory()).getDirectoryHandle('W01-vault');
      return { writes: window.__w01Writes, bytes: await (await (await vault.getFileHandle('board.drawing')).getFile()).text() };
    });
    report.nativeWriteObservation = {
      writes: observed.writes,
      changed: observed.bytes !== native,
      expectedSha256: createHash('sha256').update(native).digest('hex'),
      observedSha256: createHash('sha256').update(observed.bytes).digest('hex'),
    };
    assert.deepEqual(observed.writes.filter(name => name === 'board.drawing'), []);
    assert.equal(observed.bytes, native, 'Native bytes changed after attempted editing');
    return { attempts: 20, writes: observed.writes, unchanged: true };
  });
  await page.screenshot({ path: resolve(out, 'unsupported.png') });
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const search = page.getByRole('textbox', { name: 'Search vault', exact: true });
  await search.fill('positivecontrol');
  await check('search-witness', async () => {
    const note = page.locator('.search-file-group').filter({ has: page.locator('.search-file-name', { hasText: /^note\.md$/ }) });
    // Tree rows use content-visibility; scroll the header into layout before
    // reading it, rather than racing innerText against Blink's skipped row.
    await note.locator('.search-file-header').scrollIntoViewIfNeeded();
    await note.getByText('positivecontrol', { exact: true }).waitFor();
    assert.equal(await note.locator('.search-file-name').textContent(), 'note.md');
  });
  await search.fill('zebracorn');
  await check('search-exclusion', async () => {
    await page.locator('.search-results').getByText('No results for “zebracorn”.', { exact: true }).waitFor({ timeout: 5000 });
    assert.equal(await page.locator('.search-file-group').count(), 0);
  });
  await page.screenshot({ path: resolve(out, 'search.png') });
  // A separate context has no legacy file, stored session or HTTP cache from
  // the control vault. Native files must not warm a renderer they cannot open.
  await check('native-only-prefetch', async () => {
    const nativeContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: Number(values.dpr) });
    const nativePage = await nativeContext.newPage();
    const requests = [];
    const entryResponses = [];
    report.nativeOnlyNetwork = requests;
    nativePage.on('request', request => requests.push(request.url()));
    nativePage.on('response', response => {
      if (new URL(response.url()).pathname === `/${report.identity?.mainFile}`) entryResponses.push(response);
    });
    nativePage.on('pageerror', error => report.pageErrors.push(error.message));
    await nativePage.addInitScript(instrument, { theme: values.theme, vaultName: 'W01-native-only' });
    try {
      await nativePage.goto(values.url);
      await nativePage.evaluate(async native => {
        const vault = await (await navigator.storage.getDirectory()).getDirectoryHandle('W01-native-only', { create: true });
        for (const [name, text] of [['board.drawing', native], ['note.md', '# Native-only vault\n']]) {
          const writable = await (await vault.getFileHandle(name, { create: true })).createWritable();
          await writable.write(text);
          await writable.close();
        }
      }, native);
      await nativePage.getByRole('button', { name: 'Open Vault', exact: true }).click();
      await nativePage.locator('.tree-item').filter({ hasText: /^board\.drawing$/ }).click();
      await nativePage.locator('.editor-slot').waitFor();
      const files = await nativePage.evaluate(async () => {
        const vault = await (await navigator.storage.getDirectory()).getDirectoryHandle('W01-native-only');
        const names = [];
        for await (const name of vault.keys()) names.push(name);
        return names.sort();
      });
      assert.deepEqual(files, ['board.drawing', 'note.md'], 'Native-only arm gained a legacy drawing');
      // App's idle prefetch has a 4s deadline. Wait beyond it, then observe two
      // real idle callbacks: a fast empty network snapshot is not evidence.
      await nativePage.waitForTimeout(4500);
      const idlePasses = await nativePage.evaluate(async () => {
        let passes = 0;
        for (let i = 0; i < 2; i++) await new Promise(resolve => requestIdleCallback(() => { passes++; resolve(); }, { timeout: 4000 }));
        return passes;
      });
      assert.equal(idlePasses, 2, 'Native-only idle witness did not run');
      assert.equal(entryResponses.length, 1, 'Native-only page did not fetch the identified entry');
      assert.equal(createHash('sha256').update(await entryResponses[0].body()).digest('hex'), report.identity.mainSha256);
      const drawingChunks = requests.filter(url => /\/assets\/DrawingPane-[^/]+\.js$/.test(url));
      assert.deepEqual(drawingChunks, [], 'A native-only vault prefetched the legacy DrawingPane chunk');
      return { files, idlePasses, observedForMs: 4500, drawingChunks };
    } finally {
      await nativeContext.close();
    }
  });
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.locator('.tree-item').filter({ hasText: /^old\.tldraw$/ }).click();
  await check('legacy-control', async () => {
    await page.locator('.tl-container').waitFor({ timeout: 15000 });
    await page.locator('.tl-shape').first().waitFor({ timeout: 15000 });
    assert.equal(await page.locator('.cm-editor').count(), 0);
    const drawingChunks = report.network.filter(({ url }) => /\/assets\/DrawingPane-[^/]+\.js$/.test(url));
    assert.ok(drawingChunks.length > 0, 'Legacy control did not fetch its DrawingPane chunk');
    return { mounted: true, shapes: await page.locator('.tl-shape').count(), drawingChunks };
  });
  await page.screenshot({ path: resolve(out, 'legacy.png') });
  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  await check('trash-drawing-icons', async () => {
    const trash = page.getByRole('dialog', { name: 'Trash', exact: true });
    const nativeRow = trash.locator('.trash-row').filter({ hasText: 'trashed.drawing' });
    const legacyRow = trash.locator('.trash-row').filter({ hasText: 'trashed.tldraw' });
    await nativeRow.waitFor();
    const icon = await nativeRow.locator('.tree-item-icon > svg').innerHTML();
    assert.equal(icon, await legacyRow.locator('.tree-item-icon > svg').innerHTML());
    assert.equal(icon, report.legacyDrawingIcon, 'Trash must use the drawing type icon, not the text icon');
  });
  await page.screenshot({ path: resolve(out, 'trash.png') });
  await check('no-page-errors', () => assert.deepEqual(report.pageErrors, []));
} catch (error) {
  report.failures.push(`harness: ${error.stack}`);
} finally {
  await context.close();
  await browser.close();
  await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ ...report, network: `${report.network.length} responses (see report.json)` }, null, 2));
if (report.failures.length) process.exitCode = 1;
