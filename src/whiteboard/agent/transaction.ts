import type { CanvasOp } from '../../../shared/vaultAgentProtocol';
import { runAgentBatch } from '../change/agentBatch';
import type { CommandBuilder } from '../change/ops';
import type { NodeId } from '../model/ids';
import type { BoardSession } from '../session/BoardSession';
import { AgentApplyCancelled, AgentApplyReadOnly, AgentOpRefused } from './errors';
import { validateAgentOp } from './validate';

export { AgentApplyCancelled, AgentApplyReadOnly, AgentOpRefused } from './errors';

export interface AgentApplyResult {
    readonly created: string[];
    readonly updated: string[];
    readonly deleted: string[];
    readonly errors: string[];
}
export interface AgentOpResult {
    readonly created?: NodeId;
    readonly updated?: readonly NodeId[];
    readonly deleted?: readonly NodeId[];
    readonly notes?: readonly string[];
    readonly problems?: readonly string[];
}
export interface AgentOpContext {
    readonly builder: CommandBuilder;
    /** Resolves only successful earlier creations, never the current/future op. */
    resolve(reference: string): NodeId;
}
export interface AgentApplyHost {
    readonly session: BoardSession;
    isCurrent(): boolean;
    readOnlyReason(): string | null;
    stage(op: CanvasOp, context: AgentOpContext): AgentOpResult;
}

function lookup(session: BoardSession, prior: ReadonlyMap<number, AgentOpResult>, reference: string): NodeId {
    if (reference.startsWith('$')) {
        const match = /^\$(\d+)$/u.exec(reference);
        const index = match ? Number(match[1]) : NaN;
        const id = Number.isSafeInteger(index) && index > 0 ? prior.get(index)?.created : undefined;
        if (!id) throw new AgentOpRefused(`${reference} created no shape`);
        return id;
    }
    // Imported ids are opaque and may themselves contain shape:. Exact matches
    // win before attempting the historical optional prefix spelling.
    const exact = reference as NodeId;
    if (session.doc.nodes.has(exact)) return exact;
    const alternate = (reference.startsWith('shape:') ? reference.slice(6) : `shape:${reference}`) as NodeId;
    if (session.doc.nodes.has(alternate)) return alternate;
    throw new AgentOpRefused(`no shape ${reference}`);
}

// F-AGENT-002/003/004/005/012/013: the shared runner owns the single builder,
// op savepoints and receipt. No async work occurs between begin and commit.
export async function applyAgentOperations(host: AgentApplyHost, ops: readonly CanvasOp[], signal: AbortSignal): Promise<AgentApplyResult> {
    if (signal.aborted) throw new AgentApplyCancelled();
    if (ops.length < 1 || ops.length > 200) throw new RangeError('Expected 1 to 200 canvas operations');
    return host.session.enqueueAfterGesture(signal, () => {
        if (signal.aborted || !host.isCurrent()) throw new AgentApplyCancelled();
        const reason = host.readOnlyReason();
        if (reason !== null || host.session.isReadOnly) throw new AgentApplyReadOnly(reason ?? 'Board is read-only');
        const batch = runAgentBatch<CanvasOp, AgentOpResult>(host.session, ops, (op, context) => {
            const validated = validateAgentOp(op);
            const staged = host.stage(validated.op, { builder: context.builder,
                resolve: reference => lookup(host.session, context.prior, reference) });
            return { value: staged, notes: [...validated.notes, ...(staged.notes ?? [])] };
        });
        if (!batch.ok) throw batch.error;
        try {
            const result: AgentApplyResult = { created: [], updated: [], deleted: [], errors: [...batch.errors] };
            for (const [number, staged] of batch.accepted) {
                if (staged.created !== undefined) result.created.push(staged.created);
                if (staged.updated) result.updated.push(...staged.updated);
                if (staged.deleted) result.deleted.push(...staged.deleted);
                for (const problem of staged.problems ?? []) result.errors.push(`op ${number}: ${problem}`);
            }
            return result;
        } finally { batch.applied.release(); }
    });
}
