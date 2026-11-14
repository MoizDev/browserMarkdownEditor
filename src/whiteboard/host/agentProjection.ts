import type { CanvasOp } from '../../../shared/vaultAgentProtocol';
import { createBoardAgentAdapter, type AgentAdapterHost } from '../agent/adapter';
import { listAgentSheets, type AgentGeometry, type ShapePage, type ShapeQuery } from '../agent/shapes';
import type { BoardDoc, BoardKind } from '../model/doc';
import type { SampleStore } from '../ink/samples';
import { acquireNativeBoard } from './nativeAcquisition';
import type { AgentApplyResult } from '../agent/transaction';
import type { JobAuthority, JobOptions } from '../security/admission';

/** The host supplies the live session's canonical geometry and actual owner guard. */
export function createLiveAgentBackend(host: AgentAdapterHost, authority: JobAuthority): {
    shapes(query: ShapeQuery, options: JobOptions): Promise<ShapePage>;
    apply(ops: CanvasOp[], options: JobOptions): Promise<AgentApplyResult>;
} {
    const adapter = createBoardAgentAdapter(host);
    return {
        shapes(query, options) {
            return authority.run(async context => {
                authority.assertContext(context);
                if (!host.isCurrent()) throw new DOMException('Board session ended', 'AbortError');
                const revision = host.session.doc.rev;
                const result = adapter.shapePage(query);
                authority.assertContext(context);
                if (!host.isCurrent() || host.session.doc.rev !== revision || result.revision !== revision) {
                    throw new DOMException('Board changed during shape projection', 'AbortError');
                }
                return result;
            }, options);
        },
        apply(ops, options) {
            return authority.run(async context => {
                authority.assertContext(context);
                const result = await adapter.apply(ops, {
                    signal: context.signal,
                    isCurrent: () => {
                        try { authority.assertContext(context); return host.isCurrent(); }
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
    project(doc: BoardDoc, samples: SampleStore, signal: AbortSignal): Promise<{ readonly geometry: AgentGeometry; dispose(): void }>;
}): Promise<ShapePage> {
    const { authority } = options;
    if (!Number.isSafeInteger(options.diskRevision) || options.diskRevision < 0) throw new RangeError('Invalid disk generation');
    return authority.run(async context => {
        const guard = () => {
            authority.assertContext(context);
            if (!options.isCurrent()) throw new DOMException('Board baseline changed', 'AbortError');
        };
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
                const result = listAgentSheets(acquired.load.doc, projection.geometry, options.query, options.diskRevision);
                guard();
                return result;
            } finally { projection.dispose(); }
        } finally { acquired.dispose(); }
    }, options.job);
}
