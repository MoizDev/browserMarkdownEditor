import type { PageGeometry } from '../../platform/types';
import type { RawPdfLink, PdfLinkDestination } from '../pdfLinkModel';
import type { RawPageText as ProjectableRawPageText } from '../text/types';

export type { PageGeometry, RawPdfLink };
export type PdfEngineRole = 'render' | 'writer';

/** The runtime owns immutable bytes and its range cache; engines never acquire files. */
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
    // Decoded BYTES, not pixels: packed monochrome scans must not get an RGBA-size refusal.
    maxDecodedImageBytes: 512 * 1024 * 1024,
    maxTileEdge: 2048, maxTileBytes: 2048 * 2048 * 4, maxHeapBytes: 1024 * 1024 * 1024,
});
export const WRITER_ENGINE_LIMITS: Readonly<EngineLimits> = Object.freeze({
    ...RENDER_ENGINE_LIMITS, maxHeapBytes: 3.5 * 1024 * 1024 * 1024,
});

export interface FontSpec { family: string; weight: number; italic: boolean; charset?: number }
export interface FontProvider {
    /** Cached bytes only. A miss reports font.needed; no backend may fetch or block on a promise. */
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
    /** The public length query may decode the entire stream; unknown until explicitly requested. */
    size: number | null;
    desc?: string;
    localVaultMarker?: string;
}
export interface DocInfo {
    pageCount: number;
    pages: PageGeometry[];
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
    /** A partial public-API inventory cannot establish absence, marker agreement or write authority. */
    attachmentInventory: 'full' | 'name-tree-params-only' | 'unknown';
    pdfVersion: number | null;
    /** Unknown is not clean: public engines may not expose whether recovery repaired the file. */
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

/** Superset of the text projector's floor, not a second extraction format. All arrays
 * own JS storage; no native pointer or WASM heap view may escape the backend. */
export interface RawPageText extends ProjectableRawPageText {
    /** 6*n complete page-space affines. matrix remains 4*n linear for the schema2 projector. */
    textMatrix: Float32Array;
    /** Indexed like fontNames; native metrics at source font size 1 (descent normally negative). */
    fontAscent: Float32Array;
    fontDescent: Float32Array;
    objects: ProjectableRawPageText['objects'] & {
        /** Native source text-object size, before its text matrix; indexed by object. */
        sourceFontSize: Float32Array;
        /** Effective solid-fill opacity [0,1]; fill is packed 0xRRGGBBAA. */
        opacity: Float32Array;
        /** 0 opaque, 1 transparent (including ancestors), 2 effective state unknown. */
        hasTransparency: Uint8Array;
        type3?: Uint8Array;
    };
    struct?: NonNullable<ProjectableRawPageText['struct']> & {
        actualText?: Array<[mcid: number, text: string]>;
    };
}

/** Integer device-page coordinates, not world points; rect excludes the sampling apron. */
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
    render(request: RenderRequest): RenderJob;
    text(index: number): RawPageText;
    links(index: number): RawPdfLink[];
    outline(limits: { maxDepth: number; maxNodes: number }): RawOutlineNode[];
    attachments(): PdfAttachmentInfo[];
    attachment(index: number, maxBytes: number): Uint8Array;
    openEmphasisClone?(): BackendDoc;
    /** Only a disposable clone may mutate objects. Ordinary documents throw NotSupported. */
    emphasisStroked?(request: RenderRequest, objectIndexes: Int32Array, strokeEm: number): RenderJob;
    releasePage(index: number): void;
    close(): void;
}
export interface PdfBackend {
    readonly id: string;
    init(env: BackendEnv): BackendInfo;
    open(source: ByteSource, options: { password?: string }): BackendDoc;
    heapBytes(): number;
}

export type PdfEngineErrorName = 'PasswordRequired' | 'UnsupportedSecurity' | 'InvalidPdf' | 'FileError'
    | 'PageError' | 'NotFoundError' | 'AbortError' | 'NotSupported' | 'RangeError' | 'ResourceLimit'
    | 'EngineBroken' | 'WorkerDied';
export class PdfEngineError extends Error {
    constructor(name: PdfEngineErrorName, message: string) { super(message); this.name = name; }
}
