import type { Node } from '../model/nodes';
import type { BoardDoc } from '../model/doc';
import type { SheetId } from '../model/ids';
import type { ShapePage, ShapeQuery } from '../agent/shapes';
import type { JobOptions } from '../security/admission';
import { createAgentGeometryReader, type AgentGeometryReader } from './agentGeometry';
import { listPinnedShapes, type AgentViewSnapshot } from './agentProjection';
import type { BoardRuntime } from './runtime';
import type { Rect } from '../../platform/types';
import { prepareNativeExport, type NativeExportOptions } from './nativeExport';
import { readNativeAgentViewport } from './nativeAgentView';
import { boardPageStack } from '../model/pages';
import type { DrawingViewInfo, NotebookViewInfo } from '../../utils/viewRegistry';

function requestSignal(job: JobOptions): AbortSignal {
    if (!Number.isFinite(job.deadlineMs) || job.deadlineMs <= 0) throw new RangeError('Invalid agent read deadline');
    const timeout = AbortSignal.timeout(Math.min(0xffffffff, Math.ceil(job.deadlineMs)));
    return job.signal ? AbortSignal.any([job.signal, timeout]) : timeout;
}

/** Source capture is synchronous; read-only requests never queue behind mutation
 * jobs or acquire a second document/session. Scene pins keep the actual renderer,
 * samples and media alive even after the App document owner retires. */
export function createNativeAgentReader(options: {
    readonly runtime: BoardRuntime;
    readonly retainPdfSource?: NativeExportOptions['retainPdfSource'];
    /** App's canonical pending-or-disk media reader; the export producer forwards it for embedded pictures. */
    readonly readMedia?: NativeExportOptions['readMedia'];
    isCurrent(): boolean;
    notice(message: string): void;
    onError(error: unknown): void;
}) {
    const { runtime } = options;
    const cooperate = () => {
        const scheduler = (globalThis as typeof globalThis & { scheduler?: { yield?: () => Promise<void> } }).scheduler;
        return scheduler?.yield ? scheduler.yield() : new Promise<void>(resolve => setTimeout(resolve, 0));
    };
    const read = async <T>(job: JobOptions, consume: (doc: BoardDoc, sheet: SheetId, revision: number,
        reader: AgentGeometryReader, guard: () => void) => Promise<T>): Promise<T> => {
        const signal = requestSignal(job);
        signal.throwIfAborted();
        if (!options.isCurrent()) throw new DOMException('Board source ended', 'AbortError');
        const scene = runtime.scene, revision = runtime.session.doc.rev, owner = runtime.session.owner;
        const sheet = runtime.selection.getSnapshot().sheet;
        if (!scene?.ready || scene.revision !== revision) throw new Error('Board scene is not ready');
        const pin = scene.pin();
        let reader: AgentGeometryReader | undefined, released = false;
        const guard = () => {
            signal.throwIfAborted();
            if (released) throw new DOMException('Agent source released', 'AbortError');
        };
        try {
            if (pin.revision !== revision || pin.token.documentId !== owner.documentId || pin.token.session !== owner.session)
                throw new Error('Agent scene does not match its App document');
            const doc = await pin.readDocument(signal);
            guard();
            if (doc.rev !== revision || !doc.sheets.has(sheet)) throw new Error('Agent source revision or sheet differs');
            reader = createAgentGeometryReader({ doc, samples: runtime.samples, render: runtime.render,
                token: pin.token, signal, isCurrent: () => !released && !signal.aborted, cooperate });
            const result = await consume(doc, sheet, revision, reader, guard);
            guard();
            return result;
        } finally {
            released = true;
            try { reader?.dispose(); } finally { pin.release(); }
        }
    };
    /** Canonical whole-sheet paint bounds, measured by the export producer the same way a menu export is. */
    const wholeSheetBounds = async (job: JobOptions): Promise<Rect> => {
        const prepared = await prepareNativeExport({ runtime, route: 'menu', boardName: 'Describe', theme: 'light', transparent: false,
            signal: requestSignal(job), current: options.isCurrent, notice: options.notice, onError: options.onError,
            readMedia: options.readMedia, retainPdfSource: options.retainPdfSource });
        try { return { ...prepared.bounds }; } finally { prepared.release(); }
    };
    return {
        async capture(region: Readonly<Rect>, maxSide: number, job: JobOptions): Promise<Blob> {
            if (!Number.isSafeInteger(maxSide) || maxSide < 1 || maxSide > 1568) throw new RangeError('Invalid agent capture maximum side');
            const signal = requestSignal(job);
            // The export producer captures its Scene/PDF/media before awaiting;
            // this is the real capture path, not a viewport DOM screenshot.
            const capture = await prepareNativeExport({ runtime, route: 'menu', boardName: 'Capture', theme: 'light', transparent: false,
                region, maxSide, signal, current: options.isCurrent, notice: options.notice, onError: options.onError,
                readMedia: options.readMedia, retainPdfSource: options.retainPdfSource });
            try { return await capture.png(signal); } finally { capture.release(); }
        },
        shapes(query: ShapeQuery, job: JobOptions): Promise<ShapePage> {
            const captured = { ...query };
            return read(job, (doc, sheet, revision, reader, guard) => listPinnedShapes(doc, [doc.sheets.get(sheet)!],
                reader.geometry, captured, revision, false, guard, undefined, reader.prepare));
        },
        /** The agent's view of the board without any mounted view. The last real viewport the App recorded
         * (camera, insets, focus) is used when it exists; a never-viewed board reports its whole sheet. */
        async describe(job: JobOptions): Promise<DrawingViewInfo | NotebookViewInfo> {
            const recorded = readNativeAgentViewport(runtime);
            const kind = runtime.session.doc.kind;
            // A drawing that was never viewed has no camera: its whole canonical paint is the view.
            const whole = !recorded && kind === 'whiteboard' ? await wholeSheetBounds(job) : undefined;
            return read(job, async (doc, sheet, revision, reader, guard) => {
                const view: AgentViewSnapshot = recorded ? recorded.view : fallbackView(doc, sheet, whole);
                if ((view.kind === 'drawing' && doc.kind !== 'whiteboard') || (view.kind === 'notebook' && doc.kind !== 'notebook')) {
                    throw new Error('Agent view kind differs from its source');
                }
                // A recorded viewport lists what it shows; a never-viewed board lists its whole sheet.
                const visible = recorded ? (node: Node, page: number | undefined) => {
                    if (view.kind !== 'drawing') return page !== undefined && view.kind === 'notebook' && view.visiblePages.includes(page);
                    const a = reader.geometry.bounds(node), b = view.viewport;
                    return a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;
                } : undefined;
                const page = await listPinnedShapes(doc, [doc.sheets.get(sheet)!], reader.geometry, {}, revision,
                    false, guard, visible, reader.prepare);
                guard();
                if (view.kind === 'drawing') return { ...view, shapes: page.shapes, shapesTotal: page.total };
                if (view.kind === 'notebook') return { ...view, shapes: page.shapes, shapesTotal: page.total };
                throw new Error('Native agent view is not a drawing or notebook');
            });
        },
    };
}

/** The never-viewed view: a drawing shows its whole canonical paint; a notebook shows its first page. */
function fallbackView(doc: BoardDoc, sheet: SheetId, whole: Rect | undefined): AgentViewSnapshot {
    const current = doc.sheets.get(sheet)!, pageIndex = doc.sheetOrder.findIndex(value => value.id === sheet) + 1;
    if (doc.kind === 'whiteboard') {
        if (!whole) throw new Error('A drawing view needs its whole paint bounds');
        return { kind: 'drawing', pageName: current.name, pageIndex, pageCount: doc.sheetOrder.length,
            camera: { x: -whole.x, y: -whole.y, z: 1 }, viewport: { x: whole.x, y: whole.y, w: whole.width, h: whole.height }, selectedShapeIds: [] };
    }
    if (doc.kind === 'notebook' && doc.host.kind === 'notebook') {
        const paper = doc.host.paper, stack = boardPageStack(doc.host);
        return { kind: 'notebook', pageCount: stack?.rects.length ?? 1, page: 1, offset: 0, zoom: 1, visiblePages: [1],
            paper: `${paper.ruling} · ${paper.size} · ${paper.orientation}`, selectedShapeIds: [] };
    }
    throw new Error('Native agent view is not a drawing or notebook');
}
