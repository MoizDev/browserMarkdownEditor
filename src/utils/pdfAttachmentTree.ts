// Worker-only typed PDF object traversal and legal EmbeddedFiles name-tree writer.
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFObjectCopier, PDFRawStream, PDFString, decodePDFRawStream, FileEmbedder } from 'pdf-lib';
import type { PDFObject } from 'pdf-lib';

const key = PDFName.of;
type PdfKey = PDFString | PDFHexString;
export interface AttachmentEntry {
    id: string;
    names: Set<string>;
    description: string;
    spec: PDFDict;
    raw: PDFObject;
    keys: PdfKey[];
    associated: boolean;
}
export function attachmentText(value: PDFObject | undefined): string | undefined {
    return value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : undefined;
}

/** Visit both branches of the old malformed tree; a partial inventory is never safe. */
export function inventoryAttachments(doc: PDFDocument): AttachmentEntry[] {
    const entries = new Map<PDFDict, AttachmentEntry>();
    let count = 0;
    function add(raw: PDFObject | undefined, name?: PdfKey, associated = false) {
        if (++count > 100000) throw new Error('Attachment inventory exceeds metadata limit');
        const value = doc.context.lookup(raw);
        if (!(value instanceof PDFDict) || !raw) throw new Error('Unreadable attachment Filespec');
        let entry = entries.get(value);
        if (!entry) {
            entry = { id: doc.context.getObjectRef(value)?.toString() ?? `direct:${entries.size}`, names: new Set(), description: attachmentText(value.lookup(key('Desc'))) ?? '', spec: value, raw, keys: [], associated: false };
            entries.set(value, entry);
        }
        if (name && !entry.keys.some(k => compareBytes(k.asBytes(), name.asBytes()) === 0)) entry.keys.push(name);
        entry.associated ||= associated;
        for (const n of [name?.decodeText(), attachmentText(value.lookup(key('UF'))), attachmentText(value.lookup(key('F')))]) if (n) entry.names.add(n);
    }
    const active = new Set<PDFDict>(), visited = new Set<PDFDict>();
    function walk(raw: PDFObject, depth: number) {
        if (depth > 64 || ++count > 100000) throw new Error('Attachment tree exceeds metadata limit');
        const node = doc.context.lookup(raw);
        if (!(node instanceof PDFDict)) throw new Error('Unreadable attachment tree node');
        if (active.has(node)) throw new Error('Cyclic attachment tree');
        if (visited.has(node)) return;
        active.add(node); visited.add(node);
        const pairs = node.lookup(key('Names'));
        if (pairs !== undefined) {
            if (!(pairs instanceof PDFArray) || pairs.size() % 2) throw new Error('Malformed attachment name pairs');
            for (let i = 0; i < pairs.size(); i += 2) {
                const name = pairs.lookup(i);
                if (!(name instanceof PDFString || name instanceof PDFHexString)) throw new Error('Unreadable attachment name');
                add(pairs.get(i + 1), name);
            }
        }
        const kids = node.lookup(key('Kids'));
        if (kids !== undefined) {
            if (!(kids instanceof PDFArray)) throw new Error('Malformed attachment children');
            for (let i = 0; i < kids.size(); i++) walk(kids.get(i), depth + 1);
        }
        active.delete(node);
    }
    const names = doc.catalog.lookup(key('Names'));
    if (names !== undefined) {
        if (!(names instanceof PDFDict)) throw new Error('Unreadable Names dictionary');
        const root = names.get(key('EmbeddedFiles'));
        if (root) walk(root, 0);
    }
    function associated(dict: PDFDict) {
        const af = dict.lookup(key('AF'));
        if (af === undefined) return;
        if (!(af instanceof PDFArray)) throw new Error('Unreadable associated attachments');
        for (let i = 0; i < af.size(); i++) add(af.get(i), undefined, true);
    }
    associated(doc.catalog);
    for (const page of doc.getPages()) {
        associated(page.node);
        const annotations = page.node.lookup(key('Annots'));
        if (annotations === undefined) continue;
        if (!(annotations instanceof PDFArray)) throw new Error('Unreadable page annotations');
        for (let i = 0; i < annotations.size(); i++) {
            const annotation = annotations.lookup(i);
            if (!(annotation instanceof PDFDict)) throw new Error('Unreadable page annotation');
            associated(annotation);
            if (annotation.lookup(key('Subtype')) === key('FileAttachment')) add(annotation.get(key('FS')), undefined, true);
        }
    }
    return [...entries.values()];
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
    return a.length - b.length;
}
function alias(name: string, n: number): string {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? `${name.slice(0, dot)} (recovered ${n})${name.slice(dot)}` : `${name} (recovered ${n})`;
}
async function digest(bytes: Uint8Array): Promise<string> {
    const hash = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
    return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}
// pdf-lib's getBytes(n) allocates n up front; asking for a 2 GiB cap on a
// tiny source allocates 2 GiB. Read incrementally and stop at the bound.
export function boundedAttachmentBytes(stream: PDFRawStream, limit: number): Uint8Array {
    const decoder = decodePDFRawStream(stream);
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
        const requested = Math.min(65536, limit - size + 1);
        const chunk = decoder.getBytes(requested);
        size += chunk.length;
        if (size > limit) throw new Error('Attachment exceeds size limit');
        chunks.push(new Uint8Array(chunk));
        if (chunk.length < requested) break;
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
}
function payload(entry: AttachmentEntry): Uint8Array {
    const ef = entry.spec.lookup(key('EF'));
    if (!(ef instanceof PDFDict)) throw new Error(`Cannot preserve attachment ${entry.id}: missing stream`);
    const f = ef.lookup(key('F')), uf = ef.lookup(key('UF'));
    if (f && uf && f !== uf) throw new Error(`Cannot safely preserve attachment ${entry.id}: conflicting streams`);
    const stream = uf ?? f;
    if (!(stream instanceof PDFRawStream)) throw new Error(`Cannot preserve attachment ${entry.id}: unreadable stream`);
    return boundedAttachmentBytes(stream, 0x7fffffff);
}

interface Named { name: PdfKey; raw: PDFObject; hash: string }
/** Copy the outer/pristine union, then replace only the known editable pair. */
export async function rebuildAttachmentTree(doc: PDFDocument, outer: PDFDocument | undefined, original: Uint8Array, snapshot: Uint8Array): Promise<{ named: Array<{ name: string; hash: string }>; associated: string[]; aliases: string[] }> {
    const named: Named[] = [], af: PDFObject[] = [], associated: string[] = [], aliases: string[] = [];
    const used = new Set<string>();
    const reserve = (name: string) => used.add(name);
    reserve('original.pdf'); reserve('tldraw-snapshot.json');
    const addSource = async (source: PDFDocument, isOuter: boolean) => {
        const copier = source === doc ? undefined : PDFObjectCopier.for(source.context, doc.context);
        for (const entry of inventoryAttachments(source)) {
            // Only the unique pair validated by inspectPdfRole is app-owned.
            const authorityNames = entry.keys.length ? entry.keys.map(k => k.decodeText()) : [...entry.names];
            if (isOuter && authorityNames.some(name => name === 'original.pdf' || name === 'tldraw-snapshot.json')) continue;
            const hash = await digest(payload(entry));
            const raw = copier ? copier.copy(entry.raw) : entry.raw;
            if (entry.associated) { af.push(raw); associated.push(hash); }
            for (const originalKey of entry.keys) {
                const name = originalKey.decodeText();
                if (named.some(e => e.name.decodeText() === name && e.hash === hash)) continue;
                let output = originalKey;
                if (used.has(name)) {
                    let n = 1;
                    while (used.has(alias(name, n))) n++;
                    output = PDFHexString.fromText(alias(name, n));
                    aliases.push(`${name} → ${output.decodeText()}`);
                }
                reserve(output.decodeText());
                named.push({ name: output, raw, hash });
            }
        }
    };
    await addSource(doc, false);
    if (outer && outer !== doc) await addSource(outer, true);
    for (const [name, bytes, mime, description] of [
        ['original.pdf', original, 'application/pdf', 'local-vault-pdf/v1;role=pristine;format=tldraw-legacy\nUnannotated source. Every save rebuilds from this, so strokes never compound.'],
        ['tldraw-snapshot.json', snapshot, 'application/json', 'local-vault-pdf/v1;role=editable;format=tldraw-legacy\nEditable annotations stamped on the pages.'],
    ] as const) {
        const ref = await FileEmbedder.for(bytes, name, { mimeType: mime, description }).embedIntoContext(doc.context);
        named.push({ name: PDFHexString.fromText(name), raw: ref, hash: await digest(bytes) });
        af.push(ref);
        associated.push(await digest(bytes));
    }
    named.sort((a, b) => compareBytes(a.name.asBytes(), b.name.asBytes()));
    for (let i = 1; i < named.length; i++) if (compareBytes(named[i - 1].name.asBytes(), named[i].name.asBytes()) >= 0) throw new Error('Duplicate attachment tree key');
    const makeLeaf = (items: Named[], limits: boolean) => {
        const pairs = doc.context.obj([]);
        for (const item of items) { pairs.push(item.name); pairs.push(item.raw); }
        const node = doc.context.obj({ Names: pairs });
        if (limits && items.length) node.set(key('Limits'), doc.context.obj([items[0].name, items[items.length - 1].name]));
        return { raw: doc.context.register(node), first: items[0]?.name, last: items[items.length - 1]?.name };
    };
    let root: PDFObject;
    if (named.length <= 64) root = makeLeaf(named, false).raw;
    else {
        let level = Array.from({ length: Math.ceil(named.length / 64) }, (_, i) => makeLeaf(named.slice(i * 64, i * 64 + 64), true));
        while (level.length > 32) {
            const next: typeof level = [];
            for (let i = 0; i < level.length; i += 32) {
                const children = level.slice(i, i + 32), first = children[0].first!, last = children[children.length - 1].last!;
                next.push({ raw: doc.context.register(doc.context.obj({ Kids: children.map(c => c.raw), Limits: [first, last] })), first, last });
            }
            level = next;
        }
        root = doc.context.register(doc.context.obj({ Kids: level.map(c => c.raw) }));
    }
    const existing = doc.catalog.lookup(key('Names'));
    if (existing !== undefined && !(existing instanceof PDFDict)) throw new Error('Cannot preserve PDF Names dictionary');
    const names = existing ? existing.clone() : doc.context.obj({});
    names.set(key('EmbeddedFiles'), root);
    doc.catalog.set(key('Names'), names);
    doc.catalog.set(key('AF'), doc.context.obj(af));
    return { named: named.map(item => ({ name: item.name.decodeText(), hash: item.hash })), associated, aliases };
}

function validateWrittenTree(doc: PDFDocument): void {
    const names = doc.catalog.lookup(key('Names'));
    if (!(names instanceof PDFDict)) throw new Error('Missing attachment names');
    const root = names.get(key('EmbeddedFiles'));
    if (!root) throw new Error('Missing attachment tree');
    function visit(raw: PDFObject, depth: number, isRoot: boolean): [PdfKey, PdfKey] {
        if (depth > 64) throw new Error('Invalid attachment tree depth');
        const node = doc.context.lookup(raw);
        if (!(node instanceof PDFDict)) throw new Error('Invalid attachment tree node');
        const pairs = node.lookup(key('Names')), kids = node.lookup(key('Kids'));
        if ((pairs === undefined) === (kids === undefined)) throw new Error('Invalid attachment tree shape');
        let first: PdfKey, last: PdfKey;
        if (pairs !== undefined) {
            if (!(pairs instanceof PDFArray) || !pairs.size() || pairs.size() % 2 || pairs.size() > 128) throw new Error('Invalid attachment leaf');
            const keys: PdfKey[] = [];
            for (let i = 0; i < pairs.size(); i += 2) {
                const name = pairs.lookup(i);
                if (!(name instanceof PDFString || name instanceof PDFHexString)) throw new Error('Invalid attachment key');
                if (keys.length && compareBytes(keys[keys.length - 1].asBytes(), name.asBytes()) >= 0) throw new Error('Unsorted attachment keys');
                keys.push(name);
            }
            first = keys[0]; last = keys[keys.length - 1];
        } else {
            if (!(kids instanceof PDFArray) || !kids.size() || kids.size() > 32) throw new Error('Invalid attachment branch');
            const ranges = Array.from({ length: kids.size() }, (_, i) => visit(kids.get(i), depth + 1, false));
            for (let i = 1; i < ranges.length; i++) if (compareBytes(ranges[i - 1][1].asBytes(), ranges[i][0].asBytes()) >= 0) throw new Error('Overlapping attachment limits');
            first = ranges[0][0]; last = ranges[ranges.length - 1][1];
        }
        if (!isRoot) {
            const limits = node.lookup(key('Limits'));
            if (!(limits instanceof PDFArray) || limits.size() !== 2) throw new Error('Missing attachment limits');
            const low = limits.lookup(0), high = limits.lookup(1);
            if (!(low instanceof PDFString || low instanceof PDFHexString) || !(high instanceof PDFString || high instanceof PDFHexString) ||
                compareBytes(low.asBytes(), first.asBytes()) || compareBytes(high.asBytes(), last.asBytes())) throw new Error('Invalid attachment limits');
        }
        return [first, last];
    }
    visit(root, 0, true);
}

/** A successful serialization is not enough: reparse and re-hash before the write funnel sees bytes. */
export async function verifyAttachmentTree(bytes: Uint8Array, expected: { named: Array<{ name: string; hash: string }>; associated: string[] }): Promise<void> {
    const doc = await PDFDocument.load(bytes, { parseSpeed: Infinity, updateMetadata: false });
    validateWrittenTree(doc);
    const entries = inventoryAttachments(doc);
    const names = new Map<string, string>(), associated: string[] = [];
    for (const entry of entries) {
        const hash = await digest(payload(entry));
        if (entry.associated) associated.push(hash);
        for (const name of entry.keys) {
            const decoded = name.decodeText();
            if (names.has(decoded)) throw new Error('Duplicate attachment after PDF rebuild');
            names.set(decoded, hash);
        }
    }
    if (names.size !== expected.named.length || expected.named.some(item => names.get(item.name) !== item.hash) ||
        expected.associated.some(hash => !associated.includes(hash))) {
        throw new Error('PDF attachment verification failed; nothing was saved.');
    }
}
