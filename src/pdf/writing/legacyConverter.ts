// Lazy worker-only legacy path: PDFium's public attachment API cannot recreate
// arbitrary Filespec metadata or AF associations. No imported-PDF parser is ours.
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFObjectCopier, PDFRawStream } from 'pdf-lib';
import type { PDFObject } from 'pdf-lib';
import { attachmentText, boundedAttachmentBytes, inventoryAttachments } from '../../utils/pdfAttachmentTree';
import type { AttachmentEntry } from '../../utils/pdfAttachmentTree';
import { inspectPdfRole } from '../../utils/pdfAttachmentInventory';
import { Sha256 } from '../../utils/sha256';

export interface LegacyConversionInput {
    pristine: Blob;
    outer: Blob;
    /** Names reserved for this revision's pristine, board, fence, media and mark. */
    reservedNames: readonly string[];
    /** Stable board format identifier supplied by its owner. */
    format: string;
}
export interface LegacyConversionResult {
    workingPdf: Blob;
    preserved: Array<{ originalName: string; name: string; sha256: string }>;
}
const key = PDFName.of;
const LIMIT = 0x7fffffff;

function bytesOf(spec: PDFDict): Uint8Array {
    const ef = spec.lookup(key('EF'));
    if (!(ef instanceof PDFDict)) throw new Error('An attachment has no readable file stream');
    const f = ef.lookup(key('F')), uf = ef.lookup(key('UF'));
    if (f && uf && f !== uf) throw new Error('An attachment has conflicting file streams');
    const stream = uf ?? f;
    if (!(stream instanceof PDFRawStream)) throw new Error('An attachment file stream is unreadable');
    return boundedAttachmentBytes(stream, LIMIT);
}
function declaredMarker(entry: AttachmentEntry): string | undefined {
    const desc = entry.description.startsWith('local-vault-pdf/') ? entry.description.split('\n', 1)[0] : undefined;
    const ef = entry.spec.lookup(key('EF'));
    const stream = ef instanceof PDFDict ? ef.lookup(key('F')) ?? ef.lookup(key('UF')) : undefined;
    const params = stream instanceof PDFRawStream ? stream.dict.lookup(key('Params')) : undefined;
    const raw = params instanceof PDFDict ? params.lookup(key('LocalVaultMarker')) : undefined;
    const param = attachmentText(raw);
    if (raw !== undefined && param === undefined || desc && param !== undefined && desc !== param) throw new Error('Conflicting attachment marker');
    return desc ?? param;
}
function ownedBoardEntry(entry: AttachmentEntry, format: string): boolean {
    if (entry.keys.length !== 1) return false;
    const name = entry.keys[0].decodeText(), marker = declaredMarker(entry);
    const role = name === 'original.pdf' ? 'pristine' : name === 'board.json' ? 'editable' :
        name === 'tldraw-snapshot.json' ? 'fence' : name === '.vault-write-mark' ? 'write-mark' :
        /^board-media\/[0-9a-f]{64}\.[a-zA-Z0-9]{1,16}$/.test(name) ? 'media' : '';
    return !!role && marker === `local-vault-pdf/v1;role=${role};format=${encodeURIComponent(format)}`;
}
function alias(name: string, number: number): string {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? `${name.slice(0, dot)} (recovered ${number})${name.slice(dot)}` : `${name} (recovered ${number})`;
}
function compare(a: Uint8Array, b: Uint8Array): number {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
    return a.length - b.length;
}

/** Build a separate pristine-based working graph with the lossless named union.
 * Unknown outer AF associations cannot be mapped safely to changed pages using
 * public PDFium, so refuse rather than silently relocate or remove them. */
export async function convertLegacyAttachmentUnion(input: LegacyConversionInput,
    cooperate: () => Promise<void>): Promise<LegacyConversionResult> {
    if (!(input.pristine instanceof Blob) || !(input.outer instanceof Blob) || input.pristine.size >= LIMIT || input.outer.size >= LIMIT ||
        !Array.isArray(input.reservedNames) || !input.format) throw new Error('Invalid legacy PDF conversion source');
    const pristineBytes = new Uint8Array(await input.pristine.arrayBuffer());
    const pristine = await PDFDocument.load(pristineBytes, { updateMetadata: false, parseSpeed: Infinity });
    await cooperate();
    const outerBytes = new Uint8Array(await input.outer.arrayBuffer());
    const outer = await PDFDocument.load(outerBytes, { updateMetadata: false, parseSpeed: Infinity });
    if (pristine.isEncrypted || outer.isEncrypted) throw new Error('Cannot safely convert encrypted PDF attachments');
    const sourceEntries = inventoryAttachments(pristine), outerEntries = inventoryAttachments(outer);
    const owned = new Set(outerEntries.filter(entry => ownedBoardEntry(entry, input.format)).map(entry => entry.id));
    const pristineHash = new Sha256().update(pristineBytes).digest();
    for (const entry of outerEntries) {
        if (owned.has(entry.id) && entry.keys[0].decodeText() === 'original.pdf' &&
            new Sha256().update(bytesOf(entry.spec)).digest() !== pristineHash) throw new Error('Pristine attachment does not match the source');
    }
    // Unmarked legacy names become ours only when the full guarded role reader
    // validates the pair and its embedded pristine bytes match this source.
    const legacy = await inspectPdfRole(outerBytes, 'legacy-conversion');
    if (legacy.kind === 'annotated' && new Sha256().update(legacy.original).digest() === pristineHash) {
        for (const entry of outerEntries) {
            if (entry.keys.length === 1 && ['original.pdf', 'tldraw-snapshot.json'].includes(entry.keys[0].decodeText())) owned.add(entry.id);
        }
    }
    const reserved = new Set(input.reservedNames), seen = new Map<string, Set<string>>();
    const named: Array<{ name: PDFHexString; raw: PDFObject }> = [];
    const preserved: LegacyConversionResult['preserved'] = [];
    const copier = PDFObjectCopier.for(outer.context, pristine.context);
    for (const [entries, fromOuter] of [[sourceEntries, false], [outerEntries, true]] as const) {
        for (const entry of entries) {
            await cooperate();
            if (fromOuter && owned.has(entry.id)) continue;
            const data = bytesOf(entry.spec), sha256 = new Sha256().update(data).digest();
            if (fromOuter && entry.associated) throw new Error('Cannot safely relocate an outer PDF associated attachment');
            const raw = fromOuter ? copier.copy(entry.raw) : entry.raw;
            for (const sourceName of entry.keys) {
                const name = sourceName.decodeText(), hashes = seen.get(name) ?? new Set<string>();
                if (hashes.has(sha256)) continue;
                hashes.add(sha256); seen.set(name, hashes);
                let target = name;
                if (reserved.has(target)) {
                    let n = 1;
                    while (reserved.has(alias(name, n))) n++;
                    target = alias(name, n);
                }
                reserved.add(target);
                let targetRaw = raw;
                if (target !== name) {
                    // PDFium reports Filespec /UF rather than the name-tree key.
                    // Clone only that spec so an existing AF reference stays
                    // attached to the untouched original, with other metadata intact.
                    const spec = pristine.context.lookup(raw);
                    if (!(spec instanceof PDFDict)) throw new Error('Cannot alias an unreadable Filespec');
                    const renamed = spec.clone();
                    renamed.set(key('F'), PDFHexString.fromText(target));
                    renamed.set(key('UF'), PDFHexString.fromText(target));
                    targetRaw = pristine.context.register(renamed);
                }
                named.push({ name: PDFHexString.fromText(target), raw: targetRaw });
                preserved.push({ originalName: name, name: target, sha256 });
            }
        }
    }
    named.sort((a, b) => compare(a.name.asBytes(), b.name.asBytes()));
    for (let i = 1; i < named.length; i++) if (compare(named[i - 1].name.asBytes(), named[i].name.asBytes()) >= 0) throw new Error('Duplicate converted attachment name');
    let names = pristine.catalog.lookup(key('Names'));
    if (names === undefined) { names = pristine.context.obj({}); pristine.catalog.set(key('Names'), names); }
    if (!(names instanceof PDFDict)) throw new Error('Cannot preserve the PDF Names dictionary');
    const pairs = pristine.context.obj([]) as PDFArray;
    for (const entry of named) { pairs.push(entry.name); pairs.push(entry.raw); }
    names.set(key('EmbeddedFiles'), pristine.context.register(pristine.context.obj({ Names: pairs })));
    await cooperate();
    const result = await pristine.save({ objectsPerTick: Infinity });
    await cooperate();
    return { workingPdf: new Blob([new Uint8Array(result)], { type: 'application/pdf' }), preserved };
}
