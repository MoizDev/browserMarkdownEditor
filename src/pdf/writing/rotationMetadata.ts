import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFRef, PDFString } from 'pdf-lib';
import type { PDFObject } from 'pdf-lib';
import { inventoryAttachments } from '../../utils/pdfAttachmentTree';
import { Sha256 } from '../../utils/sha256';
import type { WorkerContext } from '../../platform/workers/serve';
import { PdfInkInspector } from './inkInspection';

const key = PDFName.of, MAX = 100_000;
const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
async function streamHash(bytes: Uint8Array, ctx: WorkerContext): Promise<string> {
    const hash = new Sha256();
    for (let i = 0; i < bytes.length; i += 1024 * 1024) { await ctx.slice(); hash.update(bytes.subarray(i, i + 1024 * 1024)); }
    return hash.digest();
}

/** Exact conservative fingerprint of the full attachment object graphs and AF locations. */
export async function rotationAttachmentInventory(blob: Blob, ctx: WorkerContext): Promise<string> {
    const inspector = new PdfInkInspector();
    try {
        const admission = await inspector.inspect(blob, () => ctx.slice());
        if (admission.kind !== 'plain') throw new Error('PDF rotation requires an unambiguous plain source');
        inspector.release(admission.id);
    } finally { inspector.dispose(); }
    await ctx.slice();
    const doc = await PDFDocument.load(await blob.arrayBuffer(), { parseSpeed: Infinity, updateMetadata: false });
    await ctx.slice();
    if (doc.isEncrypted) throw new Error('Encrypted PDF cannot be rotated');
    const entries = inventoryAttachments(doc), ids = new Map(entries.map((entry, index) => [entry.spec, index]));
    const locations: string[][] = entries.map(() => []), names = new Set<string>(), nodes = new Set<PDFDict>();
    const namesDict = doc.catalog.lookup(key('Names'));
    if (namesDict !== undefined && !(namesDict instanceof PDFDict)) throw new Error('Invalid PDF attachment names');
    const root = namesDict instanceof PDFDict ? namesDict.get(key('EmbeddedFiles')) : undefined;
    const stack = root ? [{ raw: root, depth: 0 }] : [];
    while (stack.length) {
        const { raw, depth } = stack.pop()!, node = doc.context.lookup(raw);
        if (!(node instanceof PDFDict) || depth > 64 || nodes.has(node) || nodes.size >= MAX) throw new Error('Ambiguous PDF attachment tree');
        nodes.add(node);
        const pairs = node.lookup(key('Names'));
        if (pairs !== undefined) {
            if (!(pairs instanceof PDFArray) || pairs.size() % 2 || pairs.size() > MAX * 2) throw new Error('Invalid PDF attachment names');
            for (let i = 0; i < pairs.size(); i += 2) {
                const name = pairs.lookup(i), spec = pairs.lookup(i + 1);
                if (!(name instanceof PDFString || name instanceof PDFHexString) || !(spec instanceof PDFDict)) throw new Error('Invalid PDF attachment entry');
                const encoded = hex(name.asBytes()), index = ids.get(spec);
                if (index === undefined || names.has(encoded) || names.size >= MAX) throw new Error('Duplicate PDF attachment entry');
                names.add(encoded); locations[index].push(`name:${encoded}`);
            }
        }
        const kids = node.lookup(key('Kids'));
        if (kids !== undefined) {
            if (!(kids instanceof PDFArray) || kids.size() > MAX - nodes.size - stack.length) throw new Error('Invalid PDF attachment tree');
            for (let i = 0; i < kids.size(); i++) stack.push({ raw: kids.get(i), depth: depth + 1 });
        }
    }
    const add = (raw: PDFObject | undefined, location: string) => {
        const spec = doc.context.lookup(raw);
        if (!(spec instanceof PDFDict)) throw new Error('Invalid PDF associated file');
        const index = ids.get(spec);
        if (index === undefined || locations[index].includes(location)) throw new Error('Ambiguous PDF associated file');
        locations[index].push(location);
    };
    const associations = (dictionary: PDFDict, location: string) => {
        const af = dictionary.lookup(key('AF'));
        if (af === undefined) return;
        if (!(af instanceof PDFArray) || af.size() > MAX) throw new Error('Invalid PDF associations');
        for (let i = 0; i < af.size(); i++) add(af.get(i), location);
    };
    associations(doc.catalog, 'catalog');
    let annotationCount = 0;
    for (const [index, page] of doc.getPages().entries()) {
        associations(page.node, `page:${index}`);
        const annots = page.node.lookup(key('Annots'));
        if (annots === undefined) continue;
        if (!(annots instanceof PDFArray) || (annotationCount += annots.size()) > MAX) throw new Error('Invalid PDF annotations');
        for (let j = 0; j < annots.size(); j++) {
            const annotation = annots.lookup(j);
            if (!(annotation instanceof PDFDict)) throw new Error('Invalid PDF annotation');
            associations(annotation, `annotation:${index}:${j}`);
            if (annotation.lookup(key('Subtype')) === key('FileAttachment')) add(annotation.get(key('FS')), `attachment:${index}:${j}`);
        }
        await ctx.slice();
    }
    let work = 0;
    const active = new Set<PDFObject>();
    const value = async (raw: PDFObject, depth: number): Promise<unknown> => {
        if (++work > MAX || depth > 64) throw new Error('PDF attachment metadata exceeds its limit');
        const obj = raw instanceof PDFRef ? doc.context.lookup(raw) : raw;
        if (!obj || active.has(obj)) throw new Error('Cyclic PDF attachment metadata');
        if (obj instanceof PDFArray || obj instanceof PDFDict || obj instanceof PDFRawStream) {
            active.add(obj);
            try {
                if (obj instanceof PDFArray) {
                    const parts: unknown[] = []; for (let i = 0; i < obj.size(); i++) parts.push(await value(obj.get(i), depth + 1));
                    return ['array', parts];
                }
                const dict = obj instanceof PDFRawStream ? obj.dict : obj;
                const pairs = [...dict.entries()].sort((a, b) => a[0].toString().localeCompare(b[0].toString()));
                const parts: unknown[] = [];
                for (const [name, child] of pairs) parts.push([name.toString(), await value(child, depth + 1)]);
                return obj instanceof PDFRawStream ? ['stream', parts, await streamHash(obj.contents, ctx)] : ['dict', parts];
            } finally { active.delete(obj); }
        }
        return [obj.constructor.name, obj.toString()];
    };
    const output: string[] = [];
    for (let i = 0; i < entries.length; i++) {
        await ctx.slice();
        if (!locations[i].length || entries[i].keys.length > 1 || entries[i].names.size !== 1) throw new Error('Ambiguous PDF attachment identity');
        output.push(JSON.stringify([locations[i].sort(), await value(entries[i].spec, 0)]));
    }
    output.sort();
    const pages: unknown[] = [];
    for (const page of doc.getPages()) {
        await ctx.slice();
        const fields: unknown[] = [];
        for (const [name, child] of [...page.node.entries()].sort((a, b) => a[0].toString().localeCompare(b[0].toString()))) {
            if (name === key('Parent') || name === key('Rotate') || name === key('Resources')) continue;
            fields.push([name.toString(), await value(child, 0)]);
        }
        const resources = page.node.Resources(), mediaBox = page.node.MediaBox(), cropBox = page.node.CropBox();
        pages.push([fields, resources ? await value(resources, 0) : null,
            mediaBox ? await value(mediaBox, 0) : null, cropBox ? await value(cropBox, 0) : null]);
    }
    return new Sha256().update(new TextEncoder().encode(JSON.stringify([output, pages]))).digest();
}
