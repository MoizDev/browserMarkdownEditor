import { Sha256 } from '../../utils/sha256';
import { encodeHost } from '../../whiteboard/format/encode';
import { NATIVE_FORMAT_ID } from '../../whiteboard/format/identity';
import { parseJson } from '../../whiteboard/format/jsonRead';
import type { HostBlock } from '../../whiteboard/model/doc';
import type { MediaId } from '../../whiteboard/model/media';
import { validateConvertedBoardHostIdentity } from '../writing/boardIdentity';
import { markConvertedPdfInkSource } from './convertedInkBrand';
import { validatePdfInkConversionHost } from './inkHost';
import { isPreparedPdfLegacyConversion } from './legacyInkAcquisition';
import type { PdfConvertedInkSource, PdfLegacyConversionReady } from './legacyInkAcquisition.types';

export { isConvertedPdfInkSource } from './convertedInkBrand';

type PdfHost = Extract<HostBlock, { kind: 'pdf-ink' }>;
const inflight = new WeakSet<PdfLegacyConversionReady>(), consumed = new WeakSet<PdfLegacyConversionReady>();
const MEDIA = /^board-media\/([0-9a-f]{64})\.(png|jpg|gif|webp|avif|svg|mp4|webm|mov)$/;
const stale = () => new DOMException('Converted PDF source is no longer current', 'AbortError');
const memoryBlob = (value: unknown): value is Blob => value instanceof Blob &&
    !(typeof File !== 'undefined' && value instanceof File) && value.size > 0 && value.size < 0x80000000;

/** On success ownership transfers to the adapter; on failure it stays with the caller. */
export async function createConvertedPdfInkSource(ready: PdfLegacyConversionReady, options: {
    readonly board: Blob;
    readonly host: PdfHost;
    readonly media: ReadonlyMap<MediaId, Blob>;
    readonly signal?: AbortSignal;
}): Promise<PdfConvertedInkSource> {
    if (!isPreparedPdfLegacyConversion(ready) || inflight.has(ready) || consumed.has(ready)) throw new Error('PDF conversion is not available for transfer');
    inflight.add(ready);
    try {
        const check = () => { options.signal?.throwIfAborted(); if (!ready.isCurrent()) throw stale(); };
        check();
        if (!memoryBlob(options.board) || options.host.kind !== 'pdf-ink' || options.host.ext !== null ||
            ready.writeSafety.kind !== 'safe' || !validatePdfInkConversionHost(ready, options.host)) throw new Error('Invalid final PDF conversion host');
        const host: PdfHost = { kind: 'pdf-ink', pdf: options.host.pdf, pages: options.host.pages.map(page => [page[0], page[1]] as const), ext: null };
        const encoded = encodeHost(host);
        if (!encoded.ok) throw new Error('Invalid final PDF conversion host');
        const metadata = parseJson(host.pdf).fieldMap(), writeId = metadata.get('writeId')?.string(32);
        if (!writeId || !/^[0-9a-f]{32}$/.test(writeId)) throw new Error('Invalid PDF conversion write identity');
        const migration = metadata.get('migration')?.fieldMap(), frameSpan = migration?.get('previousFrames');
        if (!frameSpan) throw new Error('Missing PDF migration frames');
        const previousFrames = [...frameSpan.items()].map(frame => {
            const fields = frame.fieldMap();
            return Object.freeze({ width: fields.get('width')!.number(), height: fields.get('height')!.number() });
        });
        const legacyMigration = Object.freeze({ writeId, previousFrames: Object.freeze(previousFrames) });
        const media = new Map<MediaId, Blob>();
        for (const [id, blob] of options.media) {
            if (!/^sha256:[0-9a-f]{64}$/.test(id) || !memoryBlob(blob) || media.has(id) || media.size >= 100_000) throw new Error('Invalid converted PDF media');
            media.set(id, blob);
        }
        await validateConvertedBoardHostIdentity(options.board, NATIVE_FORMAT_ID, writeId, encoded.value.text, async () => { check(); });
        check();
        if (!validatePdfInkConversionHost(ready, host)) throw new Error('PDF conversion host changed');
        let released = false, releasePromise: Promise<void> | undefined;
        const current = () => {
            if (released) return false;
            try { return ready.isCurrent(); } catch { return false; }
        };
        const guard = () => { if (!current()) throw stale(); };
        const result: PdfConvertedInkSource = {
            kind: 'legacy-converted', source: ready.source, pages: ready.pages, board: options.board,
            writeSafety: ready.writeSafety, legacyOriginalSha256: ready.legacyOriginalSha256, legacySnapshot: ready.snapshot, legacyMigration,
            isCurrent: current,
            release() {
                if (!releasePromise) { released = true; releasePromise = Promise.resolve().then(() => ready.release()); }
                return releasePromise;
            },
            async readMedia(name, signal) {
                guard(); signal?.throwIfAborted();
                const match = MEDIA.exec(name), blob = match && media.get(`sha256:${match[1]}` as MediaId);
                if (!match || !blob) throw new Error('Converted PDF media is unavailable');
                const hash = new Sha256();
                for (let offset = 0; offset < blob.size; offset += 1024 * 1024) {
                    guard(); signal?.throwIfAborted();
                    const bytes = await blob.slice(offset, offset + 1024 * 1024).arrayBuffer();
                    guard(); signal?.throwIfAborted(); hash.update(new Uint8Array(bytes));
                }
                guard(); signal?.throwIfAborted();
                if (hash.digest() !== match[1]) throw new Error('Converted PDF media fingerprint mismatch');
                return blob;
            },
            async openWriter(signal) {
                guard(); signal?.throwIfAborted();
                const writer = await ready.openWriter(signal);
                try { guard(); signal?.throwIfAborted(); return writer; } catch (error) { await writer.close(); throw error; }
            },
            async createBackdrop(viewOptions) {
                guard(); viewOptions.signal?.throwIfAborted();
                const view = await ready.createBackdrop(viewOptions);
                try { guard(); viewOptions.signal?.throwIfAborted(); return view; } catch (error) { view.dispose(); throw error; }
            },
        };
        markConvertedPdfInkSource(result);
        consumed.add(ready);
        return Object.freeze(result);
    } finally { inflight.delete(ready); }
}
