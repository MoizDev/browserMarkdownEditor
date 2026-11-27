import type { PageGeometry } from '../../platform/types';
import type { PdfiumJbig2Regions } from './pdfium/imageRegions.types';
import type { RawPdfLink, PdfLinkDestination } from '../pdfLinkModel';
import type { RawPageText as ProjectableRawPageText } from '../text/types';

export type { PageGeometry, RawPdfLink };
export type PdfEngineRole = 'render' | 'writer';

export interface ByteSource {
    readonly size: number;
    read(offset: number, length: number): Uint8Array;
}

export interface EngineLimits {
    maxPages: number;
    maxPagePoints: number;
    maxChars: number;
    maxTextObjects: number;
    maxFonts: number;
    maxLinks: number;
    maxUriBytes: number;
    maxOutlineDepth: number;
    maxOutlineNodes: number;
    maxDecodedImageBytes: number;
    maxTileEdge: number;
    maxTileBytes: number;
    maxHeapBytes: number;
}

export const RENDER_ENGINE_LIMITS: Readonly<EngineLimits> = Object.freeze({
    maxPages: 100_000, maxPagePoints: 14_400, maxChars: 200_000,
    maxTextObjects: 20_000, maxFonts: 512, maxLinks: 5_000, maxUriBytes: 8_192,
    maxOutlineDepth: 64, maxOutlineNodes: 20_000,
    maxDecodedImageBytes: 512 * 1024 * 1024,
    maxTileEdge: 2048, maxTileBytes: 2048 * 2048 * 4, maxHeapBytes: 1024 * 1024 * 1024,
});
export const WRITER_ENGINE_LIMITS: Readonly<EngineLimits> = Object.freeze({
    ...RENDER_ENGINE_LIMITS, maxHeapBytes: 3.5 * 1024 * 1024 * 1024,
});

export interface FontSpec { family: string; weight: number; italic: boolean; charset?: number; readonly language?: string }
export interface FontProvider {
    request(spec: FontSpec): Uint8Array | undefined;
}
export interface BackendEnv {
    wasm?: WebAssembly.Module;
    assetBase: string;
    fonts: FontProvider;
    limits: Readonly<EngineLimits>;
}
export interface BackendInfo {
    engine: string;
    version: string;
    artifactSha256: string;
    buildId: string;
    features: Array<'forms' | 'emphasis' | 'structTree' | 'outline' | 'attachments' | 'write'>;
}
export interface PdfAttachmentInfo {
    index: number; name: string;
    size: number | null;
    desc?: string;
    localVaultMarker?: string;
}
export interface PdfPageExtent { index: number; width: number; height: number }
export interface DocInfo {
    pageCount: number;
    pages: PdfPageExtent[];
    encrypted: boolean;
    /** Raw unsigned FPDF_GetDocPermissions bits; null means unavailable, not permission granted. */
    permissions: number | null;
    signatureCount: number;
    tagged: boolean;
    hasForms: boolean;
    formType: 'none' | 'acroform' | 'xfa-full' | 'xfa-foreground' | 'unknown';
    javascript: 'present' | 'absent' | 'unknown';
    actions: 'present' | 'absent' | 'unknown';
    attachments: PdfAttachmentInfo[];
    attachmentInventory: 'full' | 'name-tree-params-only' | 'unknown';
    pdfVersion: number | null;
    repairStatus: 'clean' | 'repaired' | 'unknown';
}
export interface PageComplexity {
    objects: number; textObjects: number; imageObjects: number;
    imagePixels: number; pathObjects: number; formObjects: number;
}
export interface RawOutlineNode {
    title: string;
    dest?: PdfLinkDestination;
    children: RawOutlineNode[];
}

export interface RawPageText extends ProjectableRawPageText {
    textMatrix: Float32Array;
    fontAscent: Float32Array;
    fontDescent: Float32Array;
    objects: ProjectableRawPageText['objects'] & {
        sourceFontSize: Float32Array;
        opacity: Float32Array;
        hasTransparency: Uint8Array;
        type3?: Uint8Array;
    };
    struct?: NonNullable<ProjectableRawPageText['struct']> & {
        actualText?: Array<[mcid: number, text: string]>;
    };
}

export interface DeviceRect { x: number; y: number; w: number; h: number }
export interface RenderRequest {
    page: number; scale: number; rect: DeviceRect;
    annotations: boolean; forms: boolean;
}
export interface RenderPixels {
    pixels: Uint8Array; stride: number;
    originX: number; originY: number; w: number; h: number;
}
export interface RenderJob {
    step(budgetMs: number): 'more' | 'done';
    /** Backend-owned RGBA, opaque white outside content; valid only until next op/abort. */
    result(): RenderPixels;
    abort(): void;
}
export interface BackendDoc {
    info(): DocInfo;
    pageCount(): number;
    page(index: number): PageGeometry & { userUnit: 1 };
    complexity(index: number): PageComplexity;
    imageRegions(index: number): PdfiumJbig2Regions;
    render(request: RenderRequest): RenderJob;
    text(index: number): RawPageText;
    links(index: number): RawPdfLink[];
    outline(limits: { maxDepth: number; maxNodes: number }): RawOutlineNode[];
    attachments(): PdfAttachmentInfo[];
    attachment(index: number, maxBytes: number): Uint8Array;
    openEmphasisClone?(): BackendDoc;
    /** Only a disposable clone may mutate objects. Ordinary documents throw NotSupported. */
    emphasisStroked?(request: RenderRequest, objectIndexes: Int32Array, strokeEm: number): RenderJob;
    residentPages(): number;
    releasePage(index: number): void;
    close(): void;
}
export interface PdfBackend {
    readonly id: string;
    init(env: BackendEnv): BackendInfo;
    open(source: ByteSource, options: { password?: string }): BackendDoc;
    heapBytes(): number;
    close?(): void;
}

export type PdfEngineErrorName = 'PasswordRequired' | 'UnsupportedSecurity' | 'InvalidPdf' | 'FileError'
    | 'PageError' | 'NotFoundError' | 'AbortError' | 'NotSupported' | 'RangeError' | 'ResourceLimit'
    | 'EngineBroken' | 'WorkerDied' | 'FontPending';
export class PdfEngineError extends Error {
    constructor(name: PdfEngineErrorName, message: string) { super(message); this.name = name; }
}

export class PdfFontPendingError extends PdfEngineError {
    constructor(readonly specs: readonly FontSpec[]) { super('FontPending', 'PDF fonts are pending; reopen the document after supplying them'); }
}
