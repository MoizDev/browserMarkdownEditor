import type { CanvasOp } from '../../../shared/vaultAgentProtocol';
import { createBoardAgentAdapter, type AgentAdapterHost } from '../agent/adapter';
import { AgentApplyReadOnly } from '../agent/errors';
import { createAgentProjection } from '../agent/projection';
import type { ShapePage, ShapeQuery } from '../agent/shapes';
import type { AgentApplyResult } from '../agent/transaction';
import { createStagedGeometryReader } from '../commands/stagedGeometry';
import type { BoardDoc } from '../model/doc';
import type { NodeId, SheetId } from '../model/ids';
import { FONTS } from '../model/styles';
import type { JobOptions } from '../security/admission';
import { createLiveAgentBackend } from './agentProjection';
import type { BoardRuntime } from './runtime';

export interface NativeAgentSource {
    isCurrent(): boolean;
    writeBlock(): string | null;
    sheet(): SheetId;
    page(): number;
}
export interface NativeAgentMutation {
    shapes(query: ShapeQuery, options: JobOptions): Promise<ShapePage>;
    apply(ops: CanvasOp[], options: JobOptions & { readonly expectedRevision?: number }): Promise<AgentApplyResult>;
    retire(): Promise<void>;
}

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

export function createNativeAgentMutation(options: { readonly runtime: BoardRuntime; readonly source: NativeAgentSource }): NativeAgentMutation {
    const { runtime, source } = options;
    const facade = new AbortController();
    const tracked = new Set<Promise<unknown>>();
    const syncSignal = new AbortController().signal;
    const live = () => !facade.signal.aborted && source.isCurrent();
    const projection = () => {
        const reader = createStagedGeometryReader(runtime.render, runtime.session.doc, syncSignal);
        return createAgentProjection(runtime.session.doc, { worldBox: node => reader.worldBox(node),
            localBox: node => reader.localBox(node), resolvedTip: reader.resolvedTip,
            resolvedPolylineTip: reader.resolvedPolylineTip });
    };
    const writeRefusal = (): string | null => source.writeBlock() ?? (runtime.session.isReadOnly ? runtime.session.readOnlyReason ?? 'This board is read-only.' : null);
    const host: AgentAdapterHost = {
        get session() { return runtime.session; },
        get geometry() { return projection().geometry; },
        get changeGeometry() { return projection().changeGeometry; },
        sheet: () => source.sheet(),
        page: () => source.page(),
        isCurrent: live,
        readOnlyReason: () => facade.signal.aborted ? 'Board source has ended' : writeRefusal(),
        admitSamples: builder => runtime.samples.commit(builder),
        target: (node, page) => projection().target(node, page),
        localBox: node => projection().localBox(node),
    };
    const reads = createLiveAgentBackend(host, runtime.jobs);
    const adapter = createBoardAgentAdapter(host);
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
            let captured: CanvasOp[];
            try { captured = structuredClone(ops); } catch (error) { return Promise.reject(error); }
            const expected = job.expectedRevision ?? runtime.session.doc.rev, expectedSheet = source.sheet(), expectedPage = source.page();
            if (!Number.isSafeInteger(expected) || expected < 0) return Promise.reject(new RangeError('Invalid expected board revision'));
            return track(runtime.jobs.run(async context => {
                runtime.jobs.assertContext(context);
                await runtime.ready;
                runtime.jobs.assertContext(context);
                const block = writeRefusal();
                if (!live()) throw new DOMException('Board source has ended', 'AbortError');
                if (block !== null) throw new AgentApplyReadOnly(block);
                const doc = runtime.session.doc, revision = doc.rev;
                const sheet = source.sheet(), page = source.page();
                if (revision !== expected || sheet !== expectedSheet || page !== expectedPage) {
                    throw new DOMException('Board changed before the agent transaction started', 'AbortError');
                }
                const fence = () => {
                    try { runtime.jobs.assertContext(context); } catch { return false; }
                    return live() && runtime.session.doc === doc && doc.rev === revision && source.sheet() === sheet && source.page() === page;
                };
                // An empty board has no published faces, and a staged edit can introduce a new family/mark.
                // Warm before pinning: an old fallback-font scope must not survive a face epoch change into C2.
                for (const family of FONTS) for (const bold of [false, true]) for (const italic of [false, true]) {
                    if (!await runtime.render.text.fonts.load({ family, bold, italic })) throw new Error('Required board font could not be loaded');
                    runtime.jobs.assertContext(context);
                    if (!fence()) throw new DOMException('Board changed during preflight', 'AbortError');
                }
                // Pins outlive the writer's synchronous commit: they are released only after the adapter settles.
                const pin = await runtime.render.pinChangeGeometry(referencedIds(captured, doc), context.signal, doc, fence);
                try {
                    if (!fence()) throw new DOMException('Board changed during preflight', 'AbortError');
                    const reason = source.writeBlock();
                    if (reason !== null) throw new AgentApplyReadOnly(reason);
                    return await adapter.apply(captured, { signal: context.signal, isCurrent: fence });
                } finally { pin.release(); }
            }, scoped(job)));
        },
        async retire() {
            if (!facade.signal.aborted) facade.abort(new DOMException('Board source has ended', 'AbortError'));
            while (tracked.size) await Promise.allSettled([...tracked]);
            await runtime.jobs.drain();
        },
    };
}
