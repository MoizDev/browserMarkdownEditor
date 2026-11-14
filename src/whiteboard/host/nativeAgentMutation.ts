import type { CanvasOp } from '../../../shared/vaultAgentProtocol';
import type { AgentAdapterHost } from '../agent/adapter';
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
    /** Revokes every queued and running job, then waits for their actual settlement. Release the source only after this resolves. */
    retire(): Promise<void>;
}

/** Ids a batch names that exist now. Preflight warms their exact geometry before any writer begins. */
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
    let retired = false;
    // Staged reads are synchronous inside one writer; cancellation is observed at the job boundaries.
    const syncSignal = new AbortController().signal;
    const live = () => !retired && source.isCurrent();
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
        readOnlyReason: () => retired ? 'Board source has ended' : source.writeBlock(),
        // Admission is synchronous and inside the one writer; the batch releases the lease on every outcome.
        admitSamples: builder => runtime.samples.commit(builder),
        target: (node, page) => projection().target(node, page),
        localBox: node => projection().localBox(node),
    };
    // createLiveAgentBackend builds the one canonical adapter and writer path over this host.
    const backend = createLiveAgentBackend(host, runtime.jobs);
    return {
        shapes: (query, job) => backend.shapes(query, job),
        async apply(ops, job) {
            if (!Array.isArray(ops) || ops.length < 1 || ops.length > 200) throw new RangeError('Expected 1 to 200 canvas operations');
            if (!live()) throw new DOMException('Board source has ended', 'AbortError');
            // Preflight outside the writer: wait for the scene, then warm and pin the exact inputs this batch names,
            // and load the agent's font face. Nothing awaits between this and the synchronous writer's commit.
            await runtime.ready.catch(() => { /* A disposed runtime is refused by the job check below. */ });
            await runtime.jobs.run(async context => {
                runtime.jobs.assertContext(context);
                if (!live()) throw new DOMException('Board source has ended', 'AbortError');
                const reason = source.writeBlock();
                if (reason !== null) throw new AgentApplyReadOnly(reason);
                const doc = runtime.session.doc;
                const lease = await runtime.render.pinChangeGeometry(referencedIds(ops, doc), context.signal, doc, live);
                try {
                    runtime.jobs.assertContext(context);
                    if (!await runtime.render.text.fonts.load({ family: 'draw', bold: false, italic: false })) {
                        throw new Error('Required board font could not be loaded');
                    }
                } finally { lease.release(); }
                runtime.jobs.assertContext(context);
                if (!live()) throw new DOMException('Board source has ended', 'AbortError');
            }, job);
            return backend.apply(ops, job);
        },
        async retire() {
            if (retired) return;
            retired = true;
            runtime.jobs.dispose();
            await runtime.jobs.drain();
        },
    };
}
