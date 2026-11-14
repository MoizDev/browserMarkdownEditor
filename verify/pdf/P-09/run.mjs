// Real app only: tree -> Annotate -> pen -> Save, with independent OPFS output inspection.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { armRoleWorkerDeath } from './worker-death.mjs';
import { bindServedBodies, toolboxIdentity } from './toolbox.mjs';
import { inspectPdfOutput } from './pdf-output.mjs';
const require = createRequire(import.meta.url);
const { chromium } = await import('playwright');
const pin = JSON.parse(await readFile(new URL('../../browser-pin.json', import.meta.url)));
if (!process.env.CHROME_PATH) throw new Error('CHROME_PATH must name the pinned Chrome for Testing executable');
const [origin, fixtures, output, variant = 'portfolio', entry = 'toolbar', expectation = 'refused'] = process.argv.slice(2);
if (!origin || !fixtures || !output) throw new Error('Usage: run.mjs ORIGIN FIXTURES OUT [VARIANT] [toolbar|keyboard|restore|reload|retry] [refused|editable|reproduce|funnel]');
if (!['toolbar', 'keyboard', 'restore', 'reload', 'retry'].includes(entry) || !['refused', 'editable', 'reproduce', 'funnel'].includes(expectation) || !/^[a-z0-9-]+$/.test(variant)) throw new Error('Unknown entry, expectation or fixture variant');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname)) throw new Error('The real app must be served on loopback');
if (process.env.FAULT && !['worker-boot-throw', 'worker-boot-stall', 'worker-death-at-read'].includes(process.env.FAULT)) throw new Error('Unknown fault arm');
if (process.env.RACE && !['replace', 'vault'].includes(process.env.RACE)) throw new Error('Unknown race arm');
if (process.env.FAULT && process.env.RACE) throw new Error('Fault and race are separate named arms');
if (entry === 'retry' && (expectation !== 'refused' || process.env.FAULT || process.env.RACE)) throw new Error('Retry is a normal refused-role arm, separate from injected faults/races');
if ((process.env.FAULT || process.env.RACE) && entry !== 'toolbar') throw new Error('Fault/race arms require the toolbar entry');
if (process.env.FAULT === 'worker-death-at-read' && (variant !== 'legacy-supported' || expectation !== 'refused')) throw new Error('The death-at-read arm requires legacy-supported with refused expectation');
const dpr = Number(process.env.DPR ?? 1), theme = process.env.THEME ?? 'dark';
if (![1, 2].includes(dpr) || !['light', 'dark'].includes(theme)) throw new Error('DPR must be 1/2 and THEME must be light/dark');
if (require('playwright/package.json').version !== pin.driver.split('@')[1]) throw new Error('Wrong Playwright driver');
await mkdir(output, { recursive: true });
let source = await readFile(path.join(fixtures, `${variant}.pdf`));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const legacyControl = expectation === 'editable' && (variant.startsWith('legacy-') && variant !== 'legacy-empty' || variant === 'plain-z-toolbar');
const originalDraws = legacyControl ? (await inspectPdfOutput(source, true)).drawRecords : [];
if (legacyControl && originalDraws.length !== 1) throw new Error('The finite legacy control must contain its one authored existing stroke');
if (!process.env.BUILD_IDENTITY) throw new Error('BUILD_IDENTITY must name identity.mjs\'s source+artifact record');
const build = JSON.parse(await readFile(process.env.BUILD_IDENTITY));
if (build.schema !== 1 || !build.source?.sha256 || !build.entry || !Array.isArray(build.artifacts) || !build.artifacts.length || !build.shared?.files?.length) throw new Error('Incomplete shared build identity');
const bootFault = ['worker-boot-throw', 'worker-boot-stall'].includes(process.env.FAULT);
if (bootFault && build.faultProfile?.id !== process.env.FAULT || build.faultProfile && !bootFault) throw new Error('Boot fault must use its own identified served-artifact copy');
const gateFiles = [];
for (const file of ['run.mjs', 'worker-death.mjs', 'pdf-output.mjs', 'toolbox.mjs']) {
  const bytes = await readFile(new URL(file, import.meta.url));
  gateFiles.push({ path: `verify/pdf/P-09/${file}`, sha256: sha(bytes), bytes: bytes.length });
}
const report = { gateFiles, variant, entry, expectation, fault: process.env.FAULT ?? 'none', theme, dpr, fixtureSha256: sha(source), buildCommit: build.commit, sourceSha256: build.source.sha256, configSha256: build.source.configSha256, mutant: build.mutant, buildIdentitySha256: sha(await readFile(process.env.BUILD_IDENTITY)), toolbox: toolboxIdentity, browser: '', errors: [], writes: [], chunks: [], passed: false };
let served;
const identityErrors = [];
async function checkIdentity() {
  if (!served) throw new Error('The shared served-body binder was not attached');
  const binding = await served.check();
  report.chunks = binding.modules.map(module => ({ url: `/${module.path}`, sha256: module.sha256, bytes: module.bytes }));
  return binding;
}
async function requireWitness(condition, message) {
  await checkIdentity();
  if (!condition) throw new Error(message);
}
async function verifyServedArtifacts() {
  await checkIdentity();
  if (identityErrors.length) throw new Error(identityErrors.join('; '));
  const urls = report.chunks.map(chunk => chunk.url);
  for (const pattern of [new RegExp(`^${build.entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), /\/PdfPane-.*\.js$/, /\/pdfBuildClient-.*\.js$/, /\/pdfBuild\.worker-.*\.js$/, /\/pdf\.worker[^/]*\.mjs$/]) {
    if (!urls.some(url => pattern.test(url))) throw new Error(`Required fetched app/PDF/worker artifact missing: ${pattern}`);
  }
}
let deathFault;
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH, args: ['--disable-background-networking'] });
try {
  report.browser = browser.version();
  if (report.browser !== pin.version) throw new Error(`Wrong browser: ${report.browser}, expected ${pin.version}`);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr });
  served = await bindServedBodies(context, { identity: build.shared, origin, mode: 'raw-route', buildMode: 'production', report: { data: report }, blockExternalOrigins: ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'] });
  const page = await context.newPage();
  if (process.env.FAULT === 'worker-death-at-read') {
    const candidates = build.artifacts.filter(file => /\/pdfBuild\.worker-.*\.js$/.test(file.url));
    if (candidates.length !== 1) throw new Error('Expected one emitted role worker for the decode breakpoint');
    deathFault = await armRoleWorkerDeath(page, origin, candidates[0]);
  }
  page.on('pageerror', e => {
    if (process.env.FAULT === 'worker-boot-throw' && e.message === 'P09 whole-chunk worker boot fault') (report.injectedErrors ??= []).push(e.message);
    else report.errors.push(e.message);
  });
  let releaseRole, roleHeld, heldRequests = 0;
  const held = new Promise(resolve => { roleHeld = resolve; });
  if (process.env.RACE) await context.route('**/assets/pdfBuild.worker-*.js', async route => {
    if (++heldRequests !== 1) { identityErrors.push('Race arm requested a second held worker chunk'); return route.abort(); }
    roleHeld();
    await new Promise(resolve => { releaseRole = resolve; });
    await route.fallback();
  });
  await context.route('**/__p09_fixture', route => route.fulfill({ body: source, contentType: 'application/pdf' }));
  await page.addInitScript(() => {
    const grant = handle => { handle.queryPermission = handle.requestPermission = async () => 'granted'; return handle; };
    const getDirectory = FileSystemDirectoryHandle.prototype.getDirectoryHandle;
    FileSystemDirectoryHandle.prototype.getDirectoryHandle = async function (...args) { return grant(await getDirectory.apply(this, args)); };
    window.__p09Pick = 'p09-vault';
    window.showDirectoryPicker = async () => grant(await (await navigator.storage.getDirectory()).getDirectoryHandle(window.__p09Pick, { create: true }));
    window.__p09 = { opens: [], closes: [], paints: 0, editableMounts: 0, buildRequests: 0, roleReads: 0, pointerUps: 0, saveKeys: [], contextMenus: [] };
    addEventListener('pointerup', () => { window.__p09.pointerUps++; }, true);
    addEventListener('contextmenu', event => {
      if (event.target instanceof Element && event.target.closest('.pdf-role-notice')) setTimeout(() => window.__p09.contextMenus.push(event.defaultPrevented), 0);
    }, true);
    addEventListener('keydown', event => {
      // Native dispatch can checkpoint microtasks BETWEEN listeners. A task
      // observes preventDefault after App's later window listener has run.
      if (event.metaKey && event.key.toLowerCase() === 's') setTimeout(() => window.__p09.saveKeys.push(event.defaultPrevented), 0);
    }, true);
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (...args) {
      if (args[0]?.kind === 'annotate') window.__p09.buildRequests++;
      if (args[0]?.kind === 'inspect-role') window.__p09.roleReads++;
      return post.apply(this, args);
    };
    const create = FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable = async function (...args) {
      window.__p09.opens.push(this.name);
      const stream = await create.apply(this, args), close = stream.close.bind(stream), name = this.name;
      stream.close = async () => { await close(); window.__p09.closes.push(name); };
      return stream;
    };
    const blit = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...args) {
      const result = blit.apply(this, args);
      if (this.canvas.parentElement?.classList.contains('pdf-viewer-page')) { this.canvas.dataset.p09Painted = 'yes'; window.__p09.paints++; }
      return result;
    };
    new MutationObserver(() => {
      if (document.querySelector('.pdf-annotate-pane .tl-container')) window.__p09.editableMounts++;
    }).observe(document, { childList: true, subtree: true });
  });
  await page.goto(origin);
  await deathFault?.activate();
  await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('p09-vault', { create: true });
    const writable = await (await dir.getFileHandle('guard.pdf', { create: true })).createWritable();
    await writable.write(await (await fetch('/__p09_fixture')).arrayBuffer()); await writable.close();
    window.__p09.opens.length = window.__p09.closes.length = 0;
  });
  const seededHash = await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('p09-vault');
    const bytes = await (await (await dir.getFileHandle('guard.pdf')).getFile()).arrayBuffer();
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
  });
  await requireWitness(seededHash === report.fixtureSha256, 'The OPFS source is not the named fixture');
  await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
  await page.locator('.tree-item', { hasText: 'guard.pdf' }).click();
  await page.waitForSelector('.pdf-viewer-page canvas[data-p09-painted="yes"]', { timeout: 60000 });
  report.paintedDarkPixels = await page.locator('.pdf-viewer-page canvas[data-p09-painted="yes"]').first().evaluate(canvas => {
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let dark = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 180 && pixels[i + 1] < 180 && pixels[i + 2] < 180 && pixels[i + 3] > 200) dark++;
    return dark;
  });
  await requireWitness(report.paintedDarkPixels >= 100, 'The outer page blitted, but its printed ink did not paint');
  if (process.env.THEME === 'light') await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click();
  report.outerTextBefore = await page.locator('.textLayer').first().textContent();
  const toggle = page.getByRole('button', { name: 'Toggle view/annotate mode' });
  if (entry === 'keyboard') { await page.locator('.pdf-viewer-scroll').click({ position: { x: 8, y: 8 } }); await page.keyboard.press('Meta+e'); }
  else await toggle.click();
  if (process.env.RACE) {
    let timer;
    try { await Promise.race([held, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The role worker hold did not execute')), 60000); })]); }
    finally { clearTimeout(timer); }
    const replacement = await readFile(path.join(fixtures, 'portfolio.pdf'));
    await context.route('**/__p09_replacement', route => route.fulfill({ body: replacement, contentType: 'application/pdf' }));
    await page.evaluate(async vaultSwitch => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(vaultSwitch ? 'p09-second' : 'p09-vault', { create: true });
      const writable = await (await dir.getFileHandle('guard.pdf', { create: true })).createWritable();
      await writable.write(await (await fetch('/__p09_replacement')).arrayBuffer()); await writable.close();
      window.__p09.opens.length = window.__p09.closes.length = 0;
      if (vaultSwitch) window.__p09Pick = 'p09-second';
    }, process.env.RACE === 'vault');
    if (process.env.RACE === 'vault') {
      await page.locator('.vault-switcher').dblclick();
      await page.getByRole('button', { name: 'Switch vault — p09-second', exact: true }).waitFor();
      await page.locator('.tree-item', { hasText: 'guard.pdf' }).click();
      await toggle.click();
    }
    source = replacement;
    report.expectedSha256 = sha(source);
    report.race = process.env.RACE;
    releaseRole();
  }
  if (entry === 'restore' || entry === 'reload') {
    await page.waitForFunction(() => document.querySelector('.pdf-role-notice') || document.querySelector('.tl-container'));
    if (entry === 'restore') {
      // Neural Brain unmounts EditorPane without changing tab.mode: returning
      // mounts PdfPane with initial mode='edit', not a second toggle handler.
      await page.getByRole('button', { name: 'Neural Brain — graph view', exact: true }).click();
      await page.waitForSelector('.pdf-pane', { state: 'detached' });
      await page.getByRole('button', { name: 'Back to the editor', exact: true }).click();
      report.restoredThrough = 'graph unmount/remount, retained edit-mode tab';
    } else {
      await page.evaluate(() => { window.__p09ReloadMarker = true; });
      await page.reload();
      await requireWitness(!await page.evaluate(() => !!window.__p09ReloadMarker), 'Reload did not happen');
      await page.waitForSelector('.pdf-viewer-page canvas[data-p09-painted="yes"]', { timeout: 60000 });
      await toggle.click();
      report.restoredThrough = 'reload restores View, subsequent Annotate';
    }
  }
  await page.waitForFunction(() => document.querySelector('.pdf-role-notice') || document.querySelector('.tl-container') || document.querySelector('.pdf-pane-message')?.textContent?.includes('Could not'), null, { timeout: 60000 });
  const canvas = page.locator('.tl-container').first();
  report.editable = await canvas.count() > 0;
  const notice = page.locator('.pdf-role-notice');
  if (report.editable) {
    await requireWitness(await notice.count() === 0, 'An editable canvas must not sit behind a refusal notice');
    report.notice = null;
  } else {
    await notice.waitFor({ state: 'visible' });
    if (entry === 'retry') {
      const reads = await page.evaluate(() => window.__p09.roleReads);
      await notice.getByRole('button', { name: 'Retry', exact: true }).click();
      await page.waitForFunction(before => window.__p09.roleReads > before && !!document.querySelector('.pdf-role-notice'), reads);
      await requireWitness(await page.evaluate(() => window.__p09.roleReads) === reads + 1, 'Retry did not perform exactly one new role read');
    }
    report.notice = await notice.textContent();
    const before = await page.evaluate(() => window.__p09.contextMenus.length);
    await notice.click({ button: 'right' });
    await page.waitForFunction(before => window.__p09.contextMenus.length > before, before);
    await requireWitness(await page.evaluate(() => window.__p09.contextMenus.at(-1)), 'The new notice leaked a native context menu');
  }
  if (report.editable) {
    await page.waitForFunction(() => [...document.querySelectorAll('.tl-container img')].some(img => img.complete && img.naturalWidth > 0), null, { timeout: 60000 });
    const initialShapes = await page.locator('.tl-shape[data-shape-type="draw"]').count();
    report.legacyShapesBefore = initialShapes;
    if (expectation === 'editable') await requireWitness(initialShapes === originalDraws.length, 'The positive control lost or invented an existing stroke');
    if (legacyControl) {
      const stroke = await page.locator('.tl-shape[data-shape-type="draw"]').first().boundingBox();
      const paper = await page.locator('.tl-shape[data-shape-type="image"]').first().boundingBox();
      const relative = { x: stroke.x - paper.x, y: stroke.y - paper.y };
      await page.keyboard.press('v');
      await page.mouse.click(stroke.x + stroke.width / 2, stroke.y + stroke.height / 2);
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(before => {
        const ink = document.querySelector('.tl-shape[data-shape-type="draw"]')?.getBoundingClientRect();
        const page = document.querySelector('.tl-shape[data-shape-type="image"]')?.getBoundingClientRect();
        return ink && page && Math.abs(ink.x - page.x - before.x) > .25;
      }, relative);
      await checkIdentity();
      await page.keyboard.press('Meta+z');
      await page.waitForFunction(before => {
        const ink = document.querySelector('.tl-shape[data-shape-type="draw"]')?.getBoundingClientRect();
        const page = document.querySelector('.tl-shape[data-shape-type="image"]')?.getBoundingClientRect();
        return ink && page && Math.abs(ink.x - page.x - before.x) < .25 && Math.abs(ink.y - page.y - before.y) < .25;
      }, relative);
      await checkIdentity();
      report.legacyMoveAndUndo = true;
    }
    const closesBeforeDraw = await page.evaluate(() => window.__p09.closes.length);
    const box = await page.locator('.tl-shape[data-shape-type="image"]').first().boundingBox();
    await page.mouse.move(box.x + box.width * .55, box.y + box.height * .25);
    await page.keyboard.press('d'); await page.mouse.down();
    await page.mouse.move(box.x + box.width * .70, box.y + box.height * .30, { steps: 20 }); await page.mouse.up();
    await page.waitForFunction(before => document.querySelectorAll('.tl-shape[data-shape-type="draw"]').length > before, initialShapes);
    if (expectation === 'funnel') await page.waitForSelector('.tab-dirty-dot', { timeout: 60000 });
    else await page.waitForFunction(before => window.__p09.closes.length > before && window.__p09.closes.includes('guard.pdf'), closesBeforeDraw, { timeout: 60000 });
  } else {
    await page.waitForSelector('.pdf-viewer-page canvas[data-p09-painted="yes"]', { timeout: 60000 });
    const box = await page.locator('.pdf-viewer-page canvas').first().boundingBox();
    await page.mouse.move(box.x + box.width * .55, box.y + box.height * .25); await page.keyboard.press('d');
    await page.mouse.down(); await page.mouse.move(box.x + box.width * .70, box.y + box.height * .30, { steps: 20 }); await page.mouse.up();
  }
  report.beforeForcedSave = await page.evaluate(() => ({ opens: window.__p09.opens.length, closes: window.__p09.closes.length, saveKeys: window.__p09.saveKeys.length }));
  await page.keyboard.press('Meta+s');
  await page.waitForFunction(before => window.__p09.saveKeys.length > before, report.beforeForcedSave.saveKeys);
  const saveGesture = await page.evaluate(() => window.__p09.saveKeys.at(-1));
  await requireWitness(saveGesture === true, 'The forced Save key did not reach the app handler');
  if (report.editable && expectation !== 'funnel') await page.waitForFunction(before => window.__p09.closes.length > before, report.beforeForcedSave.closes, { timeout: 60000 });
  await page.screenshot({ path: path.join(output, `${variant}-${entry}.png`) });
  // A save promise can outlive the gesture; a View/Annotate round trip provides
  // an app-owned completion boundary rather than a sleep-based zero-write proof.
  if (expectation !== 'funnel') {
    await toggle.click();
    await page.waitForSelector('.pdf-viewer-page canvas[data-p09-painted="yes"]', { timeout: 60000 });
  }
  const bytes = Buffer.from(await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(window.__p09Pick);
    return Array.from(new Uint8Array(await (await (await dir.getFileHandle('guard.pdf')).getFile()).arrayBuffer()));
  }));
  await writeFile(path.join(output, `${variant}-${entry}.pdf`), bytes);
  report.outputSha256 = sha(bytes);
  report.witness = await page.evaluate(() => window.__p09);
  report.writes = report.witness.closes;
  report.dirtyDots = await page.locator('.tab-dirty-dot').count();
  const inspected = await inspectPdfOutput(bytes, expectation === 'editable');
  report.pageSize = inspected.pageSize;
  if (expectation === 'editable') {
    const ids = new Set(inspected.drawRecords.map(record => record.id));
    report.savedDrawIds = [...ids];
    await requireWitness(ids.size >= originalDraws.length + 1 && originalDraws.every(record => ids.has(record.id)), 'The actual saved snapshot lost an existing or newly drawn stroke');
  }
  // Painted text is read from the real viewer's text layer, not app internals.
  report.outerText = expectation === 'funnel' ? report.outerTextBefore : await page.locator('.textLayer').first().textContent();
  if (process.env.FAULT === 'worker-death-at-read') {
    await checkIdentity(); report.workerDeath = deathFault.check();
    await requireWitness((report.witness.roleReplies ?? []).length === 0 && report.witness.terminatedWorkers === 1 && report.witness.roleRequestsForwarded === 1, 'The killed role worker returned a capability or its real request was not forwarded exactly once');
  }
  report.executedArms = [entry, ...(process.env.RACE ? [`race:${process.env.RACE}`] : []), ...(process.env.FAULT ? [`fault:${process.env.FAULT}`] : [])];
  if (expectation === 'reproduce') {
    await requireWitness(report.editable && report.writes.includes('guard.pdf') && report.pageSize.width === 200 && report.outerText.includes('INNER ATTACHMENT'), 'Baseline did not reproduce the destructive portfolio write');
  } else if (expectation === 'funnel') {
    await requireWitness(report.editable && await page.locator('.tab-dirty-dot').count() > 0 && report.witness.buildRequests === 0 && report.witness.opens.length === 0 && report.outputSha256 === report.fixtureSha256, 'The forced dirty-buffer save did not stop at the funnel');
  } else if (expectation === 'editable') {
    await requireWitness(report.editable && report.writes.includes('guard.pdf') && report.outputSha256 !== report.fixtureSha256, 'Positive control did not mount/draw/write');
  } else {
    await requireWitness(!report.editable && !!report.notice && report.witness.editableMounts === 0 && report.dirtyDots === 0 && report.witness.opens.length === 0 && report.outputSha256 === (report.expectedSha256 ?? report.fixtureSha256) && report.pageSize.width === 400 && report.pageSize.height === 600 && report.outerText.includes('OUTER MUST SURVIVE'), 'Read-only role guard failed (see report)');
  }
  if (bootFault) {
    await checkIdentity();
    report.faultProfile = build.faultProfile;
    report.faultMatches = report.chunks.filter(chunk => chunk.url === build.faultProfile.url && chunk.sha256 === build.faultProfile.sha256).length;
    await requireWitness(report.faultMatches === 1, 'The identified boot-fault worker was not fetched exactly once');
  }
  if (process.env.RACE) {
    report.heldRequests = heldRequests;
    await requireWitness(heldRequests === 1, 'The named race arm did not hold exactly one worker request');
  }
  await requireWitness(report.errors.length === 0, `Page errors: ${report.errors.join('; ')}`);
  await verifyServedArtifacts();
  report.passed = true;
} catch (error) { report.failure = error.stack ?? String(error); process.exitCode = 1; }
finally {
  if (deathFault) report.workerDeathState = structuredClone(deathFault.state);
  try { await verifyServedArtifacts(); } catch (error) { report.identityFailure = error.stack ?? String(error); report.passed = false; process.exitCode = 1; }
  await deathFault?.stop();
  await served?.stop();
  await browser.close(); await writeFile(path.join(output, `${variant}-${entry}.json`), `${JSON.stringify(report, null, 2)}\n`); console.log(JSON.stringify(report)); }
