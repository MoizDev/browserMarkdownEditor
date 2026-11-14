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
    return {
        async capture(region: Readonly<Rect>, maxSide: number, job: JobOptions): Promise<Blob> {
            if (!Number.isSafeInteger(maxSide) || maxSide < 1 || maxSide > 1568) throw new RangeError('Invalid agent capture maximum side');
            const signal = requestSignal(job);
            // The export producer captures its Scene/PDF/media before awaiting;
            // this is the real capture path, not a viewport DOM screenshot.
            const capture = await prepareNativeExport({ runtime, route: 'menu', boardName: 'Capture', theme: 'light', transparent: false,
                region, maxSide, signal, current: options.isCurrent, notice: options.notice, onError: options.onError,
                retainPdfSource: options.retainPdfSource });
            try { return await capture.png(signal); } finally { capture.release(); }
        },
        shapes(query: ShapeQuery, job: JobOptions): Promise<ShapePage> {
            const captured = { ...query };
            return read(job, (doc, sheet, revision, reader, guard) => listPinnedShapes(doc, [doc.sheets.get(sheet)!],
                reader.geometry, captured, revision, false, guard, undefined, reader.prepare));
        },
        describe(view: AgentViewSnapshot, job: JobOptions) {
            // Camera/pages/selection belong to the send gesture, not a later
            // queued task or a replacement pane that happens to show this path.
            const captured: AgentViewSnapshot = structuredClone(view);
            return read(job, async (doc, sheet, revision, reader, guard) => {
                if ((captured.kind === 'drawing' && doc.kind !== 'whiteboard')
                    || (captured.kind === 'notebook' && doc.kind !== 'notebook')
                    || (captured.kind === 'pdf-annotate' && doc.kind !== 'pdf-ink')) throw new Error('Agent view kind differs from its captured source');
                const visible = (node: Node, page: number | undefined) => {
                    if (captured.kind !== 'drawing') return page !== undefined && captured.visiblePages.includes(page);
                    const a = reader.geometry.bounds(node), b = captured.viewport;
                    return a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;
                };
                const page = await listPinnedShapes(doc, [doc.sheets.get(sheet)!], reader.geometry, {}, revision,
                    false, guard, visible, reader.prepare);
                guard();
                return { ...captured, shapes: page.shapes, shapesTotal: page.total };
            });
        },
    };
}
