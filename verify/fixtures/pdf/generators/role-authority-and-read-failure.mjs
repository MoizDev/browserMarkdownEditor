// GEN-25: synthetic portfolios and legacy serialized DATA, never editor code.
import { PDFName, PDFString, PDFHexString } from 'pdf-lib';
import { parseArgs, fixtureWriter, jsonBytes, createDeterministicPdf, saveDeterministicPdf } from './role-authority-support.mjs';
const { out, seed } = parseArgs(process.argv.slice(2));
const emit = fixtureWriter(out), version = 2;
const identity = id => ({ id: `GEN-25/${id}`, version, seed });
async function document(id, width = 400, height = 600, text = 'OUTER MUST SURVIVE') {
  const doc = await createDeterministicPdf(identity(id));
  doc.addPage([width, height]).drawText(text, { x: 20, y: height - 70, size: 16 });
  return doc;
}
const save = (doc, id) => saveDeterministicPdf(doc, identity(id));
const inner = await save(await document('inner', 200, 300, 'INNER ATTACHMENT'), 'inner');
const pristine = await save(await document('pristine'), 'pristine');
const encode = value => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));

// Schema and a single hand-drawn stroke captured as data from the d53ae0a
// production UI's real OPFS output. Its genuine PDF is a separate gate control;
// these synthetic wrappers exercise damaged trees and reader failures repeatably.
const schema = { schemaVersion: 2, sequences: {
  'com.tldraw.store': 5, 'com.tldraw.asset': 1, 'com.tldraw.camera': 1,
  'com.tldraw.document': 2, 'com.tldraw.instance': 26, 'com.tldraw.instance_page_state': 5,
  'com.tldraw.page': 1, 'com.tldraw.instance_presence': 6, 'com.tldraw.pointer': 1,
  'com.tldraw.shape': 4, 'com.tldraw.user': 1, 'com.tldraw.asset.image': 6,
  'com.tldraw.asset.video': 5, 'com.tldraw.asset.bookmark': 2, 'com.tldraw.shape.group': 0,
  'com.tldraw.shape.text': 4, 'com.tldraw.shape.bookmark': 2, 'com.tldraw.shape.geo': 11,
  'com.tldraw.shape.note': 13, 'com.tldraw.shape.line': 5, 'com.tldraw.shape.frame': 1,
  'com.tldraw.shape.arrow': 8, 'com.tldraw.shape.highlight': 4, 'com.tldraw.shape.embed': 4,
  'com.tldraw.shape.video': 4, 'com.tldraw.shape.draw': 5, 'com.tldraw.shape.image': 5,
  'com.tldraw.binding.arrow': 1,
} };
const empty = { document: { schema, store: {
  'document:document': { id: 'document:document', typeName: 'document', gridSize: 10, name: '', meta: {} },
  'page:page': { id: 'page:page', typeName: 'page', name: 'Page 1', index: 'a1', meta: {} },
} } };
const snapshot = encode({ document: { schema, store: { ...empty.document.store,
  'shape:gen25-stroke': { id: 'shape:gen25-stroke', typeName: 'shape', type: 'draw', x: 80, y: 100, rotation: 0, isLocked: false, opacity: 1, meta: {}, parentId: 'page:page', index: 'a1', props: {
    segments: [{ type: 'free', path: 'AAAAAAAAAAAAQgA+AEIAPgBCAD4AQgA+AEIAPgBCAD4AQgA+AEIAPgBCAD4AQgA+AEIAPgBCAD4AQgA+AEIAPgBCAD4AQgA+AEIAPgBCAD4AQgA+AEIAPg==', dim: 2 }],
    color: 'black', fill: 'none', dash: 'solid', size: 's', isComplete: true, isClosed: false, isPen: false, scale: 1, scaleX: 1, scaleY: 1,
  } },
} } });
function attach(doc, name, data, description = 'Synthetic user attachment', fault) {
  const stream = doc.context.flateStream(data, { Type: 'EmbeddedFile', Params: { Size: data.length } });
  if (fault === 'null') return doc.context.register(doc.context.obj({ Type: 'Filespec', F: PDFString.of(name) }));
  if (fault === 'corrupt') stream.dict.set(PDFName.of('Filter'), PDFName.of('UnknownRoleFilter'));
  if (fault === 'limit') stream.dict.lookup(PDFName.of('Params')).set(PDFName.of('Size'), doc.context.obj(name === 'tldraw-snapshot.json' ? 32 * 1024 * 1024 + 1 : 0x80000000));
  const ref = doc.context.register(stream);
  return doc.context.register(doc.context.obj({ Type: 'Filespec', F: PDFString.of(name), UF: PDFHexString.fromText(name), Desc: PDFHexString.fromText(description), EF: { F: ref } }));
}
const records = [];
async function fixture(id, entries, tree = 'names', expected = 'refused') {
  const doc = await document(id);
  const pairs = entries.flatMap(([name, data, description, fault]) => [PDFHexString.fromText(name), attach(doc, name, data, description, fault)]);
  const root = doc.context.obj({ Names: pairs });
  if (tree === 'mixed') {
    root.set(PDFName.of('Kids'), doc.context.obj([doc.context.register(doc.context.obj({ Names: pairs.slice(0, 2) }))]));
    root.set(PDFName.of('Names'), doc.context.obj(pairs.slice(2)));
  }
  if (tree === 'af') doc.catalog.set(PDFName.of('AF'), doc.context.obj(pairs.filter((_, i) => i % 2)));
  else doc.catalog.set(PDFName.of('Names'), doc.context.obj({ EmbeddedFiles: root }));
  const output = await emit(`${id}.pdf`, await save(doc, id));
  records.push({ id: `GEN-25/${id}`, ...output, tier: 1, licence: 'NOASSERTION', proposedLicence: 'CC0-1.0', sourceNotice: 'Wholly authored synthetic page text and geometry; serialized legacy schema/stroke data captured from our own baseline UI gesture, not implementation code.', purpose: id, gates: ['WR-G0', 'D9'], generator: 'verify/fixtures/pdf/generators/role-authority-and-read-failure.mjs', version, seed, args: [], expected, pages: 1, validity: tree === 'mixed' || /null|corrupt|duplicate/.test(id) ? 'repairable' : 'valid' });
}
const source = ['original.pdf', inner];
await fixture('portfolio', [source]);
await fixture('plain-z', [['z.txt', encode('User data remains data')]], 'names', 'editable');
await fixture('malformed-snapshot', [source, ['tldraw-snapshot.json', encode('{')]]);
await fixture('invalid-shape-snapshot', [source, ['tldraw-snapshot.json', encode({ document: { store: {} } })]]);
await fixture('future-snapshot', [source, ['tldraw-snapshot.json', encode({ document: { schema: { schemaVersion: 999 }, store: {} } })]]);
for (const fault of ['null', 'corrupt', 'limit']) await fixture(`${fault}-source`, [['original.pdf', inner, undefined, fault], ['tldraw-snapshot.json', snapshot]]);
await fixture('snapshot-without-source', [['tldraw-snapshot.json', snapshot]]);
await fixture('board-alone', [['board.json', encode('{')]]);
await fixture('unknown-marked', [['future-ink.bin', encode('future'), 'local-vault-pdf/v9;role=editable;format=future']]);
await fixture('malformed-marked', [['unfamiliar.bin', encode('future'), 'local-vault-pdf/not-a-valid-marker']]);
await fixture('marked-original-mismatch', [['original.pdf', inner, 'local-vault-pdf/v1;role=editable;format=board'], ['tldraw-snapshot.json', snapshot]]);
await fixture('duplicate-sources', [source, ['original.pdf', pristine], ['tldraw-snapshot.json', snapshot]]);
const legacyEntries = [['original.pdf', pristine], ['tldraw-snapshot.json', snapshot]];
await fixture('legacy-supported', legacyEntries, 'names', 'editable');
await fixture('legacy-mixed', legacyEntries, 'mixed', 'editable');
await fixture('legacy-af', legacyEntries, 'af', 'editable');
await fixture('legacy-empty', [['original.pdf', pristine], ['tldraw-snapshot.json', encode(empty)]], 'names', 'editable');
await fixture('board-with-stale-legacy', [...legacyEntries, ['board.json', encode('{')]]);
await fixture('board-in-mixed-tree', [['board.json', encode('{')], ...legacyEntries], 'mixed');
await fixture('board-in-af', [...legacyEntries, ['board.json', encode('{}')]], 'af');
for (const fault of ['null', 'corrupt', 'limit']) await fixture(`${fault}-snapshot`, [['original.pdf', pristine], ['tldraw-snapshot.json', snapshot, undefined, fault]]);
await emit('role-authority-oracle.json', jsonBytes({ schema: 1, fixtures: records }));
