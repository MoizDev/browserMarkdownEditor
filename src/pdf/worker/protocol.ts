import type { PageGeometry } from '../../platform/types';
import type { MainMessage, WorkerMessage } from '../../platform/workers/envelope';
import type { BackendInfo, DocInfo, EngineLimits, FontSpec, PageComplexity, RawOutlineNode, RawPdfLink, DeviceRect, PdfEngineRole } from '../engine/types';
import type { FigureTag, Schema2PageText, LineTable } from '../text/types';
import type { EMPHASIS_ALGORITHM, EMPHASIS_REVISION, EMPHASIS_STROKE_EM } from '../emphasis/profile';

export const PDF_ENGINE_PROTOCOL = 1;
export const PDF_ENGINE_ROLE_VERSION = 1;
export type PdfDocKey = string;
export type PdfTextDetail = 'text' | 'model' | 'select';
export interface PdfDocumentIdentity {
    vaultEpoch: number;
    documentId: string;
    bytesGeneration: number;
    source: 'outer' | 'original';
}

/** No paths, hashes, reader byteGeneration or view/session serial enter this cache key. */
export function pdfDocKey(identity: PdfDocumentIdentity): PdfDocKey {
    if (!Number.isSafeInteger(identity.vaultEpoch) || identity.vaultEpoch < 0 ||
        !Number.isSafeInteger(identity.bytesGeneration) || identity.bytesGeneration < 0 ||
        typeof identity.documentId !== 'string' || !identity.documentId.length || identity.documentId.length > 1024 ||
        /[:\u0000-\u001f]/u.test(identity.documentId) || !['outer', 'original'].includes(identity.source)) {
        throw new RangeError('Invalid PDF document identity');
    }
    return `${identity.vaultEpoch}:${identity.documentId}:${identity.bytesGeneration}:${identity.source}`;
}
export function parsePdfDocKey(value: string): PdfDocumentIdentity {
    if (typeof value !== 'string') throw new RangeError('Invalid PDF document key');
    const fields = value.split(':');
    if (fields.length !== 4) throw new RangeError('Invalid PDF document key');
    const identity = { vaultEpoch: Number(fields[0]), documentId: fields[1], bytesGeneration: Number(fields[2]),
        source: fields[3] as PdfDocumentIdentity['source'] };
    if (pdfDocKey(identity) !== value) throw new RangeError('Noncanonical PDF document key');
    return identity;
}

export interface EngineInitArgs {
    wasm: WebAssembly.Module;
    buildId: string;
    artifactSha256: string;
    assetBase: string;
    role: PdfEngineRole;
    protocol: typeof PDF_ENGINE_PROTOCOL;
    roleVersion: typeof PDF_ENGINE_ROLE_VERSION;
    limits: Readonly<EngineLimits>;
}
export interface DocOpenArgs { docKey: PdfDocKey; source: Blob; size: number; password?: string }
export interface PageArgs { docKey: PdfDocKey; page: number }
export interface EmphasisSpec {
    algorithm: typeof EMPHASIS_ALGORITHM;
    revision: typeof EMPHASIS_REVISION;
    strokeEm: typeof EMPHASIS_STROKE_EM;
    locale?: string;
}
export type TileVariant = { variant: 'plain'; emphasis?: never } | { variant: 'emphasis'; emphasis: EmphasisSpec };
export type PageTileArgs = PageArgs & TileVariant & {
    reqId: number;
    scale: number;
    /** Interior in the integer device-page grid. Reply includes exactly a 1px apron on each side. */
    rect: DeviceRect;
    profileKey: string;
    annotations: boolean;
    forms: boolean;
};
export type PageTileResult = PageTileArgs & {
    /** Opaque RGBA; internal engine bleed cropped, off-page apron filled white. */
    pixels: ArrayBuffer;
    w: number;
    h: number;
    heapBytes: number;
    ms: { load: number; render: number; copy: number };
    emphasisResult?: { eligibleGlyphs: number; changedPixels: number };
};

/** Maps cannot cross C5's plain-data boundary. The worker serializes LineTable's
 * heading map to tuples; every other selection array is transferred, not cloned. */
export interface PageSelectionModel extends Omit<LineTable, 'headingLevels' | 'figures'> {
    charU16: Uint32Array;
    loose: Float32Array;
    flags: Uint8Array;
    headingLevels?: Array<[line: number, level: 1 | 2 | 3 | 4 | 5 | 6]>;
    figures: readonly FigureTag[];
}
export interface PageTextReply {
    docKey: PdfDocKey;
    page: number;
    schema: 2;
    text: string;
    tokenBreaks: Uint32Array;
    quality: 'available' | 'partial' | 'none';
    reasons: string[];
    model?: Schema2PageText;
    digest?: string;
    sel?: PageSelectionModel;
}
export interface PageProbeArgs extends PageArgs, EmphasisSpec { profileKey: string; maxPixels: number }
export interface PageProbeResult {
    complete: true;
    candidates: number;
    eligibleGlyphs: number;
    changedPixels: number;
    capability: 'supported' | 'unavailable';
    reason?: 'no-text' | 'no-eligible-prefixes' | 'ambiguous-glyphs' | 'no-visible-change';
    probe: { profile: 'page-probe-v1'; scale: number; w: number; h: number; rendered: boolean };
}
export interface PdfWorkerStats { heapBytes: number; docs: number; pagesLoaded: number; blockCacheBytes: number }

/** Operations are a type refinement of C5, never a competing transport/envelope. */
export interface PdfEngineOps {
    'engine.init': { args: EngineInitArgs; result: BackendInfo & { initMs: number; heapBytes: number } };
    'doc.open': { args: DocOpenArgs; result: DocInfo };
    'doc.close': { args: { docKey: PdfDocKey }; result: Record<string, never> };
    'page.tile': { args: PageTileArgs; result: PageTileResult };
    'page.text': { args: PageArgs & { detail: PdfTextDetail }; result: PageTextReply };
    'page.links': { args: PageArgs; result: RawPdfLink[] };
    'page.emphasisProbe': { args: PageProbeArgs; result: PageProbeResult };
    'page.complexity': { args: PageArgs; result: PageComplexity };
    'page.release': { args: PageArgs; result: Record<string, never> };
    'doc.outline': { args: { docKey: PdfDocKey }; result: RawOutlineNode[] };
    'doc.attachment': { args: { docKey: PdfDocKey; index: number; maxBytes: number }; result: ArrayBuffer };
    'font.provide': { args: { spec: FontSpec; bytes: ArrayBuffer }; result: Record<string, never> };
    'worker.stats': { args: Record<string, never>; result: PdfWorkerStats };
}
export type PdfEngineOp = keyof PdfEngineOps;
export type PdfArgs<K extends PdfEngineOp> = PdfEngineOps[K]['args'];
export type PdfResult<K extends PdfEngineOp> = PdfEngineOps[K]['result'];
export type PdfMainMessage = MainMessage;
export type PdfWorkerMessage = WorkerMessage;
export interface PdfEngineEvents {
    'font.needed': { spec: FontSpec; docKey: PdfDocKey; page: number };
    'page.geometry': { docKey: PdfDocKey; geometry: PageGeometry };
}
