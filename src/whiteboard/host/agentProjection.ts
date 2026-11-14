import type { CanvasOp } from '../../../shared/vaultAgentProtocol';
import { createBoardAgentAdapter, type AgentAdapterHost } from '../agent/adapter';
import type { ShapePage, ShapeQuery } from '../agent/shapes';
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
