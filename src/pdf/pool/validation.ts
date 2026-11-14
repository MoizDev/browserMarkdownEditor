import type { Affine, PageGeometry } from '../../platform/types';
import { RENDER_ENGINE_LIMITS } from '../engine/types';
import type { DocInfo, EngineLimits, PdfAttachmentInfo, RawOutlineNode } from '../engine/types';
import type { PdfLinkDestination, PdfLinkPoint, PdfLinkView, RawPdfLink } from '../pdfLinkModel';
import { safePdfUri } from '../pdfUriPolicy';
import type { PageTileArgs, PageTileResult } from '../worker/protocol';
import type { PdfReplyValidators } from './validation.types';
import { boolean, finite, integer, invalidPdfReply, record, text } from './validationCommon';

const FILE_MAX = 0x7fffffff;
const views: Record<PdfLinkView, number> = { XYZ: 2, Fit: 0, FitH: 1, FitV: 1, FitR: 4, FitB: 0, FitBH: 1, FitBV: 1 };
function array(value: unknown, max: number): unknown[] {
    if (!Array.isArray(value) || value.length > max) invalidPdfReply();
    return value;
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
    if (typeof value !== 'string' || !choices.includes(value as T)) invalidPdfReply();
    return value as T;
}
function bytes(value: unknown, max: number): ArrayBuffer {
    if (!(value instanceof ArrayBuffer) || value.byteLength > max) invalidPdfReply();
    // A transferred, non-shared buffer is already host-owned; rebuilding the
    // surrounding records does not require a second tile-sized allocation.
    return value;
}
function destination(value: unknown, pageCount: number, bound: number): PdfLinkDestination | undefined {
    const o = record(value, ['page', 'view', 'params', 'zoom']);
    if (!Number.isSafeInteger(o.page) || (o.page as number) < 0 || (o.page as number) >= pageCount) return undefined;
    const page = o.page as number;
    const fallback: PdfLinkDestination = { page, view: 'XYZ', params: [] };
    if (typeof o.view !== 'string' || !Object.hasOwn(views, o.view)) return fallback;
    const view = o.view as PdfLinkView;
    if (!Array.isArray(o.params) || o.params.length !== views[view] ||
        o.params.some((n: unknown) => typeof n !== 'number' || !Number.isFinite(n))) return fallback;
    const params = o.params.map((n: number) => Math.max(-bound, Math.min(bound, n)));
    if (view === 'FitR' && (params[0] === params[2] || params[1] === params[3])) return fallback;
    if (o.zoom !== undefined && (typeof o.zoom !== 'number' || !Number.isFinite(o.zoom) || o.zoom <= 0 || o.zoom > bound)) return fallback;
    return { page, view, params, ...(view === 'XYZ' && o.zoom !== undefined ? { zoom: o.zoom as number } : {}) };
}

export function createPdfReplyValidators(limits: Readonly<EngineLimits> = RENDER_ENGINE_LIMITS): PdfReplyValidators {
    const attachments = (value: unknown): PdfAttachmentInfo[] => {
        const seen = new Set<number>();
        return array(value, 10_000).map(item => {
            const o = record(item, ['index', 'name', 'size', 'desc', 'localVaultMarker']);
            const index = integer(o.index, 0, FILE_MAX);
            if (seen.has(index)) invalidPdfReply();
            seen.add(index);
            return { index, name: text(o.name, 1024), size: o.size === null ? null : integer(o.size, 0, FILE_MAX),
                ...(o.desc !== undefined ? { desc: text(o.desc, 1024) } : {}),
                ...(o.localVaultMarker !== undefined ? { localVaultMarker: text(o.localVaultMarker, 1024) } : {}) };
        });
    };
    const geometry = (value: unknown, expectedPage: number): PageGeometry => {
        const o = record(value, ['index', 'width', 'height', 'rotate', 'userUnit', 'toUserSpace']);
        const index = integer(o.index, 0, limits.maxPages - 1);
        if (index !== expectedPage) invalidPdfReply();
        const width = finite(o.width, 1, limits.maxPagePoints), height = finite(o.height, 1, limits.maxPagePoints);
        const rotate = integer(o.rotate, 0, 270);
        if (rotate !== 0 && rotate !== 90 && rotate !== 180 && rotate !== 270) invalidPdfReply();
        const userUnit = finite(o.userUnit, 1, 1);
        const a = array(o.toUserSpace, 6);
        if (a.length !== 6) invalidPdfReply();
        const matrix = a.map(n => finite(n, -1e7, 1e7)) as unknown as Affine;
        if (Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2]) < 1e-12) invalidPdfReply();
        for (const x of [0, width]) for (const y of [0, height]) {
            finite(matrix[0] * x + matrix[2] * y + matrix[4], -1e8, 1e8);
            finite(matrix[1] * x + matrix[3] * y + matrix[5], -1e8, 1e8);
        }
        return { index, width, height, rotate, userUnit, toUserSpace: matrix };
    };
    const document = (value: unknown): DocInfo => {
        const o = record(value, ['pageCount', 'pages', 'encrypted', 'permissions', 'signatureCount', 'tagged', 'hasForms', 'formType', 'javascript', 'actions', 'attachments', 'attachmentInventory', 'pdfVersion', 'repairStatus']);
        const pageCount = integer(o.pageCount, 0, limits.maxPages);
        const pages = array(o.pages, limits.maxPages);
        if (pages.length !== pageCount) invalidPdfReply();
        return { pageCount, pages: pages.map((item, index) => {
            const p = record(item, ['index', 'width', 'height']);
            if (integer(p.index, 0, limits.maxPages - 1) !== index) invalidPdfReply();
            return { index, width: finite(p.width, 1, limits.maxPagePoints), height: finite(p.height, 1, limits.maxPagePoints) };
        }), encrypted: boolean(o.encrypted), permissions: o.permissions === null ? null : integer(o.permissions, 0, 0xffffffff),
        signatureCount: integer(o.signatureCount, 0, FILE_MAX), tagged: boolean(o.tagged), hasForms: boolean(o.hasForms),
        formType: choice(o.formType, ['none', 'acroform', 'xfa-full', 'xfa-foreground', 'unknown']),
        javascript: choice(o.javascript, ['present', 'absent', 'unknown']), actions: choice(o.actions, ['present', 'absent', 'unknown']),
        attachments: attachments(o.attachments), attachmentInventory: choice(o.attachmentInventory, ['full', 'name-tree-params-only', 'unknown']),
        pdfVersion: o.pdfVersion === null ? null : integer(o.pdfVersion, 0, FILE_MAX), repairStatus: choice(o.repairStatus, ['clean', 'repaired', 'unknown']) };
    };
    const tile = (value: unknown, expected: PageTileArgs): PageTileResult => {
        const o = record(value, ['docKey', 'page', 'reqId', 'scale', 'rect', 'profileKey', 'annotations', 'forms', 'variant', 'emphasis', 'pixels', 'w', 'h', 'heapBytes', 'ms', 'emphasisResult']);
        for (const key of ['docKey', 'page', 'reqId', 'scale', 'profileKey', 'annotations', 'forms', 'variant'] as const) if (o[key] !== expected[key]) invalidPdfReply();
        finite(o.scale, Number.MIN_VALUE, 1e6);
        const r = record(o.rect, ['x', 'y', 'w', 'h']);
        for (const key of ['x', 'y', 'w', 'h'] as const) if (integer(r[key], key === 'x' || key === 'y' ? -FILE_MAX : 1, FILE_MAX) !== expected.rect[key]) invalidPdfReply();
        if (expected.variant === 'emphasis') {
            const e = record(o.emphasis, ['algorithm', 'revision', 'strokeEm', 'locale']);
            for (const key of ['algorithm', 'revision', 'strokeEm', 'locale'] as const) if (e[key] !== expected.emphasis[key]) invalidPdfReply();
        } else if (o.emphasis !== undefined) invalidPdfReply();
        const w = integer(o.w, 1, limits.maxTileEdge), h = integer(o.h, 1, limits.maxTileEdge);
        const size = w * h * 4;
        if (w !== expected.rect.w + 2 || h !== expected.rect.h + 2 || !Number.isSafeInteger(size) || size > limits.maxTileBytes) invalidPdfReply();
        const pixels = bytes(o.pixels, size);
        if (pixels.byteLength !== size) invalidPdfReply();
        const data = new Uint8Array(pixels);
        for (let i = 3; i < size; i += 4) if (data[i] !== 255) invalidPdfReply();
        const ms = record(o.ms, ['load', 'render', 'copy']);
        let emphasisResult: PageTileResult['emphasisResult'];
        if (o.emphasisResult !== undefined) {
            if (expected.variant !== 'emphasis') invalidPdfReply();
            const e = record(o.emphasisResult, ['eligibleGlyphs', 'changedPixels']);
            emphasisResult = { eligibleGlyphs: integer(e.eligibleGlyphs, 0, limits.maxChars), changedPixels: integer(e.changedPixels, 0, w * h) };
        } else if (expected.variant === 'emphasis') invalidPdfReply();
        return { ...expected, rect: { ...expected.rect }, ...(expected.variant === 'emphasis' ? { emphasis: { ...expected.emphasis } } : {}), pixels, w, h,
            heapBytes: integer(o.heapBytes, 0, limits.maxHeapBytes), ms: { load: finite(ms.load, 0, 120_000), render: finite(ms.render, 0, 120_000), copy: finite(ms.copy, 0, 120_000) }, ...(emphasisResult ? { emphasisResult } : {}) } as PageTileResult;
    };
    const links = (value: unknown, page: Readonly<PageGeometry>, pageCount: number): RawPdfLink[] => {
        integer(pageCount, 0, limits.maxPages);
        let quadsTotal = 0;
        const bound = limits.maxPagePoints * 100;
        const point = (value: unknown): PdfLinkPoint => { const p = record(value, ['x', 'y']); return { x: finite(p.x, -bound, bound), y: finite(p.y, -bound, bound) }; };
        return array(value, limits.maxLinks).map(item => {
            const o = record(item, ['rect', 'quads', 'uri', 'dest', 'action', 'name']);
            const r = record(o.rect, ['x', 'y', 'width', 'height']);
            const x = finite(r.x, -bound, bound), y = finite(r.y, -bound, bound), width = finite(r.width, 0, bound), height = finite(r.height, 0, bound);
            const x0 = Math.max(0, Math.min(page.width, x)), y0 = Math.max(0, Math.min(page.height, y));
            const x1 = Math.max(0, Math.min(page.width, x + width)), y1 = Math.max(0, Math.min(page.height, y + height));
            const rect = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
            const action = choice(o.action, ['uri', 'goto', 'remote', 'launch', 'named', 'other']);
            let quads: Array<[PdfLinkPoint, PdfLinkPoint, PdfLinkPoint, PdfLinkPoint]> | undefined;
            if (o.quads !== undefined) {
                const source = array(o.quads, 256); quadsTotal += source.length;
                if (quadsTotal > 20_000) invalidPdfReply();
                quads = source.map(q => { const a = array(q, 4); if (a.length !== 4) invalidPdfReply(); return [point(a[0]), point(a[1]), point(a[2]), point(a[3])]; });
            }
            let uri: string | Uint8Array | undefined;
            if (o.uri !== undefined) {
                if (typeof o.uri === 'string') { if (new TextEncoder().encode(o.uri).length > limits.maxUriBytes) invalidPdfReply(); uri = o.uri; }
                else if (o.uri instanceof Uint8Array && o.uri.byteLength <= limits.maxUriBytes) uri = new Uint8Array(o.uri);
                else invalidPdfReply();
            }
            const safeUri = uri === undefined ? null : safePdfUri(uri);
            const dest = o.dest === undefined ? undefined : destination(o.dest, pageCount, bound);
            return { rect, action, ...(quads ? { quads } : {}), ...(safeUri !== null ? { uri: safeUri } : {}), ...(dest ? { dest } : {}), ...(o.name !== undefined ? { name: text(o.name, 1024) } : {}) };
        });
    };
    const outline = (value: unknown, pageCount: number): RawOutlineNode[] => {
        integer(pageCount, 0, limits.maxPages);
        const result: RawOutlineNode[] = [], seen = new Set<object>();
        const stack = [{ items: array(value, limits.maxOutlineNodes), target: result, depth: 1 }];
        let count = 0;
        while (stack.length) {
            const { items, target, depth } = stack.pop()!;
            if (depth > limits.maxOutlineDepth && items.length) invalidPdfReply();
            for (const item of items) {
                if (++count > limits.maxOutlineNodes || !item || typeof item !== 'object' || seen.has(item)) invalidPdfReply();
                seen.add(item);
                const o = record(item, ['title', 'dest', 'children']);
                const dest = o.dest === undefined ? undefined : destination(o.dest, pageCount, limits.maxPagePoints * 100);
                const node: RawOutlineNode = { title: text(o.title, 1024), children: [], ...(dest ? { dest } : {}) };
                target.push(node);
                stack.push({ items: array(o.children, limits.maxOutlineNodes), target: node.children, depth: depth + 1 });
            }
        }
        return result;
    };
    return { document, geometry, tile, links, outline, attachments, attachmentBytes: (value, maxBytes) => bytes(value, integer(maxBytes, 0, FILE_MAX)) };
}
