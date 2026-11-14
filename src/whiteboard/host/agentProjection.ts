import type { CanvasOp } from '../../../shared/vaultAgentProtocol';
import { createBoardAgentAdapter, type AgentAdapterHost } from '../agent/adapter';
import { summarizeAgentNode, type AgentGeometry, type ShapePage, type ShapeQuery, type ShapeSummary } from '../agent/shapes';
import { childrenOf, type BoardDoc, type BoardKind, type Sheet } from '../model/doc';
import type { SampleStore } from '../ink/samples';
import type { PngCapture } from '../export/capturePng';
import type { BoardSession } from '../session/BoardSession';
import type { SheetId } from '../model/ids';
import type { Node } from '../model/nodes';
import { EMPTY_RICH_TEXT, type RichText } from '../text/richText';
import type { DrawingViewInfo, NotebookViewInfo, PdfViewInfo } from '../../utils/viewRegistry';
import { acquireNativeBoard } from './nativeAcquisition';
import type { AgentApplyResult } from '../agent/transaction';
import type { JobAuthority, JobOptions } from '../security/admission';

function yieldAgentWork(): Promise<void> {
    const scheduler = (globalThis as typeof globalThis & { scheduler?: { yield?: () => Promise<void> } }).scheduler;
    return scheduler?.yield ? scheduler.yield() : new Promise(resolve => setTimeout(resolve, 0));
}

async function boundedSummary(node: Node, geometry: AgentGeometry, page: number | undefined, guard: () => void): Promise<ShapeSummary> {
    const text: RichText | null = node.kind === 'text' || node.kind === 'sticky' ? node.text
        : node.kind === 'figure' || node.kind === 'connector' ? node.label : null;
    if (!text) return summarizeAgentNode(node, geometry, page);
    const pieces: string[] = [];
    let length = 0, work = 0;
    for (let b = 0; b < text.blocks.length && length < 2001; b++) {
        if (b) { pieces.push('\n'); length++; }
        for (const run of text.blocks[b].runs) {
            if ((++work & 255) === 0) { guard(); await yieldAgentWork(); guard(); }
            if (length >= 2001) break;
            const part = run.text.slice(0, 2001 - length);
            if (part) { pieces.push(part); length += part.length; }
        }
    }
    const lean = node.kind === 'text' || node.kind === 'sticky' ? { ...node, text: EMPTY_RICH_TEXT }
        : node.kind === 'figure' || node.kind === 'connector' ? { ...node, label: EMPTY_RICH_TEXT } : node;
    const summary = summarizeAgentNode(lean, geometry, page), plain = pieces.join('');
    summary.text = plain.length > 2000 ? `${plain.slice(0, 2000)}…` : plain;
    return summary;
}

async function listPinnedShapes(doc: BoardDoc, sheets: readonly Sheet[], geometry: AgentGeometry, query: ShapeQuery,
    revision: number, labelled: boolean, guard: () => void, include?: (node: Node, page: number | undefined) => boolean): Promise<ShapePage> {
    const page = query.page, requested = query.offset ?? 0, limit = query.limit ?? 200;
    if (!Number.isSafeInteger(revision) || revision < 0 || !Number.isSafeInteger(requested) || requested < 0
        || !Number.isSafeInteger(limit) || limit < 1 || limit > 200
        || (page !== undefined && (!Number.isSafeInteger(page) || page < 1))
        || (query.revision !== undefined && (!Number.isSafeInteger(query.revision) || query.revision < 0))) throw new RangeError('Invalid shape query');
    const changed = query.revision !== undefined && query.revision !== revision, offset = changed ? 0 : requested;
    const shapes: ShapeSummary[] = [], sections: { offset: number; name: string; index: number }[] = [];
    let total = 0, chars = 0, exhausted = false, work = 0;
    for (const sheet of sheets) {
        let started = false;
        const stack: { nodes: ReturnType<typeof childrenOf>; index: number }[] = [{ nodes: childrenOf(doc, sheet.id), index: 0 }];
        while (stack.length) {
            if ((work++ & 255) === 0) {
                guard();
                await yieldAgentWork();
                guard();
            }
            const top = stack[stack.length - 1];
            if (top.index >= top.nodes.length) { stack.pop(); continue; }
            const node = top.nodes[top.index++], children = childrenOf(doc, node.id);
            if (children.length) stack.push({ nodes: children, index: 0 });
            const nodePage = doc.kind === 'whiteboard' ? undefined : geometry.page(node);
            if (page !== undefined && nodePage !== page) continue;
            if (include && !include(node, nodePage)) continue;
            if (total >= offset && shapes.length < limit && !exhausted) {
                const summary = await boundedSummary(node, geometry, nodePage, guard), size = JSON.stringify(summary).length + 1;
                if (chars + size > 58_500) exhausted = true;
                else {
                    if (labelled && !started) { sections.push({ offset: total, name: sheet.name, index: doc.sheetOrder.indexOf(sheet) }); started = true; }
                    shapes.push(summary); chars += size;
                }
            }
            total++;
        }
    }
    guard();
    const nextOffset = offset + shapes.length;
    return { shapes, total, revision, ...(nextOffset < total ? { nextOffset } : {}),
        ...(changed ? { revisionChanged: true as const } : {}), ...(labelled ? { sections } : {}) };
}

/** The host supplies the live session's canonical geometry and actual owner guard. */
export function createLiveAgentBackend(host: AgentAdapterHost, authority: JobAuthority): {
    shapes(query: ShapeQuery, options: JobOptions): Promise<ShapePage>;
    apply(ops: CanvasOp[], options: JobOptions & { readonly expectedRevision?: number }): Promise<AgentApplyResult>;
} {
    const adapter = createBoardAgentAdapter(host);
    return {
        shapes(query, options) {
            const captured = { ...query };
            return authority.run(async context => {
                authority.assertContext(context);
                if (!host.isCurrent()) throw new DOMException('Board session ended', 'AbortError');
                const revision = host.session.doc.rev;
                const sheet = host.session.doc.sheets.get(host.sheet());
                if (!sheet) throw new RangeError('Sheet does not exist');
                const result = await listPinnedShapes(host.session.doc, [sheet], host.geometry, captured, revision, false, () => {
                    authority.assertContext(context);
                    if (!host.isCurrent() || host.session.doc.rev !== revision || host.sheet() !== sheet.id)
                        throw new DOMException('Board changed during shape projection', 'AbortError');
                });
                authority.assertContext(context);
                if (!host.isCurrent() || host.session.doc.rev !== revision || host.sheet() !== sheet.id || result.revision !== revision) {
                    throw new DOMException('Board changed during shape projection', 'AbortError');
                }
                return result;
            }, options);
        },
        apply(ops, options) {
            if (!Array.isArray(ops) || ops.length < 1 || ops.length > 200) return Promise.reject(new RangeError('Expected 1 to 200 canvas operations'));
            // The caller cannot change a queued transaction after admission begins.
            let captured: CanvasOp[], sheet: ReturnType<AgentAdapterHost['sheet']>, page: number, revision: number;
            try { captured = structuredClone(ops); sheet = host.sheet(); page = host.page(); revision = options.expectedRevision ?? host.session.doc.rev; }
            catch (error) { return Promise.reject(error); }
            return authority.run(async context => {
                authority.assertContext(context);
                if (!Number.isSafeInteger(revision) || revision < 0 || !host.isCurrent() || host.session.doc.rev !== revision
                    || host.sheet() !== sheet || host.page() !== page) throw new DOMException('Agent target view changed', 'AbortError');
                const result = await adapter.apply(captured, {
                    signal: context.signal,
                    isCurrent: () => {
                        try { authority.assertContext(context); return host.isCurrent() && host.session.doc.rev === revision && host.sheet() === sheet && host.page() === page; }
                        catch { return false; }
                    },
                });
                authority.assertContext(context);
                if (!host.isCurrent()) throw new DOMException('Board session ended', 'AbortError');
                return result;
            }, options);
        },
    };
}

/** A closed read uses copied source bytes and the same canonical geometry as a live read. */
export async function readClosedAgentProjection(options: {
    /** For PDF ink this is the extracted board attachment, never the outer PDF. */
    readonly bytes: Blob;
    readonly kind: BoardKind;
    readonly pdfPages?: readonly (readonly [number, number])[];
    readonly diskRevision: number;
    readonly query: ShapeQuery;
    readonly job: JobOptions;
    readonly authority: JobAuthority;
    isCurrent(): boolean;
    /** App compares the current disk stat and hash with the bytes it supplied. */
    assertBaseline(signal: AbortSignal): Promise<void>;
    project(doc: BoardDoc, samples: SampleStore, signal: AbortSignal): Promise<{ readonly geometry: AgentGeometry; dispose(): void }>;
}): Promise<ShapePage> {
    const { authority } = options, query = { ...options.query };
    if (!Number.isSafeInteger(options.diskRevision) || options.diskRevision < 0) throw new RangeError('Invalid disk generation');
    return authority.run(async context => {
        const guard = () => {
            authority.assertContext(context);
            if (!options.isCurrent()) throw new DOMException('Board baseline changed', 'AbortError');
        };
        guard();
        await options.assertBaseline(context.signal);
        guard();
        const acquired = await acquireNativeBoard({ bytes: options.bytes, kind: options.kind, pdfPages: options.pdfPages,
            identity: { session: context.job.session, epoch: context.job.vaultEpoch, generation: context.job.generation },
            signal: context.signal, deadlineMs: options.job.deadlineMs });
        try {
            guard();
            if (acquired.status !== 'editable') throw new Error('Board cannot be projected without its original-byte recovery');
            const projection = await options.project(acquired.load.doc, acquired.samples, context.signal);
            try {
                guard();
                const result = await listPinnedShapes(acquired.load.doc, acquired.load.doc.sheetOrder, projection.geometry,
                    query, options.diskRevision, true, guard);
                guard();
                await options.assertBaseline(context.signal);
                guard();
                return result;
            } finally { projection.dispose(); }
        } finally { acquired.dispose(); }
    }, options.job);
}

type AgentViewSnapshot = Omit<DrawingViewInfo, 'shapes' | 'shapesTotal'>
    | Omit<NotebookViewInfo, 'shapes' | 'shapesTotal'>
    | (Omit<PdfViewInfo, 'shapes' | 'shapesTotal'> & { kind: 'pdf-annotate'; surface: 'annotation' });

/** The view supplies its actual camera, visible pages and selection, pinned with its lease. */
export async function describeLiveAgentView(options: {
    readonly session: BoardSession;
    readonly authority: JobAuthority;
    readonly job: JobOptions;
    readonly geometry: AgentGeometry;
    readonly view: AgentViewSnapshot;
    readonly sheet: SheetId;
    isCurrent(): boolean;
}): Promise<DrawingViewInfo | NotebookViewInfo | PdfViewInfo> {
    const input = options.view;
    const view: AgentViewSnapshot = input.kind === 'drawing'
        ? { ...input, camera: { ...input.camera }, viewport: { ...input.viewport }, selectedShapeIds: [...input.selectedShapeIds] }
        : input.kind === 'notebook'
            ? { ...input, visiblePages: [...input.visiblePages], selectedShapeIds: [...input.selectedShapeIds] }
            : { ...input, visiblePages: [...input.visiblePages], ...(input.selectedShapeIds ? { selectedShapeIds: [...input.selectedShapeIds] } : {}) };
    return options.authority.run(async context => {
        const revision = options.session.doc.rev;
        const guard = () => {
            options.authority.assertContext(context);
            if (!options.isCurrent() || options.session.doc.rev !== revision) throw new DOMException('Board view changed', 'AbortError');
        };
        guard();
        const sheet = options.session.doc.sheets.get(options.sheet);
        if (!sheet) throw new RangeError('Sheet does not exist');
        const kind = options.session.doc.kind;
        if ((view.kind === 'drawing' && kind !== 'whiteboard') || (view.kind === 'notebook' && kind !== 'notebook')
            || (view.kind === 'pdf-annotate' && kind !== 'pdf-ink')) throw new TypeError('View kind does not match the board');
        const visible = (node: Node, page: number | undefined) => {
            if (view.kind === 'drawing') {
                const r = view.viewport, bounds = options.geometry.bounds(node);
                return bounds.x <= r.x + r.w && bounds.x + bounds.w >= r.x && bounds.y <= r.y + r.h && bounds.y + bounds.h >= r.y;
            }
            return page !== undefined && view.visiblePages.includes(page);
        };
        const page = await listPinnedShapes(options.session.doc, [sheet], options.geometry, {}, revision, false, guard, visible);
        guard();
        return { ...view, shapes: page.shapes, shapesTotal: page.total };
    }, options.job);
}

/** The view pins its real frame and image leases before any asynchronous encoding. */
export async function captureLiveAgentProjection(options: {
    readonly session: BoardSession;
    readonly authority: JobAuthority;
    readonly job: JobOptions;
    readonly maxSide: number;
    isCurrent(): boolean;
    pin(): { readonly revision: number; readonly capture: PngCapture; release(): void };
}): Promise<Blob> {
    if (!Number.isSafeInteger(options.maxSide) || options.maxSide < 1 || options.maxSide > 1568) throw new RangeError('Invalid agent capture size');
    return options.authority.run(async context => {
        const guard = (revision: number) => {
            options.authority.assertContext(context);
            if (!options.isCurrent() || options.session.doc.rev !== revision) throw new DOMException('Board capture is stale', 'AbortError');
        };
        options.authority.assertContext(context);
        if (!options.isCurrent()) throw new DOMException('Board session ended', 'AbortError');
        const pin = options.pin();
        try {
            guard(pin.revision);
            if (pin.capture.frame.sceneRevision !== pin.revision) throw new Error('Capture frame revision does not match the board');
            const { world, scale } = pin.capture;
            if (![world.width, world.height, scale].every(Number.isFinite) || world.width <= 0 || world.height <= 0 || scale <= 0
                || Math.ceil(Math.max(world.width, world.height) * scale) > options.maxSide) throw new RangeError('Capture exceeds the agent image budget');
            const { capturePng } = await import('../export/capturePng');
            guard(pin.revision);
            const blob = await capturePng(pin.capture, context.signal);
            guard(pin.revision);
            return blob;
        } finally { pin.release(); }
    }, options.job);
}
