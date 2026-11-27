import type { PageGeometry } from '../../platform/types';
import { PdfEngineError, PdfFontPendingError } from './types';
import type { BackendDoc, BackendEnv, BackendInfo, ByteSource, DocInfo, EngineLimits, PdfAttachmentInfo, PdfBackend, RenderJob, RenderRequest } from './types';
import { pdfiumAttachmentInventory, readPdfiumAttachment } from './pdfium/attachments';
import { pdfiumComplexity } from './pdfium/complexity';
import { createPdfiumFileAccess } from './pdfium/fileAccess';
import type { PdfiumFileAccess } from './pdfium/fileAccess';
import { installPdfiumFontBridge } from './pdfium/fontBridge';
import type { PdfiumFontBridge } from './pdfium/fontBridge.types';
import { createPdfiumForms } from './pdfium/forms';
import type { PdfiumForms } from './pdfium/forms';
import { pdfiumPageGeometry, pdfiumPageSize } from './pdfium/geometry';
import type { PdfiumPageSize } from './pdfium/geometry';
import { pdfiumLinks } from './pdfium/links';
import { pdfiumJbig2Regions } from './pdfium/imageRegions';
import { loadPdfiumModule } from './pdfium/loader';
import type { PdfiumLoadOptions, PdfiumRuntime } from './pdfium/loader';
import { heapView, readPdfiumUtf16, withPdfiumMemory, withPdfiumPassword } from './pdfium/memory';
import { pdfiumOutline } from './pdfium/outline';
import { createPdfiumRenderJob } from './pdfium/render';
import { pdfiumStructure } from './pdfium/structure';
import { extractPdfiumText } from './pdfium/text';

interface LoadedPage { handle: number; geometry: PageGeometry & { userUnit: 1 }; checked: boolean; languageChecked: boolean; footprint: number; pins: number; emphasisKey?: string }
const PAGE_WINDOW = 12, HEAVY_PAGE_BYTES = 64 * 1024 * 1024;
type OpenClone = (source: ByteSource, password: string | undefined, clone: boolean, language?: string) => PdfiumDocument;
class LanguageRestart extends Error { constructor(readonly language?: string) { super('Restart PDF with page language'); } }
const languageHints = new WeakMap<ByteSource, Map<number, string | null>>();
function hintsFor(source: ByteSource): Map<number, string | null> {
    let hints = languageHints.get(source);
    if (!hints) { hints = new Map(); languageHints.set(source, hints); }
    return hints;
}

function uniformPageLanguage(runtime: PdfiumRuntime, page: number, hasForms: boolean): string | undefined {
    if (hasForms || runtime.call('FPDFPage_GetAnnotCount', page) !== 0) return undefined;
    const count = runtime.call('FPDFPage_CountObjects', page), limit = 20_000;
    if (!Number.isSafeInteger(count) || count < 0 || count > limit) return undefined;
    for (let i = 0; i < count; i++) {
        const object = runtime.call('FPDFPage_GetObject', page, i) >>> 0;
        if (!object) return undefined;
        const type = runtime.call('FPDFPageObj_GetType', object);
        if (type <= 0 || type === 5) return undefined;
    }
    const tree = runtime.call('FPDF_StructTree_GetForPage', page) >>> 0;
    if (!tree) return undefined;
    try {
        const roots = runtime.call('FPDF_StructTree_CountChildren', tree);
        if (!Number.isSafeInteger(roots) || roots < 1 || roots > limit) return undefined;
        const stack: Array<{ element: number; parent?: string; depth: number }> = [], seen = new Set<number>();
        for (let i = 0; i < roots; i++) {
            const element = runtime.call('FPDF_StructTree_GetChildAtIndex', tree, i) >>> 0;
            if (!element) return undefined;
            stack.push({ element, depth: 0 });
        }
        let uniform: string | undefined, work = roots;
        while (stack.length) {
            const { element, parent, depth } = stack.pop()!;
            if (depth > 64 || seen.has(element) || seen.size >= limit) return undefined;
            seen.add(element);
            const size = runtime.call('FPDF_StructElement_GetLang', element, 0, 0) >>> 0;
            let own: string | undefined;
            if (size) {
                if (size % 2 || size > 130) return undefined;
                own = withPdfiumMemory(runtime, size, pointer => {
                    if ((runtime.call('FPDF_StructElement_GetLang', element, pointer, size) >>> 0) !== size) return undefined;
                    return readPdfiumUtf16(runtime, pointer, size);
                });
                if (!own || !/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i.test(own)) return undefined;
            }
            const language = (own ?? parent)?.toLowerCase();
            if (!language || uniform && uniform !== language) return undefined;
            uniform = language;
            const children = runtime.call('FPDF_StructElement_CountChildren', element);
            if (!Number.isSafeInteger(children) || children < 0 || children > limit - work) return undefined;
            work += children;
            for (let i = 0; i < children; i++) {
                const child = runtime.call('FPDF_StructElement_GetChildAtIndex', element, i) >>> 0;
                if (child) stack.push({ element: child, parent: language, depth: depth + 1 });
                else if (runtime.call('FPDF_StructElement_GetChildMarkedContentID', element, i) < 0) return undefined;
            }
        }
        return uniform;
    } finally { if (!runtime.aborted) runtime.call('FPDF_StructTree_Close', tree); }
}

function openFailure(runtime: PdfiumRuntime, access: PdfiumFileAccess): PdfEngineError {
    if (access.failed) return new PdfEngineError('FileError', 'PDF source read failed');
    const code = runtime.call('FPDF_GetLastError');
    if (code === 4) return new PdfEngineError('PasswordRequired', 'PDF password is required or incorrect');
    if (code === 5) return new PdfEngineError('UnsupportedSecurity', 'PDF security is unsupported');
    if (code === 2) return new PdfEngineError('FileError', 'PDF source could not be read');
    return new PdfEngineError('InvalidPdf', 'PDF document could not be opened');
}

class PdfiumDocument implements BackendDoc {
    private readonly pages = new Map<number, LoadedPage>();
    private readonly geometries = new Map<number, PageGeometry & { userUnit: 1 }>();
    private readonly jobs = new Set<RenderJob>();
    private readonly sizes: PdfiumPageSize[];
    private readonly documentInfo: DocInfo;
    private readonly forms: PdfiumForms;
    private closed = false;
    private current = -1;

    constructor(private readonly runtime: PdfiumRuntime, private readonly document: number,
        private readonly access: PdfiumFileAccess, private readonly limits: Readonly<EngineLimits>,
        private readonly source: ByteSource, private readonly secret: Uint8Array | undefined,
        private readonly clone: boolean, private readonly openClone: OpenClone, readonly language?: string) {
        const count = runtime.call('FPDF_GetPageCount', document);
        if (!Number.isSafeInteger(count) || count < 0 || count > limits.maxPages) throw new PdfEngineError('ResourceLimit', 'PDF page count exceeds its limit');
        this.sizes = Array.from({ length: count }, (_, index) => pdfiumPageSize(runtime, document, index, limits.maxPagePoints));
        const revision = runtime.call('FPDF_GetSecurityHandlerRevision', document);
        const signatures = runtime.call('FPDF_GetSignatureCount', document);
        if (!Number.isSafeInteger(signatures) || signatures < 0) throw new PdfEngineError('FileError', 'PDF signature inventory is unavailable');
        const type = runtime.call('FPDF_GetFormType', document);
        const formType = type === 0 ? 'none' : type === 1 ? 'acroform' : type === 2 ? 'xfa-full' : type === 3 ? 'xfa-foreground' : 'unknown';
        const version = withPdfiumMemory(runtime, 4, pointer => runtime.call('FPDF_GetFileVersion', document, pointer)
            ? heapView(runtime, pointer, 4).getInt32(0, true) : null);
        const attachments = this.inventory();
        const pages = this.sizes.map((size, index) => ({ index, ...size }));
        this.documentInfo = { pageCount: count, pages, encrypted: revision >= 0,
            permissions: runtime.call('FPDF_GetDocPermissions', document) >>> 0, signatureCount: signatures,
            tagged: runtime.call('FPDFCatalog_IsTagged', document) !== 0, hasForms: type !== 0,
            attachments, pdfVersion: version, repairStatus: 'unknown', formType,
            attachmentInventory: 'name-tree-params-only', javascript: 'unknown', actions: 'unknown' };
        this.forms = createPdfiumForms(runtime, document, index => this.pages.get(index)?.handle ?? 0,
            () => this.pages.get(this.current)?.handle ?? 0,
            handle => ([...this.pages.values()].find(page => page.handle === handle)?.geometry.rotate ?? 0) / 90);
        try { this.checkAccess(); } catch (error) { this.forms.close(); throw error; }
    }

    private ensure(): void {
        if (this.closed || this.runtime.aborted) throw new PdfEngineError('EngineBroken', 'PDF document is closed');
        this.checkAccess();
    }
    private checkAccess(): void {
        if (this.access.failed) throw new PdfEngineError('FileError', 'PDF source read failed');
    }
    private stopJobs(): void { for (const job of [...this.jobs]) job.abort(); }
    private account(page: LoadedPage, before: number): void {
        page.footprint += Math.max(0, this.runtime.HEAPU8.byteLength - before);
    }
    private trim(anchor: number): void {
        if (anchor < 0) return;
        for (const [index, page] of this.pages) {
            const distance = Math.abs(index - anchor);
            if (!page.pins && (distance > PAGE_WINDOW || page.footprint > HEAVY_PAGE_BYTES && distance > 1)) this.closePage(index, page);
        }
    }
    private closePage(index: number, page: LoadedPage): void {
        this.pages.delete(index);
        if (this.current === index) this.current = -1;
        if (!this.runtime.aborted) {
            try { this.runtime.call('FORM_OnBeforeClosePage', page.handle, this.forms.handle); } finally { this.runtime.call('FPDF_ClosePage', page.handle); }
        }
    }
    private destinationGeometry(index: number): PageGeometry & { userUnit: 1 } {
        return this.geometries.get(index) ?? this.load(index).geometry;
    }
    restartInfo(): { source: ByteSource; password?: string; clone: boolean } {
        return { source: this.source, password: this.secret ? new TextDecoder().decode(this.secret) : undefined, clone: this.clone };
    }
    private admitLanguage(index: number, page: LoadedPage): void {
        const hints = hintsFor(this.source);
        if (!hints.has(index)) {
            const language = uniformPageLanguage(this.runtime, page.handle, this.documentInfo.hasForms);
            this.checkAccess(); hints.set(index, language ?? null);
            while (hints.size > 256) hints.delete(hints.keys().next().value!);
        }
        const expected = hints.get(index) ?? undefined;
        if (expected !== this.language) throw new LanguageRestart(expected);
        page.languageChecked = true;
    }
    private load(index: number, checkLanguage = false): LoadedPage {
        this.ensure();
        if (!Number.isSafeInteger(index) || index < 0 || index >= this.sizes.length) throw new PdfEngineError('RangeError', 'Invalid PDF page index');
        const cached = this.pages.get(index);
        if (cached) { if (checkLanguage && !cached.languageChecked) this.admitLanguage(index, cached); this.current = index; this.trim(index); return cached; }
        const hints = hintsFor(this.source);
        if (checkLanguage && hints.has(index) && (hints.get(index) ?? undefined) !== this.language) throw new LanguageRestart(hints.get(index) ?? undefined);
        const before = this.runtime.HEAPU8.byteLength;
        const handle = this.runtime.call('FPDF_LoadPage', this.document, index) >>> 0;
        if (!handle) { this.checkAccess(); throw new PdfEngineError('PageError', 'PDF page could not be loaded'); }
        let attached = false;
        try {
            const geometry = pdfiumPageGeometry(this.runtime, handle, index, this.sizes[index]);
            const result: LoadedPage = { handle, geometry, checked: false, languageChecked: false, footprint: 0, pins: 0 };
            this.pages.set(index, result); this.current = index;
            attached = true;
            this.runtime.call('FORM_OnAfterLoadPage', handle, this.forms.handle);
            this.checkAccess();
            if (checkLanguage) this.admitLanguage(index, result);
            this.account(result, before);
            this.geometries.set(index, geometry);
            this.trim(index);
            return result;
        } catch (error) {
            this.pages.delete(index);
            if (!this.runtime.aborted) {
                if (attached) this.runtime.call('FORM_OnBeforeClosePage', handle, this.forms.handle);
                this.runtime.call('FPDF_ClosePage', handle);
            }
            throw error;
        }
    }
    private inventory(): PdfAttachmentInfo[] {
        return pdfiumAttachmentInventory(this.runtime, this.document).map(item => {
            const descMarker = item.description?.startsWith('local-vault-pdf/') ? item.description.split('\n', 1)[0] : undefined;
            // Filespec /Desc is the sole app role marker. Legacy /Params text
            // is foreign metadata, never a second source of edit authority.
            const marker = descMarker && descMarker.length <= 256 ? descMarker : undefined;
            return { index: item.index, name: item.name, size: null, ...(item.description ? { desc: item.description.slice(0, 1024) } : {}),
                ...(marker ? { localVaultMarker: marker } : {}) };
        });
    }
    info(): DocInfo { this.ensure(); return this.documentInfo; }
    pageCount(): number { this.ensure(); return this.sizes.length; }
    page(index: number): PageGeometry & { userUnit: 1 } { this.stopJobs(); return this.load(index).geometry; }
    complexity(index: number) {
        this.stopJobs(); const page = this.load(index, true), before = this.runtime.HEAPU8.byteLength;
        try { const value = pdfiumComplexity(this.runtime, page.handle, this.limits); page.checked = true; this.checkAccess(); return value; }
        finally { this.account(page, before); }
    }
    render(request: RenderRequest): RenderJob {
        this.stopJobs();
        const page = this.load(request.page, true);
        if (!page.checked) {
            const before = this.runtime.HEAPU8.byteLength;
            try { pdfiumComplexity(this.runtime, page.handle, this.limits); page.checked = true; }
            finally { this.account(page, before); }
        }
        this.checkAccess();
        const holder: { job?: RenderJob; pinned: boolean } = { pinned: true };
        page.pins++;
        const before = this.runtime.HEAPU8.byteLength;
        let native: RenderJob;
        try {
            native = createPdfiumRenderJob(this.runtime, page.handle, this.forms.handle, page.geometry, request, this.limits,
                () => {
                    if (holder.job) this.jobs.delete(holder.job);
                    if (holder.pinned) { holder.pinned = false; page.pins--; }
                    this.trim(this.current);
                });
        } catch (error) {
            if (holder.pinned) { holder.pinned = false; page.pins--; }
            throw error;
        } finally { this.account(page, before); }
        const job: RenderJob = {
            step: budget => {
                const before = this.runtime.HEAPU8.byteLength;
                try { const state = native.step(budget); this.checkAccess(); return state; }
                catch (error) { native.abort(); throw error; }
                finally { this.account(page, before); }
            },
            result: () => { this.checkAccess(); return native.result(); },
            abort: () => native.abort(),
        };
        holder.job = job;
        this.jobs.add(job);
        return job;
    }
    text(index: number) {
        this.stopJobs();
        const page = this.load(index, true), text = this.runtime.call('FPDFText_LoadPage', page.handle) >>> 0;
        if (!text) { this.checkAccess(); throw new PdfEngineError('PageError', 'PDF text page is unavailable'); }
        try {
            const result = extractPdfiumText(this.runtime, page.handle, text, page.geometry, this.limits).raw;
            const structure = pdfiumStructure(this.runtime, page.handle, page.geometry, this.documentInfo.tagged, this.limits);
            if (structure.struct) result.struct = structure.struct;
            if (structure.partial) result.truncated = true;
            this.checkAccess();
            return result;
        } finally { if (!this.runtime.aborted) this.runtime.call('FPDFText_ClosePage', text); }
    }
    openEmphasisClone(): BackendDoc {
        this.ensure();
        if (this.clone) throw new PdfEngineError('NotSupported', 'Cannot clone an emphasis document');
        const password = this.secret ? new TextDecoder().decode(this.secret) : undefined;
        return this.openClone(this.source, password, true, this.language);
    }
    emphasisStroked(request: RenderRequest, objectIndexes: Int32Array, strokeEm: number): RenderJob {
        if (!this.clone) throw new PdfEngineError('NotSupported', 'Only a disposable PDF clone may be changed');
        if (!(objectIndexes instanceof Int32Array) || objectIndexes.length > this.limits.maxTextObjects || strokeEm !== 0.035) {
            throw new PdfEngineError('RangeError', 'Invalid PDF emphasis request');
        }
        this.stopJobs();
        let page = this.load(request.page, true);
        const ids = [...objectIndexes];
        if (new Set(ids).size !== ids.length || ids.some(id => id < 0)) throw new PdfEngineError('RangeError', 'Invalid PDF emphasis object list');
        const key = `${strokeEm}:${ids.join(',')}`;
        if (page.emphasisKey !== undefined && page.emphasisKey !== key) {
            this.releasePage(request.page);
            page = this.load(request.page, true);
        }
        if (page.emphasisKey === undefined) {
            const text = this.runtime.call('FPDFText_LoadPage', page.handle) >>> 0;
            if (!text) throw new PdfEngineError('PageError', 'PDF emphasis text is unavailable');
            let complete = false;
            try {
                const extracted = extractPdfiumText(this.runtime, page.handle, text, page.geometry, this.limits);
                const { raw, objectHandles } = extracted;
                if (raw.truncated) throw new PdfEngineError('ResourceLimit', 'PDF emphasis text is incomplete');
                for (const id of ids) {
                    const size = raw.objects.sourceFontSize[id], fill = raw.objects.fill[id];
                    if (id >= objectHandles.length || raw.objects.renderMode[id] !== 0 || raw.objects.opacity[id] !== 1 ||
                        raw.objects.hasTransparency[id] !== 0 || !Number.isFinite(size) || size <= 0) {
                        throw new PdfEngineError('NotSupported', 'PDF emphasis object is not safely drawable');
                    }
                    const object = objectHandles[id];
                    if (!this.runtime.call('FPDFPageObj_SetStrokeColor', object, fill >>> 24, (fill >>> 16) & 255, (fill >>> 8) & 255, fill & 255) ||
                        !this.runtime.call('FPDFPageObj_SetStrokeWidth', object, size * strokeEm) ||
                        !this.runtime.call('FPDFTextObj_SetTextRenderMode', object, 2)) {
                        throw new PdfEngineError('PageError', 'PDF emphasis configuration failed');
                    }
                }
                this.checkAccess();
                page.emphasisKey = key;
                complete = true;
            } finally {
                try { if (!this.runtime.aborted) this.runtime.call('FPDFText_ClosePage', text); }
                finally { if (!complete) this.releasePage(request.page); }
            }
        }
        return this.render(request);
    }
    imageRegions(index: number) {
        this.stopJobs();
        const page = this.load(index, true);
        const result = pdfiumJbig2Regions(this.runtime, page.handle, page.geometry, this.limits);
        this.checkAccess();
        return result;
    }
    links(index: number) {
        this.stopJobs(); const page = this.load(index);
        page.pins++;
        try {
            const result = pdfiumLinks(this.runtime, this.document, page.handle, page.geometry, this.sizes.length,
                target => this.destinationGeometry(target), this.limits);
            this.checkAccess(); return result;
        } finally { page.pins--; this.current = index; this.trim(index); }
    }
    outline(limits: { maxDepth: number; maxNodes: number }) {
        this.stopJobs(); this.ensure();
        const anchor = this.current;
        try {
            const result = pdfiumOutline(this.runtime, this.document, this.sizes.length, index => this.destinationGeometry(index), limits);
            this.checkAccess(); return result;
        } finally { if (anchor >= 0 && this.pages.has(anchor)) this.current = anchor; this.trim(this.current); }
    }
    attachments(): PdfAttachmentInfo[] { this.stopJobs(); this.ensure(); const result = this.inventory(); this.checkAccess(); return result; }
    attachment(index: number, maxBytes: number): Uint8Array { this.stopJobs(); this.ensure(); const result = readPdfiumAttachment(this.runtime, this.document, index, maxBytes); this.checkAccess(); return result; }
    residentPages(): number { return this.pages.size; }
    releasePage(index: number): void {
        this.stopJobs();
        const page = this.pages.get(index);
        if (page && !page.pins) this.closePage(index, page);
    }
    close(): void {
        if (this.closed) return;
        this.closed = true;
        try { this.stopJobs(); } catch { /* teardown continues */ }
        for (const index of [...this.pages.keys()]) { try { this.releasePage(index); } catch { /* teardown continues */ } }
        try { this.forms.close(); } catch { /* teardown continues */ }
        if (!this.runtime.aborted) { try { this.runtime.call('FPDF_CloseDocument', this.document); } catch { /* teardown continues */ } }
        try { this.access.dispose(); } catch { /* teardown continues */ }
        this.secret?.fill(0);
    }
}

export async function loadPdfiumBackend(options: PdfiumLoadOptions): Promise<PdfBackend> {
    const runtime = await loadPdfiumModule(options);
    let environment: BackendEnv | undefined, bridge: PdfiumFontBridge | undefined, closed = false;
    const documents = new Set<BackendDoc>();
    // A font callback can occur in any synchronous native call, including a
    // progressive-render step. Never publish its provisional result.
    const scoped = <T,>(run: () => T, discard?: (result: T | undefined) => void, language?: string): T => {
        if (closed || !bridge) throw new PdfEngineError('EngineBroken', 'PDF backend is closed');
        bridge.begin(language);
        let result: T | undefined, error: unknown, failed = false;
        try { result = run(); } catch (cause) { failed = true; error = cause; }
        const status = bridge.end();
        if (status.failure || status.missing.length) {
            try { discard?.(result); } catch { /* preserve the font error */ }
            if (status.failure) throw status.failure;
            throw new PdfFontPendingError(status.missing);
        }
        if (failed) throw error;
        return result as T;
    };
    const wrap = (initial: PdfiumDocument): BackendDoc => {
        let doc = initial;
        documents.add(doc);
        const discard = () => { documents.delete(doc); doc.close(); };
        return new Proxy(initial, {
            get(_target, property) {
                if (property === 'close') return discard;
                const value: unknown = Reflect.get(doc, property, doc);
                if (typeof value !== 'function') return value;
                return (...args: unknown[]) => {
                    let result: unknown;
                    for (let attempt = 0; ; attempt++) {
                        try {
                            const current = doc, method: unknown = Reflect.get(current, property, current);
                            if (typeof method !== 'function') throw new PdfEngineError('EngineBroken', 'PDF operation is unavailable');
                            result = scoped(() => Reflect.apply(method, current, args) as unknown, provisional => {
                                if (property === 'openEmphasisClone' && provisional) {
                                    try { (provisional as BackendDoc).close(); } catch { /* discard both native documents */ }
                                }
                                discard();
                            }, current.language);
                            break;
                        } catch (error) {
                            if (!(error instanceof LanguageRestart) || attempt >= 2) throw error;
                            const info = doc.restartInfo();
                            discard();
                            doc = scoped(() => openDocument(info.source, info.password, info.clone, error.language), value => value?.close(), error.language);
                            documents.add(doc);
                        }
                    }
                    if (property === 'openEmphasisClone') return wrap(result as PdfiumDocument);
                    if (property !== 'render' && property !== 'emphasisStroked') return result;
                    const job = result as RenderJob, language = doc.language;
                    return {
                        step: (budget: number) => scoped(() => job.step(budget), discard, language),
                        result: () => scoped(() => job.result(), discard, language),
                        abort: () => job.abort(),
                    } satisfies RenderJob;
                };
            },
        });
    };
    const info: BackendInfo = { engine: 'pdfium', version: '6688c576fd851f4159c6fae39396da50939de110',
        artifactSha256: runtime.artifactSha256, buildId: runtime.buildId,
        features: ['forms', 'emphasis', 'structTree', 'outline', 'attachments'] };
    const openDocument = (source: ByteSource, password: string | undefined, clone: boolean, language?: string): PdfiumDocument => {
        if (!environment) throw new PdfEngineError('EngineBroken', 'PDFium backend is not initialized');
        const access = createPdfiumFileAccess(runtime, source);
        let document = 0, secret: Uint8Array | undefined;
        try {
            document = withPdfiumPassword(runtime, password,
                pointer => runtime.call('FPDF_LoadCustomDocument', access.pointer, pointer) >>> 0);
            if (!document) throw openFailure(runtime, access);
            if (access.failed) throw new PdfEngineError('FileError', 'PDF source read failed');
            secret = password === undefined ? undefined : new TextEncoder().encode(password);
            return new PdfiumDocument(runtime, document, access, environment.limits, source, secret, clone, openDocument, language);
        } catch (error) {
            secret?.fill(0);
            if (document && !runtime.aborted) { try { runtime.call('FPDF_CloseDocument', document); } catch { /* worker unusable */ } }
            access.dispose();
            throw error;
        }
    };
    return {
        id: 'pdfium',
        init(env) {
            if (environment || closed) throw new PdfEngineError('EngineBroken', 'PDFium backend is already initialized or closed');
            try {
                withPdfiumMemory(runtime, runtime.abi.structs.libraryConfig.size, pointer => {
                    heapView(runtime, pointer, runtime.abi.structs.libraryConfig.size).setInt32(runtime.abi.structs.libraryConfig.offsets.version, 2, true);
                    runtime.initLibrary(pointer);
                });
                bridge = installPdfiumFontBridge(runtime, env.fonts);
                environment = env;
                return info;
            } catch (error) { closed = true; runtime.dispose(); throw error; }
        },
        open(source: ByteSource, openOptions: { password?: string }) {
            return wrap(scoped(() => openDocument(source, openOptions.password, false), doc => doc?.close()));
        },
        heapBytes() { return closed ? 0 : runtime.HEAPU8.byteLength; },
        close() {
            if (closed) return;
            for (const doc of documents) { try { doc.close(); } catch { /* continue teardown */ } }
            documents.clear();
            try { bridge?.close(); } finally { closed = true; runtime.dispose(); }
        },
    };
}
