import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, decodePDFRawStream, rgb } from 'pdf-lib';
import { hash, until } from './browser.mjs';

export async function seedPdf(snapshot, attachment = 'tldraw-snapshot.json') {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.drawText('W-00 original source', { x: 40, y: 740, size: 16, color: rgb(.1, .2, .4) });
  // The ink ROI is deliberately unprinted: paper ruling and source text cannot
  // masquerade as the stroke in the output captures.
  page.drawRectangle({ x: 35, y: 35, width: 120, height: 35, borderWidth: 1, borderColor: rgb(.2, .4, .6) });
  doc.setProducer('W-00 local browser-run fixture');
  const date = new Date('2026-01-01T00:00:00Z');
  doc.setCreationDate(date); doc.setModificationDate(date);
  if (snapshot !== undefined) {
    const original = await doc.save({ useObjectStreams: false });
    await doc.attach(original, 'original.pdf', { creationDate: date, modificationDate: date });
    await doc.attach(Buffer.from(snapshot), attachment, { creationDate: date, modificationDate: date });
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

export async function pdfFiles(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const attachments = new Map();
  const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  const root = names?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict);
  function walk(tree) {
    if (!tree) return;
    const pairs = tree.lookupMaybe(PDFName.of('Names'), PDFArray);
    if (pairs) for (let i = 0; i < pairs.size(); i += 2) {
      const key = pairs.get(i).decodeText();
      const spec = pairs.lookup(i + 1, PDFDict);
      const stream = spec.lookup(PDFName.of('EF'), PDFDict).lookup(PDFName.of('F'), PDFRawStream);
      attachments.set(key, Buffer.from(decodePDFRawStream(stream).decode()));
    }
    const kids = tree.lookupMaybe(PDFName.of('Kids'), PDFArray);
    if (kids) for (let i = 0; i < kids.size(); i++) walk(kids.lookup(i, PDFDict));
  }
  walk(root);
  return { attachments, pages: doc.getPages().map(p => ({ width: p.getWidth(), height: p.getHeight(), rotation: p.getRotation().angle })) };
}

export async function document(bytes, name) {
  const snapshotBytes = name.endsWith('.pdf') ? (await pdfFiles(bytes)).attachments.get('tldraw-snapshot.json') : bytes;
  if (!snapshotBytes) return { readable: true, strokes: [], shapes: [], sheets: [], backdrops: [], paper: null };
  try {
    const parsed = JSON.parse(snapshotBytes.toString());
    const snapshot = parsed.snapshot ?? parsed;
    const store = snapshot.document?.store ?? snapshot.store ?? {};
    const records = Object.values(store);
    const shapes = records.filter(r => r.typeName === 'shape');
    return { readable: true, strokes: shapes.filter(r => r.type === 'draw'),
      shapes, sheets: records.filter(r => r.typeName === 'page'),
      backdrops: shapes.filter(r => r.type === 'image' && (r.meta?.notebookPage !== undefined || r.meta?.pdfPage !== undefined || String(r.id).includes('page'))),
      paper: parsed.paper ?? null };
  } catch (error) { return { readable: false, parseError: String(error), bytes: snapshotBytes.length }; }
}

export async function saved(h, name, label) {
  const bytes = await h.read(name);
  if (label) await h.artifact(`${label}-${name.split('/').at(-1)}`, bytes);
  return { sha256: hash(bytes), size: bytes.length, ...(await document(bytes, name)) };
}
export async function waitStrokes(h, name, count, timeout = 30000) {
  return until(async () => {
    const result = await saved(h, name);
    return result.strokes?.length === count ? result : false;
  }, `${name}: ${count} persisted strokes`, timeout);
}
export async function mount(h, host, name) {
  if (host === 'pdf') await h.annotate(name);
  else { await h.open(name); await h.ready(); }
}
export const hosts = (process.env.HOSTS ?? 'whiteboard,notebook,pdf').split(',');
export const filename = host => `Reference.${host === 'whiteboard' ? 'tldraw' : host === 'notebook' ? 'notebook' : 'pdf'}`;
export async function setup(h, host, extra = {}) {
  const name = filename(host);
  await h.seed({ 'Seed.md': '# Hidden pane control', [name]: host === 'pdf' ? await seedPdf() : '', ...extra });
  await h.openVault(); await mount(h, host, name); return name;
}
export async function exportNotebook(h, { accept = true } = {}) {
  await h.page.getByRole('button', { name: 'More options', exact: true }).click();
  await h.page.getByRole('menuitem', { name: 'Export to PDF', exact: true }).click();
  const dialog = h.page.getByRole('dialog');
  await dialog.waitFor();
  const question = await dialog.innerText();
  const replace = h.page.getByRole('button', { name: 'Replace', exact: true });
  const asked = await replace.isVisible();
  if (asked) {
    await h.page.getByRole('button', { name: accept ? 'Replace' : 'Cancel', exact: true }).click();
    if (!accept) return { asked, question, accepted: false };
  }
  await h.page.getByRole('button', { name: 'OK', exact: true }).click();
  return { asked, question, accepted: true };
}
export async function shapePaint(h) {
  return h.page.locator('.tl-container:visible .tl-shape').evaluateAll(elements => elements.map(el => ({
    id: el.getAttribute('data-shape-id'), type: el.getAttribute('data-shape-type'),
    rect: (() => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })(),
    colors: [...el.querySelectorAll('path')].map(p => ({ fill: getComputedStyle(p).fill, stroke: getComputedStyle(p).stroke })),
  })));
}
