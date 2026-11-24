import type { CanvasOp } from '../../../shared/vaultAgentProtocol';
import { createBoardAgentAdapter, type AgentAdapterHost } from '../agent/adapter';
import { summarizeAgentNode, type AgentGeometry, type ShapePage, type ShapeQuery, type ShapeSummary } from '../agent/shapes';
import { childrenOf, type BoardDoc, type BoardKind, type Sheet } from '../model/doc';
import type { SampleStore } from '../ink/samples';
import type { SheetId } from '../model/ids';
import type { Node } from '../model/nodes';
import { EMPTY_RICH_TEXT, type RichText } from '../text/richText';
import type { DrawingViewInfo, NotebookViewInfo, PdfViewInfo } from '../../utils/viewRegistry';
import { acquireNativeBoard } from './nativeAcquisition';
import type { BoardRuntime } from './runtime';
import type { AgentApplyResult } from '../agent/transaction';
import type { JobAuthority, JobOptions } from '../security/admission';
import type { RenderToken } from '../../platform/render/types';
import { createAgentGeometryReader } from './agentGeometry';
import type { NativeLoadReply } from '../workers/nativeLoad';

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
    // Geometry is identity-checked against the pinned doc: give it the real node, not the text-less copy
    // (the copy failed every canvas_shapes on a board with text, a sticky or a labelled shape).
    const own = (value: Node) => value === lean ? node : value;
    const summary = summarizeAgentNode(lean, { bounds: value => geometry.bounds(own(value)), page: value => geometry.page(own(value)),
        rotation: value => geometry.rotation(own(value)) }, page), plain = pieces.join('');
    summary.text = plain.length > 2000 ? `${plain.slice(0, 2000)}…` : plain;
    return summary;
}

export async function listPinnedShapes(doc: BoardDoc, sheets: readonly Sheet[], geometry: AgentGeometry, query: ShapeQuery,
    revision: number, labelled: boolean, guard: () => void, include?: (node: Node, page: number | undefined) => boolean,
    prepare?: (node: Node) => Promise<void>): Promise<ShapePage> {
    const page = query.page, requested = query.offset ?? 0, limit = query.limit ?? 200;
    if (!Number.isSafeInteger(revision) || revision < 0 || !Number.isSafeInteger(requested) || requested < 0
        || !Number.isSafeInteger(limit) || limit < 1 || limit > 200
        || (page !== undefined && (!Number.isSafeInteger(page) || page < 1))
        || (query.revision !== undefined && (!Number.isSafeInteger(query.revision) || query.revision < 0))) throw new RangeError('Invalid shape query');
    const changed = query.revision !== undefined && query.revision !== revision, offset = changed ? 0 : requested;
    const shapes: ShapeSummary[] = [], sections: { offset: number; name: string; index: number }[] = [];
    let total = 0, chars = 0, exhausted = false, work = 0;
    for (let sheetIndex = 0; sheetIndex < sheets.length; sheetIndex++) {
        const sheet = sheets[sheetIndex];
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
            const needsGeometry = page !== undefined || include !== undefined || (total >= offset && shapes.length < limit && !exhausted);
            if (needsGeometry && prepare) { await prepare(node); guard(); }
            const nodePage = doc.kind === 'whiteboard' || !needsGeometry ? undefined : geometry.page(node);
            if (page !== undefined && nodePage !== page) continue;
            if (include && !include(node, nodePage)) continue;
            if (total >= offset && shapes.length < limit && !exhausted) {
                const summary = await boundedSummary(node, geometry, nodePage, guard);
                const section = labelled && !started ? { offset: total, name: sheet.name.slice(0, 2000), index: sheetIndex } : undefined;
                const size = JSON.stringify(summary).length + 1 + (section ? JSON.stringify(section).length + 1 : 0);
                if (size > 58_500) throw new RangeError('A shape summary exceeds the agent response budget');
                if (chars + size > 58_500) exhausted = true;
                else {
                    if (section) { sections.push(section); started = true; }
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

export type ClosedAgentProjectionResult =
    | { readonly kind: 'native'; readonly page: ShapePage; readonly report: NativeLoadReply }
    | { readonly kind: 'other'; readonly report: NativeLoadReply };

/** A closed read uses copied source bytes and the same canonical geometry as a live read. */
export async function readClosedAgentProjection(options: {
    /** For PDF ink this is the extracted board attachment, never the outer PDF. */
    readonly bytes: Blob;
    readonly kind: BoardKind;
    readonly pdfPages?: readonly (readonly [number, number])[];
    readonly diskRevision: number;
    /** Actual App source identity, not a token reconstructed from a worker job. */
    readonly token: RenderToken;
    readonly query: ShapeQuery;
    readonly job: JobOptions;
    readonly authority: JobAuthority;
    isCurrent(): boolean;
    /** App compares the current disk stat and hash with the bytes it supplied. */
    assertBaseline(signal: AbortSignal): Promise<void>;
    project?(doc: BoardDoc, samples: SampleStore, signal: AbortSignal): Promise<{
        readonly geometry: AgentGeometry; prepare?(node: Node): Promise<void>; dispose(): void;
    }>;
}): Promise<ClosedAgentProjectionResult> {
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
            // Only a complete OTHER classification can hand the same baseline
            // back to the legacy route. Truncated or malformed native is never fallback.
            if (acquired.status === 'read-only' && acquired.report.complete && acquired.report.format === 'other') {
                await options.assertBaseline(context.signal); guard();
                return { kind: 'other' as const, report: acquired.report };
            }
            if (acquired.status !== 'editable') throw new Error('Board cannot be projected without its original-byte recovery');
            const projection = options.project ? await options.project(acquired.load.doc, acquired.samples, context.signal)
                : createAgentGeometryReader({ doc: acquired.load.doc, samples: acquired.samples, token: options.token,
                    signal: context.signal, isCurrent: () => authority.isCurrent(context.job) && options.isCurrent(), cooperate: yieldAgentWork });
            try {
                guard();
                const result = await listPinnedShapes(acquired.load.doc, acquired.load.doc.sheetOrder, projection.geometry,
                    query, options.diskRevision, true, guard, undefined, projection.prepare?.bind(projection));
                guard();
                await options.assertBaseline(context.signal);
                guard();
                return { kind: 'native' as const, page: result, report: acquired.report };
            } finally { projection.dispose(); }
        } finally { acquired.dispose(); }
    }, options.job);
}

export type AgentViewSnapshot = Omit<DrawingViewInfo, 'shapes' | 'shapesTotal'>
    | Omit<NotebookViewInfo, 'shapes' | 'shapesTotal'>
    | (Omit<PdfViewInfo, 'shapes' | 'shapesTotal'> & { kind: 'pdf-annotate'; surface: 'annotation' });

/** A mounted board's live view: its camera, visible pages and selection as the view presents them now, read from the
 * runtime's own live document. The geometry is built inside the job, against that document's revision and samples. */
export async function describeLiveAgentView(options: {
    readonly runtime: BoardRuntime;
    readonly job: JobOptions;
    readonly view: AgentViewSnapshot;
    readonly sheet: SheetId;
    isCurrent(): boolean;
}): Promise<DrawingViewInfo | NotebookViewInfo | PdfViewInfo> {
    const input = options.view, runtime = options.runtime;
    const view: AgentViewSnapshot = input.kind === 'drawing'
        ? { ...input, camera: { ...input.camera }, viewport: { ...input.viewport }, selectedShapeIds: [...input.selectedShapeIds] }
        : input.kind === 'notebook'
            ? { ...input, visiblePages: [...input.visiblePages], selectedShapeIds: [...input.selectedShapeIds] }
            : { ...input, visiblePages: [...input.visiblePages], ...(input.selectedShapeIds ? { selectedShapeIds: [...input.selectedShapeIds] } : {}) };
    return runtime.jobs.run(async context => {
        const revision = runtime.session.doc.rev;
        const guard = () => {
            runtime.jobs.assertContext(context);
            if (!options.isCurrent() || runtime.session.doc.rev !== revision) throw new DOMException('Board view changed', 'AbortError');
        };
        guard();
        const doc = runtime.session.doc, sheet = doc.sheets.get(options.sheet);
        if (!sheet) throw new RangeError('Sheet does not exist');
        if ((view.kind === 'drawing' && doc.kind !== 'whiteboard') || (view.kind === 'notebook' && doc.kind !== 'notebook')
            || (view.kind === 'pdf-annotate' && doc.kind !== 'pdf-ink')) throw new TypeError('View kind does not match the board');
        const reader = createAgentGeometryReader({ doc, samples: runtime.samples, token: runtime.paintToken, render: runtime.render,
            signal: context.signal, isCurrent: () => options.isCurrent() && runtime.session.doc.rev === revision, cooperate: yieldAgentWork });
        try {
            const visible = (node: Node, page: number | undefined) => {
                if (view.kind === 'drawing') {
                    const r = view.viewport, bounds = reader.geometry.bounds(node);
                    return bounds.x <= r.x + r.w && bounds.x + bounds.w >= r.x && bounds.y <= r.y + r.h && bounds.y + bounds.h >= r.y;
                }
                return page !== undefined && view.visiblePages.includes(page);
            };
            const page = await listPinnedShapes(doc, [sheet], reader.geometry, {}, revision, false, guard, visible, reader.prepare);
            guard();
            return { ...view, shapes: page.shapes, shapesTotal: page.total } as DrawingViewInfo | NotebookViewInfo | PdfViewInfo;
        } finally { reader.dispose(); }
    }, options.job);
}

/** The live capture of a mounted view: `pin` takes the view's own frame at the current revision, and the job re-checks
 * that revision and the owner after the encode. The capture size is bounded here, once, for every caller. */
export async function captureLiveAgentProjection(options: {
    readonly runtime: BoardRuntime;
    readonly job: JobOptions;
    readonly maxSide: number;
    isCurrent(): boolean;
    pin(): { readonly revision: number; capture(signal: AbortSignal): Promise<Blob>; release(): void };
}): Promise<Blob> {
    if (!Number.isSafeInteger(options.maxSide) || options.maxSide < 1 || options.maxSide > 1568) throw new RangeError('Invalid agent capture size');
    const runtime = options.runtime;
    return runtime.jobs.run(async context => {
        const guard = (revision: number) => {
            runtime.jobs.assertContext(context);
            if (!options.isCurrent() || runtime.session.doc.rev !== revision) throw new DOMException('Board capture is stale', 'AbortError');
        };
        runtime.jobs.assertContext(context);
        if (!options.isCurrent()) throw new DOMException('Board session ended', 'AbortError');
        const pin = options.pin();
        try {
            guard(pin.revision);
            const blob = await pin.capture(context.signal);
            guard(pin.revision);
            return blob;
        } finally { pin.release(); }
    }, options.job);
}
