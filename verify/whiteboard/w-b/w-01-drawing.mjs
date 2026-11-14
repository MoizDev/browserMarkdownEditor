// Browser-only gate: inputs and observations go through the real production app.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, realpath, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

const { values } = parseArgs({ options: {
  url: { type: 'string', default: 'http://localhost:6520/' },
  out: { type: 'string', default: '/Users/adham/Developer/bme-impl/scratch/w-b/w-01' },
  chrome: { type: 'string', default: '/Users/adham/Developer/bme-impl/scratch/browsers/157.0.8103.39/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' },
  theme: { type: 'string', default: 'dark' },
  dpr: { type: 'string', default: '1' },
  'expected-commit': { type: 'string' },
  'expected-diff': { type: 'string', default: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
  'expected-mutant': { type: 'string', default: 'none' },
} });
const out = resolve(values.out);
await mkdir(out, { recursive: true });
const worktree = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { gate: 'W-01', theme: values.theme, dpr: Number(values.dpr), agent: 'NOT COVERED (pending-V02)', checks: {}, failures: [], pageErrors: [], network: [] };
const old = await readFile(new URL('./fixtures/old.tldraw', import.meta.url), 'utf8');
const native = '{"format":"board","version":[1,0],"kind":"whiteboard","fence":"compat-1: compatibility fence, holds no content, so that builds of this app from before the guard release refuse to edit this file","document":{"schema":{"schemaVersion":999},"store":{}},"records":[\n'
  + '{"type":"sheet","id":"Qm3vL8a0Zt","name":"zebracorn","order":"a0"},\n'
  + '{"type":"end","count":1}\n]}\n';
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
const check = async (name, action) => {
  try { report.checks[name] = await action() ?? true; }
  catch (error) { report.checks[name] = false; report.failures.push(`${name}: ${error.message}`); }
};
let browser;
const contexts = [];
let expected;
const drawingChunks = urls => urls.filter(url => /\/assets\/DrawingPane-[^/]+\.js$/.test(url));
const createPage = async vaultName => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: Number(values.dpr) });
  contexts.push(context);
  const page = await context.newPage();
  const responses = [];
  const requests = [];
  page.on('response', response => responses.push(response));
  page.on('request', request => requests.push(request.url()));
  page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.addInitScript(instrument, { theme: values.theme, vaultName });
  return { context, page, responses, requests, vaultName };
};
const seed = async (arm, files) => arm.page.evaluate(async ({ vaultName, files }) => {
  const vault = await (await navigator.storage.getDirectory()).getDirectoryHandle(vaultName, { create: true });
  for (const [name, text] of Object.entries(files)) {
    const writable = await (await vault.getFileHandle(name, { create: true })).createWritable();
    await writable.write(text);
    await writable.close();
  }
}, { vaultName: arm.vaultName, files });
const identify = async arm => {
  const response = await arm.page.request.get(new URL('w01-build.json', values.url).href);
  assert.equal(response.status(), 200, 'Missing build receipt');
  const receipt = await response.json();
  // The expected tree and patch come from the reviewed local git checkout and
  // committed patch file, not from anything the HTTP server says about itself.
  for (const [key, value] of Object.entries(expected)) assert.equal(receipt[key], value, `Wrong build ${key}`);
  const entry = arm.responses.filter(response => new URL(response.url()).pathname === `/${receipt.mainFile}`);
  assert.equal(entry.length, 1, 'Expected one identified entry response');
  const observedMainSha256 = sha256(await entry[0].body());
  assert.equal(observedMainSha256, receipt.mainSha256, 'Entry network bytes differ from the identified build');
  return { ...receipt, mainUrl: entry[0].url(), observedMainSha256 };
};

try {
  const git = args => execFileSync('git', args, { cwd: worktree });
  const commit = values['expected-commit'];
  assert.match(commit ?? '', /^[0-9a-f]{40}$/, '--expected-commit must name the reviewed full commit');
  assert.equal(git(['rev-parse', 'HEAD']).toString().trim(), commit, 'Checkout is not the reviewed expected commit');
  assert.equal(git(['ls-files', '--others', '--exclude-standard', 'src']).length, 0, 'Untracked app source');
  const sourceDiffSha256 = sha256(git(['diff', commit, '--', 'src']));
  assert.equal(sourceDiffSha256, values['expected-diff'], 'Local source diff differs from the expected build');
  const kind = values['expected-mutant'];
  assert.ok(['none', 'registration', 'prefetch'].includes(kind), 'Unknown expected mutant');
  const mutant = kind === 'none' ? null : kind;
  const patchFile = mutant ? `verify/whiteboard/w-b/mutants/${mutant}.patch` : null;
  let patchSha256 = null;
  if (patchFile) {
    const diskPatch = await readFile(resolve(worktree, patchFile));
    const reviewedPatch = git(['show', `${commit}:${patchFile}`]);
    assert.deepEqual(diskPatch, reviewedPatch, 'Local mutant patch is not the committed reviewed patch');
    patchSha256 = sha256(reviewedPatch);
  }
  expected = { commit, sourceDiffSha256, mutant, patchFile, patchSha256, mode: 'production' };
  report.expected = expected;
  const require = createRequire(import.meta.url);
  const driverPath = require.resolve('playwright/package.json');
  const driver = JSON.parse(await readFile(driverPath, 'utf8'));
  const pin = JSON.parse(await readFile(new URL('../../browser-pin.json', import.meta.url), 'utf8'));
  assert.equal(driver.version, '1.63.0', 'Installed Playwright pin changed');
  assert.equal(pin.driver, 'playwright@1.63.0');
  assert.equal(pin.version, '157.0.8103.39');
  const expectedChrome = await realpath(resolve('/Users/adham/Developer/bme-impl/scratch/browsers', pin.version, pin.executable));
  const actualChrome = await realpath(values.chrome);
  assert.equal(actualChrome, expectedChrome, 'Wrong CfT executable path');
  report.runtime = { playwright: driver.version, playwrightPackage: driverPath, expectedChrome, launchedChrome: actualChrome, expectedBrowserVersion: pin.version };
  browser = await chromium.launch({ headless: true, executablePath: actualChrome });
  report.runtime.browserVersion = browser.version();
  assert.equal(browser.version(), pin.version, 'Launched CfT version changed');

  const main = await createPage('W01-vault');
  const page = main.page;
  page.on('response', response => report.network.push({ url: response.url(), status: response.status() }));
  await page.goto(values.url);
  await check('identity', async () => { report.identity = await identify(main); });
  if (!report.checks.identity) throw new Error('Refusing to credit observations from an unexpected build');
  await seed(main, { 'board.drawing': native, 'old.tldraw': old, 'note.md': '# Note\npositivecontrol\n' });
  await page.evaluate(async ({ native, old }) => {
    const vault = await (await navigator.storage.getDirectory()).getDirectoryHandle('W01-vault');
    const trash = await vault.getDirectoryHandle('.Garbage', { create: true });
    for (const [name, text] of [['trashed.drawing', native], ['trashed.tldraw', old]]) {
      const writable = await (await trash.getFileHandle(name, { create: true })).createWritable();
      await writable.write(text);
      await writable.close();
    }
    window.__w01Writes = [];
  }, { native, old });
  await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
  const board = page.locator('.tree-item').filter({ hasText: /^board\.drawing$/ });
  await board.waitFor();
  await check('drawing-icon', async () => {
    const icon = await board.locator('.tree-item-icon > svg').innerHTML();
    const legacyIcon = await page.locator('.tree-item').filter({ hasText: /^old\.tldraw$/ }).locator('.tree-item-icon > svg').innerHTML();
    report.legacyDrawingIcon = legacyIcon;
    assert.equal(icon, legacyIcon, 'Native and legacy drawing icons differ');
    return { sameAsLegacy: true };
  });
  await board.click();
  await page.locator('.editor-slot').waitFor();
  await check('unsupported-editor', async () => {
    await page.locator('.unread-pane').waitFor({ timeout: 5000 });
    assert.match(await page.locator('.unread-pane').innerText(), /not supported|cannot open|can’t open/i);
    assert.equal(await page.locator('.cm-editor').count(), 0, 'A native drawing reached CodeMirror');
    assert.equal(await page.locator('.tl-container').count(), 0, 'A native drawing reached tldraw');
  });
  // Observe search before attempted edits, so the write mutant cannot destroy
  // its own search marker and accidentally pass the independent exclusion arm.
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const search = page.getByRole('textbox', { name: 'Search vault', exact: true });
  await search.fill('positivecontrol');
  await check('search-witness', async () => {
    const note = page.locator('.search-file-group').filter({ has: page.locator('.search-file-name', { hasText: /^note\.md$/ }) });
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
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await board.click();
  await page.keyboard.press('Meta+e');
  const slot = await page.locator('.editor-slot-body').boundingBox();
  assert.ok(slot, 'Drawing slot was not shown');
  // The same click/keys go to the unsupported slot or the mutant's real editor.
  await page.mouse.click(slot.x + 100, slot.y + 140);
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('a');
    await page.mouse.move(slot.x + 100, slot.y + 140 + i * 5);
    await page.mouse.down();
    await page.mouse.move(slot.x + 250, slot.y + 145 + i * 5, { steps: 3 });
    await page.mouse.up();
  }
  await page.waitForTimeout(2500);
  await check('zero-writes', async () => {
    const observed = await page.evaluate(async () => {
      const vault = await (await navigator.storage.getDirectory()).getDirectoryHandle('W01-vault');
      return { writes: window.__w01Writes, bytes: await (await (await vault.getFileHandle('board.drawing')).getFile()).text() };
    });
    report.nativeWriteObservation = { writes: observed.writes, changed: observed.bytes !== native, expectedSha256: sha256(native), observedSha256: sha256(observed.bytes) };
    assert.deepEqual(observed.writes.filter(name => name === 'board.drawing'), []);
    assert.equal(observed.bytes, native, 'Native bytes changed after opening or attempted editing');
    return { attempts: 20, unchanged: true };
  });
  await page.screenshot({ path: resolve(out, 'unsupported.png') });

  // Both fresh contexts have the same no-click observation window. In
  // particular, the legacy control cannot fetch its renderer by opening it.
  const nativeArm = await createPage('W01-native-only');
  const legacyArm = await createPage('W01-legacy-only');
  const arms = [nativeArm, legacyArm];
  try {
    await Promise.all(arms.map(arm => arm.page.goto(values.url)));
    await Promise.all([
      seed(nativeArm, { 'board.drawing': native, 'note.md': '# Native-only vault\n' }),
      seed(legacyArm, { 'old.tldraw': old }),
    ]);
    await Promise.all(arms.map(arm => arm.page.getByRole('button', { name: 'Open Vault', exact: true }).click()));
    await nativeArm.page.locator('.tree-item').filter({ hasText: /^board\.drawing$/ }).waitFor();
    await legacyArm.page.locator('.tree-item').filter({ hasText: /^old\.tldraw$/ }).waitFor();
    await Promise.all(arms.map(arm => arm.page.waitForTimeout(4500)));
    const idlePasses = await Promise.all(arms.map(arm => arm.page.evaluate(async () => {
      let passes = 0;
      for (let i = 0; i < 2; i++) await new Promise(resolve => requestIdleCallback(() => { passes++; resolve(); }, { timeout: 4000 }));
      return passes;
    })));
    report.prefetch = [];
    for (const [i, arm] of arms.entries()) {
      const files = await arm.page.evaluate(async vaultName => {
        const vault = await (await navigator.storage.getDirectory()).getDirectoryHandle(vaultName);
        const names = [];
        for await (const name of vault.keys()) names.push(name);
        return names.sort();
      }, arm.vaultName);
      assert.deepEqual(files, i === 0 ? ['board.drawing', 'note.md'] : ['old.tldraw']);
      assert.equal(idlePasses[i], 2);
      assert.equal(await arm.page.locator('.tl-container,.cm-editor').count(), 0, 'Idle control unexpectedly opened a document');
      const identity = await identify(arm);
      report.prefetch.push({ vault: arm.vaultName, files, idlePasses: idlePasses[i], observedForMs: 4500, noDocumentClick: true, identity, requests: arm.requests, drawingChunks: drawingChunks(arm.requests) });
    }
    await check('native-only-prefetch', () => assert.deepEqual(report.prefetch[0].drawingChunks, [], 'Native-only vault prefetched legacy DrawingPane'));
    await check('legacy-only-idle-prefetch', () => assert.ok(report.prefetch[1].drawingChunks.length > 0, 'Legacy-only vault did not prefetch DrawingPane before a click'));
  } finally {
    await Promise.all(arms.map(arm => arm.context.close()));
  }
  await page.locator('.tree-item').filter({ hasText: /^old\.tldraw$/ }).click();
  await check('legacy-control', async () => {
    await page.locator('.tl-container').waitFor({ timeout: 15000 });
    await page.locator('.tl-shape').first().waitFor({ timeout: 15000 });
    assert.equal(await page.locator('.tl-shape').count(), 4, 'Legacy fixture did not render all four shapes');
    assert.equal(await page.locator('.cm-editor').count(), 0);
    assert.ok(drawingChunks(main.requests).length > 0);
    return { shapes: 4, drawingChunks: drawingChunks(main.requests) };
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
    assert.equal(icon, report.legacyDrawingIcon, 'Trash must use the legacy tree drawing icon');
  });
  await page.screenshot({ path: resolve(out, 'trash.png') });
  await check('no-page-errors', () => assert.deepEqual(report.pageErrors, []));
} catch (error) {
  report.failures.push(`harness: ${error.stack}`);
} finally {
  await Promise.allSettled(contexts.map(context => context.close()));
  await browser?.close();
  await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ ...report, network: `${report.network.length} responses`, prefetch: report.prefetch?.map(({ requests, ...arm }) => ({ ...arm, requests: `${requests.length} requests (see report.json)` })) }, null, 2));
if (report.failures.length) process.exitCode = 1;
