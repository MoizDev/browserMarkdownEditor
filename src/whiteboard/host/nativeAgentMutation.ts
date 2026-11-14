import type { CanvasOp } from '../../../shared/vaultAgentProtocol';
import { createBoardAgentAdapter, type AgentAdapterHost } from '../agent/adapter';
import { AgentApplyReadOnly } from '../agent/errors';
import { createAgentProjection } from '../agent/projection';
import type { ShapePage, ShapeQuery } from '../agent/shapes';
import type { AgentApplyResult } from '../agent/transaction';
import { createStagedGeometryReader } from '../commands/stagedGeometry';
import type { BoardDoc } from '../model/doc';
import type { NodeId, SheetId } from '../model/ids';
import type { JobOptions } from '../security/admission';
import { createLiveAgentBackend } from './agentProjection';
import type { BoardRuntime } from './runtime';

/** What the App owner supplies for one source. None of it is read from the DOM. */
export interface NativeAgentSource {
    /** The App's source identity: this owner, document and disk baseline are still the live ones. */
    isCurrent(): boolean;
    /** Why this source may not be written right now (locked, emergency, baseline conflict), or null. */
    writeBlock(): string | null;
    /** Sheet metadata from the App source, not the visible view. */
    sheet(): SheetId;
    /** Zero-based visible physical page from the App source; ignored on an unpaged board. */
    page(): number;
}
export interface NativeAgentMutation {
    shapes(query: ShapeQuery, options: JobOptions): Promise<ShapePage>;
    /** Whole-batch, all-or-nothing: one C2 transaction read back through the canonical adapter. */
    apply(ops: CanvasOp[], options: JobOptions & { readonly expectedRevision?: number }): Promise<AgentApplyResult>;
    /** Aborts and awaits only this facade's own work. The canonical runtime jobs and document stay live. */
    retire(): Promise<void>;
}

/** Ids a batch names that exist now. Preflight pins their exact geometry before any writer begins. */
function referencedIds(ops: readonly CanvasOp[], doc: BoardDoc): NodeId[] {
    const found = new Set<NodeId>();
    const visit = (value: unknown, depth: number): void => {
        if (typeof value === 'string') {
            for (const candidate of [value, value.startsWith('shape:') ? value.slice(6) : `shape:${value}`]) {
                if (doc.nodes.has(candidate as NodeId)) found.add(candidate as NodeId);
            }
        } else if (depth < 4 && Array.isArray(value)) {
            for (const item of value) visit(item, depth + 1);
        } else if (depth < 4 && value && typeof value === 'object') {
            for (const item of Object.values(value)) visit(item, depth + 1);
        }
    };
    for (const op of ops) visit(op, 0);
    return [...found];
}

/** The native mutation facade belongs to the App-owned runtime: no view, second session, camera or store.
 * Geometry is the canonical logical geometry of the STAGED document, so earlier creates and updates
 * in the same batch are seen exactly as the writer will see them. */
export function createNativeAgentMutation(options: { readonly runtime: BoardRuntime; readonly source: NativeAgentSource }): NativeAgentMutation {
    const { runtime, source } = options;
    // The facade's own cancellation. It never touches runtime.jobs, which also serves clipboard, media and the document.
    const facade = new AbortController();
    const tracked = new Set<Promise<unknown>>();
    // Staged reads are synchronous inside one writer; cancellation is observed at the job boundaries.
    const syncSignal = new AbortController().signal;
    const live = () => !facade.signal.aborted && source.isCurrent();
    const projection = () => {
        const reader = createStagedGeometryReader(runtime.render, runtime.session.doc, syncSignal);
        return createAgentProjection(runtime.session.doc, { worldBox: node => reader.worldBox(node),
            localBox: node => reader.localBox(node), resolvedTip: reader.resolvedTip });
    };
    const host: AgentAdapterHost = {
        get session() { return runtime.session; },
        get geometry() { return projection().geometry; },
        get changeGeometry() { return projection().changeGeometry; },
        sheet: () => source.sheet(),
        page: () => source.page(),
        isCurrent: live,
        readOnlyReason: () => facade.signal.aborted ? 'Board source has ended' : source.writeBlock(),
        // Admission is synchronous and inside the one writer; the batch releases the lease on every outcome.
        admitSamples: builder => runtime.samples.commit(builder),
        target: (node, page) => projection().target(node, page),
        localBox: node => projection().localBox(node),
    };
    // The live backend serves reads through the canonical job authority; the writer below reuses one job context.
    const reads = createLiveAgentBackend(host, runtime.jobs);
    const adapter = createBoardAgentAdapter(host);
    // Every job this facade starts is tracked and aborted by retire(). Each job is one canonical runtime job.
    const scoped = (job: JobOptions): { signal: AbortSignal; deadlineMs: number } => ({
        signal: job.signal ? AbortSignal.any([job.signal, facade.signal]) : facade.signal, deadlineMs: job.deadlineMs,
    });
    const track = <T>(work: Promise<T>): Promise<T> => {
        tracked.add(work);
        const settled = () => { tracked.delete(work); };
        void work.then(settled, settled);
        return work;
    };
    return {
        shapes: (query, job) => track(reads.shapes(query, scoped(job))),
        apply(ops, job) {
            if (!Array.isArray(ops) || ops.length < 1 || ops.length > 200) return Promise.reject(new RangeError('Expected 1 to 200 canvas operations'));
            if (!live()) return Promise.reject(new DOMException('Board source has ended', 'AbortError'));
            // One canonical job runs the whole write: readiness, pins, font warm-up and the writer. Nothing queues between them.
            return track(runtime.jobs.run(async context => {
                runtime.jobs.assertContext(context);
                await runtime.ready;
                runtime.jobs.assertContext(context);
                const block = source.writeBlock();
                if (!live()) throw new DOMException('Board source has ended', 'AbortError');
                if (block !== null) throw new AgentApplyReadOnly(block);
                const doc = runtime.session.doc, revision = doc.rev;
                const sheet = source.sheet(), page = source.page();
                const fence = () => {
                    try { runtime.jobs.assertContext(context); } catch { return false; }
                    return live() && runtime.session.doc === doc && doc.rev === revision && source.sheet() === sheet && source.page() === page;
                };
                // Pins outlive the writer's synchronous commit: they are released only after the adapter settles.
                const pin = await runtime.render.pinChangeGeometry(referencedIds(ops, doc), context.signal, doc, fence);
                try {
                    // Every face the layout can request for the staged text, not only the agent's default family.
                    for (const face of runtime.render.text.faces.faces) {
                        if (!await runtime.render.text.fonts.load(face.key)) throw new Error('Required board font could not be loaded');
                        runtime.jobs.assertContext(context);
                        if (!fence()) throw new DOMException('Board changed during preflight', 'AbortError');
                    }
                    if (!fence()) throw new DOMException('Board changed during preflight', 'AbortError');
                    const reason = source.writeBlock();
                    if (reason !== null) throw new AgentApplyReadOnly(reason);
                    return await adapter.apply(structuredClone(ops), { signal: context.signal, isCurrent: fence });
                } finally { pin.release(); }
            }, scoped(job)));
        },
        async retire() {
            if (facade.signal.aborted) { await Promise.allSettled([...tracked]); return; }
            facade.abort(new DOMException('Board source has ended', 'AbortError'));
            // Settles only this facade's own promises; the runtime's job authority keeps serving the document.
            while (tracked.size) await Promise.allSettled([...tracked]);
        },
    };
}
