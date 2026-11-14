import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runArm, hash, delay, until } from './lib/browser.mjs';
import { saved, document } from './lib/files.mjs';

const corpus = process.env.CORPUS ?? '/Users/adham/Developer/browserMarkdownEditor/planning/10-whiteboard/formats/corpus';
for (const host of ['whiteboard', 'notebook']) await runArm('WB-D5', host, async h => {
  const name = host === 'whiteboard' ? 'whiteboard-10000.tldraw' : 'notebook-10000.notebook';
  const bytes = await fs.readFile(path.join(corpus, 'growth', name));
  assert.equal((await document(bytes, name)).strokes.length, 10000, 'Actual app-written 10k fixture required');
  await h.seed({ [name]: bytes, 'Seed.md': '# Hidden board control' });
  await h.openVault(); await h.open(name); await h.ready();
  const visibleCapture = await h.capture('visible-10000');
  await h.cdp.send('Performance.enable');
  const samples = [];
  async function sample(label) {
    const metrics = (await h.cdp.send('Performance.getMetrics')).metrics;
    samples.push({ label, ...Object.fromEntries(metrics.filter(m => ['JSHeapUsedSize', 'JSHeapTotalSize', 'Nodes', 'Documents'].includes(m.name)).map(m => [m.name, m.value])) });
  }
  await h.open('Seed.md');
  await until(() => h.page.locator('.canvas-pane-hidden .tl-container').count(), 'mounted board hidden after tab switch');
  const hidden = await h.page.locator('.canvas-pane').evaluateAll(elements => elements.map(el => ({
    visibility: getComputedStyle(el).visibility, mountedCanvas: !!el.querySelector('.tl-container'),
  })));
  assert(hidden.some(p => p.visibility === 'hidden' && p.mountedCanvas), 'The board was not actually hidden while mounted');
  await h.page.evaluate(() => { window.__wa.started = performance.now(); window.__wa.buckets = []; });
  await sample('0s'); const start = Date.now();
  for (const seconds of [1, 5, 10]) { await delay(Math.max(0, start + seconds * 1000 - Date.now())); await sample(`${seconds}s`); }
  const scheduling = await h.page.evaluate(() => ({ sites: window.__wa.sites, buckets: window.__wa.buckets }));
  const canvasSites = Object.entries(scheduling.sites).filter(([, site]) => /canvasAgentOps-|DrawingPane-|NotebookPane-/.test(site.stack)).map(([key]) => key);
  const totals = { raf: 0, timeout: 0, interval: 0 };
  for (const bucket of scheduling.buckets.filter(b => b.second >= 1 && b.second < 10)) {
    for (const key of canvasSites) totals[scheduling.sites[key].kind] += bucket.sites[key] ?? 0;
  }
  return { fixture: { source: 'retained planning app-written 10k corpus; 1k real strokes plus native copy/paste growth', sha256: hash(bytes), size: bytes.length },
    witness: { savedStrokes: (await saved(h, name)).strokes.length, mountedButHidden: true,
      canvasAttributedFiresInSeconds1To9: totals, heapDeltaOver10s: samples.at(-1).JSHeapUsedSize - samples[0].JSHeapUsedSize },
    reproduced: totals.raf > 0 || totals.timeout > 0 || totals.interval > 0,
    hidden, samples, scheduling, captures: [visibleCapture, await h.capture('hidden')],
    tolerance: 'Functional callbacks only, not a timing benchmark: report raw per-second counts. Repeat rAF/s tolerance ±30%; heap is noisy and is not compared as byte-identical.',
    loss: 'Minified app and library share chunks, so these stacks attribute to the legacy canvas chunk, not reliably to individual app-vs-library callbacks. Retained editor heap is not claimed fixable without losing history.' };
}, { scheduling: true });
