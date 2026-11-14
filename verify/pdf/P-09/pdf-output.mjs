// Independent inspection of the bytes actually read from OPFS, not app modules.
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFString, decodePDFRawStream } from 'pdf-lib';
const key = PDFName.of;
const text = value => value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : undefined;
export async function inspectPdfOutput(bytes, readSnapshot = false) {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false, parseSpeed: Infinity });
    const result = { pageSize: doc.getPage(0).getSize(), drawRecords: [] };
    if (!readSnapshot) return result;
    const specs = new Map(), seen = new Set();
    const add = (raw, alias) => {
        const spec = doc.context.lookup(raw);
        if (!(spec instanceof PDFDict)) throw new Error('Unreadable control Filespec');
        const names = specs.get(spec) ?? new Set();
        for (const name of [alias, text(spec.lookup(key('UF'))), text(spec.lookup(key('F')))]) if (name) names.add(name);
        specs.set(spec, names);
    };
    const walk = raw => {
        const node = doc.context.lookup(raw);
        if (!(node instanceof PDFDict) || seen.has(node)) return;
        seen.add(node);
        const pairs = node.lookup(key('Names')), kids = node.lookup(key('Kids'));
        if (pairs instanceof PDFArray) for (let i = 0; i < pairs.size(); i += 2) add(pairs.get(i + 1), text(pairs.lookup(i)));
        if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) walk(kids.get(i));
    };
    const names = doc.catalog.lookup(key('Names'));
    if (names instanceof PDFDict) walk(names.get(key('EmbeddedFiles')));
    const associated = doc.catalog.lookup(key('AF'));
    if (associated instanceof PDFArray) for (let i = 0; i < associated.size(); i++) add(associated.get(i));
    const snapshots = [...specs].filter(([, names]) => names.has('tldraw-snapshot.json'));
    if (snapshots.length !== 1) throw new Error(`Expected one control snapshot, found ${snapshots.length}`);
    const ef = snapshots[0][0].lookup(key('EF'));
    if (!(ef instanceof PDFDict)) throw new Error('Control snapshot has no EF');
    const stream = ef.lookup(key('UF')) ?? ef.lookup(key('F'));
    if (!(stream instanceof PDFRawStream)) throw new Error('Control snapshot is unreadable');
    const snapshot = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decodePDFRawStream(stream).decode()));
    const records = Object.values(snapshot.document?.store ?? {});
    result.drawRecords = records.filter(record => record.typeName === 'shape' && record.type === 'draw');
    return result;
}
