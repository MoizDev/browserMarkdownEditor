import fs from 'node:fs/promises';
import path from 'node:path';
import { runArm, hash } from './lib/browser.mjs';
import { hosts, filename, seedPdf, document, shapePaint } from './lib/files.mjs';

const corpus = process.env.CORPUS ?? '/Users/adham/Developer/browserMarkdownEditor/planning/10-whiteboard/formats/corpus';
const kinds = (process.env.KINDS ?? 'native,truncated,non-json').split(',');
for (const host of hosts) for (const kind of kinds) await runArm('WB-D3', `${host}-${kind}`, async h => {
  const name = filename(host);
  let payload;
  if (kind === 'native') payload = JSON.stringify({ format: 'board', version: [1, 0],
    kind: host === 'pdf' ? 'pdf-ink' : host, fence: 'compat-1',
    document: { schema: { schemaVersion: 999 }, store: {} },
    records: [{ type: 'sheet', id: 'ReferenceSheet', name: 'Page 1', order: 'a1' }, { type: 'end', count: 1 }] });
  else if (kind === 'non-json') payload = '{broken W-00 original';
  else {
    const fixture = host === 'notebook' ? 'notebook-truncated.notebook' : 'whiteboard-truncated.tldraw';
    payload = await fs.readFile(path.join(corpus, 'received/b10d0d3', fixture), 'utf8');
  }
  const bytes = host === 'pdf' ? await seedPdf(payload, kind === 'native' ? 'board.json' : 'tldraw-snapshot.json') : Buffer.from(payload);
  await h.artifact(`fixture-${name}`, bytes);
  await h.seed({ 'Seed.md': '# Read-only guard control', [name]: bytes }); await h.openVault();
  await h.open(name);
  if (host === 'pdf') {
    await h.page.locator('.pdf-viewer-page:visible canvas').first().waitFor(); await h.chord('Mod+e');
  }
  await h.page.waitForTimeout(1000);
  const canvasMounted = await h.canvas().locator('.tl-canvas').count() > 0;
  const before = await h.read(name), marker = await h.mark();
  const beforeCapture = await h.capture('opened-before-input');
  if (canvasMounted) {
    await h.ready();
    for (let i = 0; i < 20; i++) await h.draw(.25 + (i % 5) * .05, .3 + Math.floor(i / 5) * .07);
  } else {
    // The guard can remove the canvas entirely. Real pen attempts still land on
    // the visible document surface; no private editor is invented for this arm.
    const root = h.page.locator(host === 'pdf' ? '.pdf-pane:visible' : '.canvas-pane:visible');
    const b = await root.boundingBox();
    if (!b) throw Error('No visible document/refusal surface');
    for (let i = 0; i < 20; i++) await h.stroke([{ x: b.x + 200, y: b.y + 200 + i * 5 }, { x: b.x + 300, y: b.y + 200 + i * 5 }]);
  }
  await h.page.waitForTimeout(5000);
  const after = await h.read(name), writes = (await h.writes(name)).filter(w => w.id > marker);
  const parsed = await document(after, name);
  await h.artifact(`after-${name}`, after);
  return { fixture: { kind, host, source: kind === 'truncated' ? 'retained app-written corpus at b10d0d3, truncated in planning' : 'original local construction from native-format.md §3.1 or explicit non-JSON bytes',
      sha256: hash(bytes), size: bytes.length },
    witness: { canvasMounted, attemptedStrokes: 20, completedWrites: writes.filter(w => w.closed !== null).length,
      bytesChanged: hash(before) !== hash(after), persistedStrokes: parsed.strokes?.length ?? null },
    reproduced: hash(before) !== hash(after), notice: await h.page.locator('body').innerText(),
    beforeSha256: hash(before), afterSha256: hash(after), after: parsed,
    painted: await shapePaint(h), captures: [beforeCapture, await h.capture('after-input')],
    loss: 'Native compatibility-fence cases may already refuse editing: those are controls, not a claimed malformed-file reproduction. Truncated PDF snapshot bytes are embedded in a genuine generated PDF.' };
});
