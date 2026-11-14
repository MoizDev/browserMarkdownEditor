import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

export const scratch = process.env.WA_SCRATCH ?? '/Users/adham/Developer/bme-impl/scratch/w-a';
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function until(read, description, timeout = 30000) {
  const end = Date.now() + timeout;
  do { const value = await read(); if (value) return value; await delay(50); } while (Date.now() < end);
  throw Error(`Timed out: ${description}`);
}
export async function frames(page, n = 2) {
  await page.evaluate(n => new Promise(resolve => {
    if (n <= 0) { resolve(); return; }
    const tick = () => --n <= 0 ? resolve() : requestAnimationFrame(tick);
    requestAnimationFrame(tick);
  }), n);
}

// Instrumentation belongs to the driver, not the app. Native writes retained here let
// fixture seeding bypass the counter: an app write cannot be confused with setup.
function instrument({ vaultName, captureWrites, scheduling }) {
  if (window !== top) return;
  const native = {
    getDir: FileSystemDirectoryHandle.prototype.getDirectoryHandle,
    getFile: FileSystemDirectoryHandle.prototype.getFileHandle,
    writable: FileSystemFileHandle.prototype.createWritable,
  };
  const paths = new WeakMap();
  const grant = handle => {
    handle.queryPermission = async () => 'granted';
    handle.requestPermission = async () => 'granted';
    return handle;
  };
  const state = window.__wa = { native, vaultName, paths, writes: [], sequence: 0,
    events: [], contexts: [], sites: {}, buckets: [], started: null };
  FileSystemDirectoryHandle.prototype.getDirectoryHandle = async function (name, options) {
    const child = grant(await native.getDir.call(this, name, options));
    paths.set(child, `${paths.get(this) ?? ''}/${name}`); return child;
  };
  FileSystemDirectoryHandle.prototype.getFileHandle = async function (name, options) {
    const child = grant(await native.getFile.call(this, name, options));
    paths.set(child, `${paths.get(this) ?? ''}/${name}`); return child;
  };
  const entries = FileSystemDirectoryHandle.prototype.entries;
  FileSystemDirectoryHandle.prototype.entries = async function* () {
    for await (const [name, child] of entries.call(this)) {
      paths.set(child, `${paths.get(this) ?? ''}/${name}`); grant(child); yield [name, child];
    }
  };
  FileSystemDirectoryHandle.prototype[Symbol.asyncIterator] = FileSystemDirectoryHandle.prototype.entries;
  const values = FileSystemDirectoryHandle.prototype.values;
  FileSystemDirectoryHandle.prototype.values = async function* () {
    for await (const child of values.call(this)) {
      paths.set(child, `${paths.get(this) ?? ''}/${child.name}`); grant(child); yield child;
    }
  };
  window.showDirectoryPicker = async () => {
    const root = await navigator.storage.getDirectory(); paths.set(root, '');
    return root.getDirectoryHandle(vaultName, { create: true });
  };
  FileSystemFileHandle.prototype.createWritable = async function (...args) {
    const entry = { id: ++state.sequence, path: paths.get(this) ?? `unknown/${this.name}`,
      start: performance.now(), closed: null, bytes: null, error: null };
    state.writes.push(entry);
    const stream = await native.writable.apply(this, args), handle = this;
    const close = stream.close.bind(stream);
    stream.close = async () => {
      try {
        await close(); entry.closed = performance.now();
        if (captureWrites) {
          const file = await handle.getFile();
          entry.bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
        }
      } catch (error) { entry.error = String(error); throw error; }
    };
    return stream;
  };
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
    const result = getContext.call(this, kind, ...args);
    if (result) state.contexts.push({ kind, width: this.width, height: this.height });
    return result;
  };
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel',
    'touchstart', 'touchmove', 'touchend', 'touchcancel']) {
    window.addEventListener(type, event => {
      state.events.push({ type, trusted: event.isTrusted, kind: event.pointerType,
        id: event.pointerId, x: event.clientX, y: event.clientY, at: performance.now(),
        touches: event.touches ? [...event.touches].map(p => ({ id: p.identifier, x: p.clientX, y: p.clientY })) : undefined });
    }, { capture: true, passive: true });
  }
  if (!scheduling) return;
  for (const [name, kind] of [['requestAnimationFrame', 'raf'], ['setTimeout', 'timeout'], ['setInterval', 'interval']]) {
    const original = window[name].bind(window);
    window[name] = (callback, ...args) => {
      if (typeof callback !== 'function') return original(callback, ...args);
      const stack = new Error().stack.split('\n').slice(2).join('\n');
      const key = `${kind}|${stack}`;
      state.sites[key] ??= { kind, stack, registrations: 0, fires: 0 };
      state.sites[key].registrations++;
      return original(function (...values) {
        state.sites[key].fires++;
        if (state.started !== null) {
          const second = Math.floor((performance.now() - state.started) / 1000);
          const bucket = state.buckets[second] ??= { second, raf: 0, timeout: 0, interval: 0, sites: {} };
          bucket[kind]++; bucket.sites[key] = (bucket.sites[key] ?? 0) + 1;
        }
        return callback.apply(this, values);
      }, ...args);
    };
  }
}

export async function launch(row, arm, options = {}) {
  const baseURL = process.env.BASE_URL ?? 'http://localhost:6500/';
  assert(['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname), 'Loopback app only');
  const output = path.join(scratch, 'reference', row, process.env.PHASE ?? 'before', arm);
  await fs.mkdir(output, { recursive: true });
  const meta = JSON.parse(await fs.readFile(process.env.BUILD_META ?? path.join(scratch, 'build.json'), 'utf8'));
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.CHROME ?? '/Users/adham/Developer/bme-impl/scratch/browsers/157.0.8103.39/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: Number(process.env.DPR ?? 1), acceptDownloads: true,
    hasTouch: options.hasTouch ?? false });
  const page = await context.newPage(), cdp = await context.newCDPSession(page);
  const errors = [], network = [], chunks = [];
  page.on('pageerror', error => errors.push(String(error)));
  // No shell font, asset or fixture content leaves the machine.
  await context.route('**/*', route => {
    const url = route.request().url();
    if (/^https?:/.test(url) && new URL(url).origin !== new URL(baseURL).origin) {
      network.push({ url, blocked: true }); return route.abort();
    }
    return route.continue();
  });
  const responses = [];
  page.on('response', response => {
    if (!response.url().startsWith(new URL(baseURL).origin)) return;
    responses.push((async () => {
      const bytes = await response.body().catch(() => null);
      if (!bytes) return;
      const info = { url: response.url(), status: response.status(), size: bytes.length, sha256: hash(bytes) };
      network.push(info);
      if (/\.js(?:\?|$)/.test(response.url())) chunks.push({ ...info, text: bytes.toString() });
    })());
  });
  await context.addInitScript(instrument, { vaultName: `Reference-${row}-${arm}`,
    captureWrites: options.captureWrites ?? false, scheduling: options.scheduling ?? false });
  if (options.init) await context.addInitScript(options.init);
  const response = await page.goto(baseURL);
  assert.equal(hash(await response.body()), meta.indexSha256, 'Served index differs from declared build');
  assert.equal(browser.version(), '157.0.8103.39', 'Pinned Chrome changed');
  const mod = await page.evaluate(() => /Mac/.test(navigator.platform) ? 'Meta' : 'Control');
  const h = { page, cdp, browser, context, output, errors, network, meta, mod, row, arm,
    chord: keys => page.keyboard.press(keys.replaceAll('Mod', mod)) };
  h.io = (operation, name = '', data) => page.evaluate(async ({ operation, name, data }) => {
    const state = window.__wa, root = await navigator.storage.getDirectory();
    state.paths.set(root, '');
    let dir = await root.getDirectoryHandle(state.vaultName, { create: true });
    const parts = name.split('/').filter(Boolean);
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: operation === 'write' });
    if (operation === 'list') {
      if (parts.length) dir = await dir.getDirectoryHandle(parts.at(-1));
      const result = [];
      async function walk(current, prefix) {
        for await (const [name, handle] of current.entries()) {
          result.push({ path: prefix + name, kind: handle.kind });
          if (handle.kind === 'directory') await walk(handle, prefix + name + '/');
        }
      }
      await walk(dir, name ? name + '/' : ''); return result.sort((a, b) => a.path.localeCompare(b.path));
    }
    const handle = await dir.getFileHandle(parts.at(-1), { create: operation === 'write' });
    if (operation === 'write') {
      const stream = await state.native.writable.call(handle);
      await stream.write(new Uint8Array(data)); await stream.close(); return;
    }
    return Array.from(new Uint8Array(await (await handle.getFile()).arrayBuffer()));
  }, { operation, name, data });
  h.seed = async files => {
    for (const [name, bytes] of Object.entries(files)) await h.io('write', name, [...Buffer.from(bytes)]);
  };
  h.read = async name => Buffer.from(await h.io('read', name));
  h.writes = async name => page.evaluate(name => window.__wa.writes.filter(w =>
    !name || w.path === `/${window.__wa.vaultName}/${name}`), name);
  h.mark = () => page.evaluate(() => window.__wa.sequence);
  h.openVault = async () => {
    await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
    await page.locator('.vault-switcher').waitFor();
  };
  h.open = async name => {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) {
      const prefix = parts.slice(0, i).join('/');
      if (!await page.locator(`.tree-item[data-path=${JSON.stringify(parts.slice(0, i + 1).join('/'))}]`).count()) {
        await page.locator(`.tree-item[data-path=${JSON.stringify(prefix)}]`).click();
      }
    }
    await page.locator(`.tree-item[data-path=${JSON.stringify(name)}]`).click();
  };
  h.canvas = () => page.locator('.tl-container[role="application"]:visible');
  h.ready = async () => {
    await h.canvas().waitFor(); await page.evaluate(() => document.fonts.ready); await frames(page);
  };
  h.annotate = async name => {
    await h.open(name); await page.locator('.pdf-viewer-page:visible canvas').first().waitFor();
    await h.chord('Mod+e'); await h.ready();
  };
  h.create = async name => {
    await page.locator('[data-tooltip="New drawing or notebook"]').click();
    await page.getByRole('menuitem', { name: name.endsWith('.notebook') ? 'New Notebook' : 'New Drawing', exact: true }).click();
    const input = page.locator('input:focus'); await input.fill(name); await input.press('Enter'); await h.ready();
  };
  h.closeTab = async name => page.locator(`[role="tab"][data-tooltip=${JSON.stringify(name)}]`).getByRole('button', { name: /^Close / }).click();
  h.pointer = (type, point, extra = {}) => cdp.send('Input.dispatchMouseEvent', {
    type, x: point.x, y: point.y, pointerType: 'pen', button: type === 'mouseMoved' ? 'none' : 'left',
    buttons: type === 'mouseReleased' ? 0 : 1, force: type === 'mouseReleased' ? 0 : 0.5,
    clickCount: type === 'mouseMoved' ? 0 : 1, ...extra,
  });
  h.stroke = async (points, { wait = 2 } = {}) => {
    await h.pointer('mouseMoved', points[0], { buttons: 0 }); await h.pointer('mousePressed', points[0]);
    for (const point of points.slice(1)) await h.pointer('mouseMoved', point);
    await h.pointer('mouseReleased', points.at(-1)); if (wait) await frames(page, wait);
  };
  h.touch = (type, points) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: points.map((p, id) => ({ id, x: p.x, y: p.y, radiusX: 1, radiusY: 1, force: 0.5 })),
  });
  h.point = async (x = .35, y = .4) => {
    const box = await h.canvas().boundingBox(); assert(box, 'Visible canvas bounds missing');
    return { x: box.x + box.width * x, y: box.y + box.height * y };
  };
  h.draw = async (x = .35, y = .4, opts) => {
    await h.canvas().focus(); await h.chord('d'); const a = await h.point(x, y);
    await h.stroke([a, { x: a.x + 50, y: a.y + 10 }, { x: a.x + 100, y: a.y }], opts);
  };
  h.capture = async label => {
    const filename = `${label}.png`; await page.screenshot({ path: path.join(output, filename) }); return filename;
  };
  h.artifact = async (name, bytes) => { await fs.writeFile(path.join(output, name), bytes); return name; };
  h.waitWrite = (name, after, timeout) => until(async () => (await h.writes(name)).find(w => w.id > after && w.closed !== null && !w.error), `completed write of ${name} after ${after}`, timeout);
  h.finish = async result => {
    await Promise.all(responses);
    const markers = [...new Set(chunks.flatMap(chunk => [...chunk.text.matchAll(/["'](@tldraw\/[\w-]+)["']\s*,\s*["'](\d+\.\d+\.\d+)["']/g)].map(m => `${m[1]}@${m[2]}`)))];
    const identity = { build: meta, indexSha256: meta.indexSha256, chrome: browser.version(),
      viewport: { width: 1440, height: 1000 }, dpr: Number(process.env.DPR ?? 1),
      engine: options.legacyCanvas === false ? 'not-loaded' : 'legacy-tldraw', versionMarkers: markers,
      chunks: chunks.filter(c => /DrawingPane-|NotebookPane-|canvasAgentOps-|PdfAnnotateCanvas-/.test(c.url)).map(c => ({ url: c.url, status: c.status, size: c.size, sha256: c.sha256 })),
      maxTouchPoints: await page.evaluate(() => navigator.maxTouchPoints),
      backend: options.legacyCanvas === false ? 'no canvas engine mounted' : 'DOM/SVG legacy board; only actual HTML canvas contexts counted',
      contexts: await page.evaluate(() => window.__wa.contexts) };
    if (options.legacyCanvas === false) {
      assert.equal(identity.chunks.length, 0, 'A Markdown-only session loaded a canvas engine chunk');
      assert.equal(markers.length, 0, 'A Markdown-only session loaded the canvas library');
    } else {
      assert(identity.chunks.length, 'Legacy engine chunk response missing');
      assert(markers.length && markers.every(m => m.endsWith('@5.2.4')), 'Library own version marker assertion failed');
    }
    const record = { row, arm, ...result, identity, errors, network,
      events: await page.evaluate(() => window.__wa.events), writes: await h.writes() };
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(record, null, 2) + '\n');
    return record;
  };
  h.close = () => browser.close();
  return h;
}

export async function runArm(row, arm, action, options) {
  const h = await launch(row, `${arm}-${process.env.REPEAT ?? '1'}`, options);
  try { const result = await action(h); return await h.finish(result); }
  catch (error) {
    await h.capture('failure').catch(() => {});
    await fs.writeFile(path.join(h.output, 'failure.json'), JSON.stringify({ message: error.message,
      stack: error.stack, build: h.meta, network: h.network,
      body: await h.page.locator('body').innerText().catch(() => ''), errors: h.errors }, null, 2));
    throw error;
  } finally { await h.close(); }
}
