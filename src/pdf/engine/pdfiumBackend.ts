import type { PageGeometry } from '../../platform/types';
import { PdfEngineError } from './types';
import type { BackendDoc, BackendEnv, BackendInfo, ByteSource, DocInfo, EngineLimits, PdfAttachmentInfo, PdfBackend, RenderJob, RenderRequest } from './types';
import { pdfiumAttachmentInventory, readPdfiumAttachment } from './pdfium/attachments';
import { pdfiumComplexity } from './pdfium/complexity';
import { createPdfiumFileAccess } from './pdfium/fileAccess';
import type { PdfiumFileAccess } from './pdfium/fileAccess';
import { createPdfiumForms } from './pdfium/forms';
import type { PdfiumForms } from './pdfium/forms';
import { pdfiumPageGeometry, pdfiumPageSize } from './pdfium/geometry';
import type { PdfiumPageSize } from './pdfium/geometry';
import { pdfiumLinks } from './pdfium/links';
import { loadPdfiumModule } from './pdfium/loader';
import type { PdfiumLoadOptions, PdfiumRuntime } from './pdfium/loader';
import { heapView, withPdfiumMemory, withPdfiumPassword } from './pdfium/memory';
import { pdfiumOutline } from './pdfium/outline';
import { createPdfiumRenderJob } from './pdfium/render';
import { pdfiumStructure } from './pdfium/structure';
import { extractPdfiumText } from './pdfium/text';

interface LoadedPage { handle: number; geometry: PageGeometry & { userUnit: 1 }; checked: boolean; emphasisKey?: string }
type OpenClone = (source: ByteSource, password: string | undefined) => PdfiumDocument;

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
    private readonly jobs = new Set<RenderJob>();
    private readonly sizes: PdfiumPageSize[];
    private readonly documentInfo: DocInfo;
    private readonly forms: PdfiumForms;
    private closed = false;
    private current = -1;

    constructor(private readonly runtime: PdfiumRuntime, private readonly document: number,
        private readonly access: PdfiumFileAccess, private readonly limits: Readonly<EngineLimits>,
        private readonly source: ByteSource, private readonly secret: Uint8Array | undefined,
        private readonly clone: boolean, private readonly openClone: OpenClone) {
        const count = runtime.call('FPDF_GetPageCount', document);
        if (!Number.isSafeInteger(count) || count < 0 || count > limits.maxPages) throw new PdfEngineError('ResourceLimit', 'PDF page count exceeds its limit');
        this.sizes = Array.from({ length: count }, (_, index) => pdfiumPageSize(runtime, document, index, limits.maxPagePoints));
        const revision = runtime.call('FPDF_GetSecurityHandlerRevision', document);
        const signatures = runtime.call('FPDF_GetSignatureCount', document);
        if (!Number.isSafeInteger(signatures) || signatures < 0) throw new PdfEngineError('FileError', 'PDF signature inventory is unavailable');
        const type = runtime.call('FPDF_GetFormType', document);
        const formType = type === 0 ? 'none' : type === 1 ? 'acroform' : type === 2 || type === 3 ? 'xfa' : 'unknown';
        const version = withPdfiumMemory(runtime, 4, pointer => runtime.call('FPDF_GetFileVersion', document, pointer)
            ? heapView(runtime, pointer, 4).getInt32(0, true) : null);
        const attachments = this.inventory();
        // Index-only extents deliberately omit rotation and transforms. Exact
        // geometry comes from page(), never an invented affine on doc.open.
        const pages = this.sizes.map((size, index) => ({ index, ...size })) as unknown as PageGeometry[];
        this.documentInfo = { pageCount: count, pages, encrypted: revision >= 0,
            permissions: runtime.call('FPDF_GetDocPermissions', document) >>> 0, signatureCount: signatures,
            tagged: runtime.call('FPDFCatalog_IsTagged', document) !== 0, hasForms: type !== 0,
            attachments, pdfVersion: version, repairStatus: 'unknown', formType,
            attachmentInventory: 'name-tree-params-only', javascript: 'unknown', actions: 'unknown' } as DocInfo;
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
    private load(index: number): LoadedPage {
        this.ensure();
        if (!Number.isSafeInteger(index) || index < 0 || index >= this.sizes.length) throw new PdfEngineError('RangeError', 'Invalid PDF page index');
        const cached = this.pages.get(index);
        if (cached) { this.current = index; return cached; }
        const handle = this.runtime.call('FPDF_LoadPage', this.document, index) >>> 0;
        if (!handle) { this.checkAccess(); throw new PdfEngineError('PageError', 'PDF page could not be loaded'); }
        let attached = false;
        try {
            const geometry = pdfiumPageGeometry(this.runtime, handle, index, this.sizes[index]);
            const result: LoadedPage = { handle, geometry, checked: false };
            this.pages.set(index, result); this.current = index;
            attached = true;
            this.runtime.call('FORM_OnAfterLoadPage', handle, this.forms.handle);
            this.checkAccess();
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
            const marker = descMarker && item.paramsMarker && descMarker !== item.paramsMarker ? undefined : descMarker ?? item.paramsMarker;
            return { index: item.index, name: item.name, size: null, ...(item.description ? { desc: item.description } : {}),
                ...(marker ? { localVaultMarker: marker } : {}) } as unknown as PdfAttachmentInfo;
        });
    }
    info(): DocInfo { this.ensure(); return this.documentInfo; }
    pageCount(): number { this.ensure(); return this.sizes.length; }
    page(index: number): PageGeometry & { userUnit: 1 } { this.stopJobs(); return this.load(index).geometry; }
    complexity(index: number) { this.stopJobs(); const page = this.load(index); const value = pdfiumComplexity(this.runtime, page.handle, this.limits); page.checked = true; this.checkAccess(); return value; }
    render(request: RenderRequest): RenderJob {
        this.stopJobs();
        const page = this.load(request.page);
        if (!page.checked) { pdfiumComplexity(this.runtime, page.handle, this.limits); page.checked = true; }
        this.checkAccess();
        const holder: { job?: RenderJob } = {};
        const job = createPdfiumRenderJob(this.runtime, page.handle, this.forms.handle, page.geometry, request, this.limits,
            () => { if (holder.job) this.jobs.delete(holder.job); });
        holder.job = job;
        this.jobs.add(job);
        return job;
    }
    text(index: number) {
        this.stopJobs();
        const page = this.load(index), text = this.runtime.call('FPDFText_LoadPage', page.handle) >>> 0;
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
        return this.openClone(this.source, password);
    }
    emphasisStroked(request: RenderRequest, objectIndexes: Int32Array, strokeEm: number): RenderJob {
        if (!this.clone) throw new PdfEngineError('NotSupported', 'Only a disposable PDF clone may be changed');
        if (!(objectIndexes instanceof Int32Array) || objectIndexes.length > this.limits.maxTextObjects || strokeEm !== 0.035) {
            throw new PdfEngineError('RangeError', 'Invalid PDF emphasis request');
        }
        this.stopJobs();
        let page = this.load(request.page);
        const ids = [...objectIndexes];
        if (new Set(ids).size !== ids.length || ids.some(id => id < 0)) throw new PdfEngineError('RangeError', 'Invalid PDF emphasis object list');
        const key = `${strokeEm}:${ids.join(',')}`;
        if (page.emphasisKey !== undefined && page.emphasisKey !== key) {
            this.releasePage(request.page);
            page = this.load(request.page);
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
    links(index: number) {
        this.stopJobs(); const page = this.load(index);
        const result = pdfiumLinks(this.runtime, this.document, page.handle, page.geometry, this.sizes.length,
            target => this.load(target).geometry, this.limits);
        this.checkAccess(); return result;
    }
    outline(limits: { maxDepth: number; maxNodes: number }) {
        this.stopJobs(); this.ensure();
        const result = pdfiumOutline(this.runtime, this.document, this.sizes.length, index => this.load(index).geometry, limits);
        this.checkAccess(); return result;
    }
    attachments(): PdfAttachmentInfo[] { this.stopJobs(); this.ensure(); const result = this.inventory(); this.checkAccess(); return result; }
    attachment(index: number, maxBytes: number): Uint8Array { this.stopJobs(); this.ensure(); const result = readPdfiumAttachment(this.runtime, this.document, index, maxBytes); this.checkAccess(); return result; }
    releasePage(index: number): void {
        this.stopJobs();
        const page = this.pages.get(index);
        if (!page) return;
        this.pages.delete(index);
        if (this.current === index) this.current = -1;
        if (!this.runtime.aborted) {
            try { this.runtime.call('FORM_OnBeforeClosePage', page.handle, this.forms.handle); } finally { this.runtime.call('FPDF_ClosePage', page.handle); }
        }
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

/** The compiled module and all native handles stay inside the opaque worker. */
export async function loadPdfiumBackend(options: PdfiumLoadOptions): Promise<PdfBackend> {
    const runtime = await loadPdfiumModule(options);
    let environment: BackendEnv | undefined;
    const info: BackendInfo = { engine: 'pdfium', version: '6688c576fd851f4159c6fae39396da50939de110',
        artifactSha256: runtime.artifactSha256, buildId: runtime.buildId,
        features: ['forms', 'emphasis', 'structTree', 'outline', 'attachments'] };
    const openDocument = (source: ByteSource, password: string | undefined, clone: boolean): PdfiumDocument => {
        if (!environment) throw new PdfEngineError('EngineBroken', 'PDFium backend is not initialized');
        const access = createPdfiumFileAccess(runtime, source);
        let document = 0, secret: Uint8Array | undefined;
        try {
            document = withPdfiumPassword(runtime, password,
                pointer => runtime.call('FPDF_LoadCustomDocument', access.pointer, pointer) >>> 0);
            if (!document) throw openFailure(runtime, access);
            if (access.failed) throw new PdfEngineError('FileError', 'PDF source read failed');
            secret = password === undefined ? undefined : new TextEncoder().encode(password);
            return new PdfiumDocument(runtime, document, access, environment.limits, source, secret, clone,
                (cloneSource, clonePassword) => openDocument(cloneSource, clonePassword, true));
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
            if (environment) throw new PdfEngineError('EngineBroken', 'PDFium backend is already initialized');
            withPdfiumMemory(runtime, runtime.abi.structs.libraryConfig.size, pointer => {
                heapView(runtime, pointer, runtime.abi.structs.libraryConfig.size).setInt32(runtime.abi.structs.libraryConfig.offsets.version, 2, true);
                runtime.initLibrary(pointer);
            });
            environment = env;
            return info;
        },
        open(source: ByteSource, openOptions: { password?: string }) { return openDocument(source, openOptions.password, false); },
        heapBytes() { return runtime.HEAPU8.byteLength; },
    };
}
