// Lazy worker-only legacy path: PDFium's public attachment API cannot recreate
// arbitrary Filespec metadata or AF associations. No imported-PDF parser is ours.
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFObjectCopier, PDFRawStream } from 'pdf-lib';
import type { PDFObject } from 'pdf-lib';
import { boundedAttachmentBytes, inventoryAttachments } from '../../utils/pdfAttachmentTree';
import { Sha256 } from '../../utils/sha256';

export interface LegacyConversionInput {
    pristine: Blob;
    outer: Blob;
    /** Resolved and role-validated Filespec IDs, never names guessed by a caller. */
    ownedOuterIds: readonly string[];
    /** Names reserved for this revision's pristine, board, fence, media and mark. */
    reservedNames: readonly string[];
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
        !Array.isArray(input.ownedOuterIds) || !Array.isArray(input.reservedNames)) throw new Error('Invalid legacy PDF conversion source');
    const pristine = await PDFDocument.load(new Uint8Array(await input.pristine.arrayBuffer()), { updateMetadata: false, parseSpeed: Infinity });
    await cooperate();
    const outer = await PDFDocument.load(new Uint8Array(await input.outer.arrayBuffer()), { updateMetadata: false, parseSpeed: Infinity });
    if (pristine.isEncrypted || outer.isEncrypted) throw new Error('Cannot safely convert encrypted PDF attachments');
    const sourceEntries = inventoryAttachments(pristine), outerEntries = inventoryAttachments(outer);
    const owned = new Set(input.ownedOuterIds);
    if (owned.size !== input.ownedOuterIds.length || [...owned].some(id => !outerEntries.some(entry => entry.id === id))) throw new Error('Invalid app-owned attachment authority');
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
                named.push({ name: PDFHexString.fromText(target), raw });
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
