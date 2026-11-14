import type { WorkerContext } from '../../platform/workers';
import type { RenderToken } from '../../platform/render/types';
import { boardPageStack } from '../model/pages';
import type { BoardKind, HostBlock } from '../model/doc';
import { loadRepairPort } from '../model/loadRepair';
import type { RehydratedLoad } from '../model/loadTypes';
import { SampleStore } from '../ink/samples';
import { MediaStore } from '../media/store';
import type { InspectedMedia } from '../media/ingest';
import { BoardFonts } from '../text/fonts';
import { importLegacy } from '../import/import';
import { createLegacyLoadAdapter } from '../import/loadAdapter';
import { ReportBuilder, type ImportReport } from '../import/report';
import { readLegacyEnvelope } from '../import/records/envelope';
import { readShape } from '../import/records/common';
import { legacyPdfPages, type LegacyPageRect } from '../import/pages';
import { createLegacyDraftGeometry } from './legacyGeometry';
import { hasNativeMarkerIncremental } from '../format/jsonRead';
import { encodeDocumentRecords, encodeHeader, type EncoderContext, type SavedView } from '../format/encode';
import { LineTable } from '../format/lineTable';
import type { WriteResult } from '../format/writeTypes';
import { createBoardEncoderBounds } from '../host/encoderBounds';
import { createBoardRenderServices } from '../render/services';
import { LEGACY_SCAN_MAX_BYTES } from './legacyScan';

// Provenance: the independent legacy mapping, actual canonical font/geometry,
// native encoders and C5 repair. This worker creates bytes, never a session authority.
export interface LegacyPrepareRequest {
    readonly bytes: Blob;
    readonly kind: BoardKind;
    readonly host: HostBlock;
    readonly token: RenderToken;
    readonly zMax: number;
    /** Actual host inspections from the scan's copied bytes; each is rebound by SHA below. */
    readonly media: readonly InspectedMedia[];
}
export interface LegacyPrepareReply {
    readonly status: 'prepared' | 'read-only';
    readonly bytes: Blob | null;
    readonly report: ImportReport;
    readonly media: readonly Readonly<{ entry: import('../model/media').MediaEntry; blob: Blob }>[];
    readonly previousFrames: readonly LegacyPageRect[];
    readonly nextFrames: readonly LegacyPageRect[];
    readonly savedView?: SavedView;
    readonly conversionPending: true;
}
// FontFaceSet is worker-owned. Recreating its registry for each import would
// register another copy of every loaded face on every conversion.
let workerFonts: BoardFonts | undefined;
function take<T>(result: WriteResult<T>): T {
    if (!result.ok) throw new Error(`Legacy native source refused: ${result.error.reason}`);
    return result.value;
}
function validToken(token: RenderToken): boolean {
    return !!token && typeof token.documentId === 'string' && !!token.documentId
        && [token.vaultEpoch, token.session, token.bytesGeneration].every(value => Number.isSafeInteger(value) && value >= 0);
}
async function hash(blob: Blob, context: WorkerContext): Promise<string> {
    const bytes = await blob.arrayBuffer(); context.signal.throwIfAborted();
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)); context.signal.throwIfAborted();
    return `sha256:${Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
export async function legacyPrepare(value: unknown, context: WorkerContext): Promise<LegacyPrepareReply> {
    const request = value as LegacyPrepareRequest;
    if (!request || !(request.bytes instanceof Blob) || (typeof File !== 'undefined' && request.bytes instanceof File)
        || request.bytes.size > LEGACY_SCAN_MAX_BYTES || !['whiteboard', 'notebook', 'pdf-ink'].includes(request.kind)
        || request.host?.kind !== request.kind || !validToken(request.token) || !Number.isFinite(request.zMax) || request.zMax <= 0
        || !Array.isArray(request.media) || request.media.length > 100_000) throw new TypeError('Invalid copied legacy preparation request');
    const check = () => context.signal.throwIfAborted(), tick = async () => { check(); await context.slice(); check(); };
    const text = await request.bytes.text(); check();
    if (await hasNativeMarkerIncremental(text, tick)) throw new Error('A native source cannot enter legacy conversion');
    const inspections = new Map(request.media.map(item => [item.id, item]));
    for (const item of request.media) {
        if (!/^sha256:[0-9a-f]{64}$/.test(item.id) || !Number.isSafeInteger(item.width) || !Number.isSafeInteger(item.height)
            || item.width < 1 || item.height < 1) throw new TypeError('Invalid inspected legacy media');
    }
    const samples = new SampleStore(), media = new MediaStore();
    const fontSet = (globalThis as unknown as { fonts?: FontFaceSet }).fonts;
    if (!fontSet) throw new Error('Legacy geometry requires the actual worker FontFaceSet');
    const fonts = workerFonts ??= new BoardFonts(fontSet), draftGeometry = createLegacyDraftGeometry({ token: request.token,
        fonts, samples, media, current: () => !context.signal.aborted, cooperate: tick });
    let rendered: ReturnType<typeof createBoardRenderServices> | undefined, scope: { release(): void } | undefined;
    let imported: Awaited<ReturnType<typeof importLegacy<RehydratedLoad>>> | undefined;
    const previousFrames: LegacyPageRect[] = [];
    try {
        if (request.host.kind === 'pdf-ink') {
            const report = new ReportBuilder(), envelope = readLegacyEnvelope(text, report);
            if (envelope) {
                const shapes = [];
                for (const record of envelope.records) {
                    if (record.typeName === 'shape') shapes.push(readShape(record, report));
                    await tick();
                }
                previousFrames.push(...legacyPdfPages(shapes, request.host.pages.map(page => ({ w: page[0], h: page[1] }))).map(page => page.rect));
            }
        }
        const admit = createLegacyLoadAdapter({ port: loadRepairPort, declaredMaxScale: request.zMax, signal: context.signal, cooperate: tick });
        imported = await importLegacy(text, { kind: request.kind, host: request.host, samples, signal: context.signal,
            assertCurrent: check, textLayout: draftGeometry.textLayout, geometry: draftGeometry.geometry,
            prepareGeometry: draftGeometry.prepareGeometry,
            ...(request.host.kind === 'pdf-ink' ? { pageSource: { kind: 'pdf-ink' as const,
                pages: request.host.pages.map(page => ({ w: page[0], h: page[1] })) } } : {}),
            async admitMedia(blob) {
                const id = await hash(blob, context), inspected = inspections.get(id); check();
                if (!inspected) throw new Error('Legacy asset has no matching actual host inspection');
                return inspected;
            },
            repairRoot(node) {
                if (request.kind === 'whiteboard') return { page: -1, x: node.x, y: node.y };
                // Paged roots were assigned by the actual pre-page geometry hook.
                // An unresolved invalid ancestor has no invented page-zero geometry.
                throw new Error('Legacy orphan requires authoritative source geometry');
            },
            async admit(input, store, root, report) {
                const result = await admit(input, store, root, report); check();
                if (result.status !== 'editable' || !result.projection) throw new Error('Legacy mapping requires read-only preservation');
                return loadRepairPort.rehydrate(result.projection, (pts, header) => store.admitEncoded(pts, header), store, tick, context.signal);
            },
            releaseAdmitted: load => load.release(),
        });
        check();
        if (!imported.board || imported.readOnly) return { status: 'read-only', bytes: null, report: imported.report,
            media: [], previousFrames, nextFrames: [], conversionPending: true };
        const doc = imported.board.doc;
        rendered = createBoardRenderServices({ doc, samples, media, fonts, token: request.token, cooperate: tick });
        const ids = Array.from(doc.nodes.keys());
        scope = await rendered.pinChangeGeometry(ids, context.signal, doc, () => !context.signal.aborted); check();
        const renderer = rendered;
        const bounds = await createBoardEncoderBounds({ doc, sources: [], local: () => undefined,
            realize: async (node, signal) => (await renderer.prepareForPick(node, signal, doc)).bounds,
            geometryEpoch: () => fonts.epoch, cooperate: tick });
        await bounds.prepare(ids, context.signal); check();
        const encoder: EncoderContext = { bounds: bounds.bounds, zMax: request.zMax, readEncoded: node => samples.readEncoded(node.samples),
            stroke(node) {
                const seq = samples.sequence(node.samples), xy = new Float64Array(seq.count * 2);
                const pressure = samples.pressureMode(node.samples) === 'real' ? new Float64Array(seq.count) : null;
                const starts: number[] = [], kinds: number[] = [];
                for (let i = 0; i < seq.count; i++) {
                    xy[2 * i] = seq.x(i); xy[2 * i + 1] = seq.y(i); if (pressure) pressure[i] = seq.pressure(i)!;
                    if (i + 1 < seq.count) { const kind = seq.segmentKind(i) === 'straight' ? 1 : 0;
                        if (!kinds.length || kinds.at(-1) !== kind) { starts.push(i); kinds.push(kind); } }
                }
                return { xy, pressure, runs: kinds.length ? { starts: Uint32Array.from(starts), kinds: Uint8Array.from(kinds) } : null };
            },
            savedView: () => imported?.savedView, mediaRefs: doc.mediaRefs, preservedMediaRefs: doc.preservedMediaRefs };
        const lines = new LineTable(); take(lines.setHeader(take(encodeHeader(doc.kind, doc.preserved))));
        for (const record of encodeDocumentRecords(doc, encoder)) {
            take(await lines.setAsync(take(record), 0, { signal: context.signal, cooperate: tick })); await tick();
        }
        const bytes = take(await lines.assembleAsync(lines.integrity(), doc.preserved.end, { signal: context.signal, cooperate: tick })).blob;
        check();
        const stack = boardPageStack(doc.host), nextFrames = stack?.rects.map(rect => ({ x: rect.x, y: rect.y, w: rect.width, h: rect.height })) ?? [];
        const carried = imported.media.map(item => ({ entry: item.entry, blob: new Blob([new Uint8Array(item.bytes)], { type: item.entry.mime }) }));
        return { status: 'prepared', bytes, report: imported.report, media: carried, previousFrames, nextFrames,
            ...(imported.savedView ? { savedView: imported.savedView } : {}), conversionPending: true };
    } finally {
        try { scope?.release(); } finally { try { rendered?.dispose(); } finally { draftGeometry.dispose(); imported?.dispose(); } }
    }
}
