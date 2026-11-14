import type { CanvasOp } from '../../../shared/vaultAgentProtocol';
import { ApplyRefused } from '../change/apply';
import type { TxBuilder } from '../change/ops';
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
    readonly builder: TxBuilder;
    /** Resolves only successful earlier creations, never the current/future op. */
    resolve(reference: string): NodeId;
}
export interface AgentApplyHost {
    readonly session: BoardSession;
    /** The App-owned document/session serial still identifies this session. */
    isCurrent(): boolean;
    /** Called after waiting, immediately before opening a transaction. */
    readOnlyReason(): string | null;
    /** Serialize with gestures and other agent edits; reject if signal is aborted. */
    enqueue<T>(signal: AbortSignal, task: () => T): Promise<T>;
    /** Synchronously stage one op. Refusals must use AgentOpRefused or ApplyRefused. */
    stage(op: CanvasOp, context: AgentOpContext): AgentOpResult;
}

function lookup(session: BoardSession, aliases: ReadonlyMap<number, NodeId>, reference: string): NodeId {
    if (reference.startsWith('$')) {
        const match = /^\$(\d+)$/u.exec(reference);
        const index = match ? Number(match[1]) : NaN;
        const id = Number.isSafeInteger(index) && index > 0 ? aliases.get(index) : undefined;
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

// F-AGENT-002/003/004/005/012/013: only a single synchronous builder is ever
// open, after gesture serialization. Savepoints isolate expected per-op errors;
// abort covers internal errors and commit refusal without publishing partial work.
export async function applyAgentOperations(host: AgentApplyHost, ops: readonly CanvasOp[], signal: AbortSignal): Promise<AgentApplyResult> {
    if (signal.aborted) throw new AgentApplyCancelled();
    if (ops.length < 1 || ops.length > 200) throw new RangeError('Expected 1 to 200 canvas operations');
    return host.enqueue(signal, () => {
        if (signal.aborted || !host.isCurrent()) throw new AgentApplyCancelled();
        const reason = host.readOnlyReason();
        if (reason !== null) throw new AgentApplyReadOnly(reason);
        const builder = host.session.begin('agent', 'Agent canvas edit');
        const aliases = new Map<number, NodeId>();
        const result: AgentApplyResult = { created: [], updated: [], deleted: [], errors: [] };
        try {
            for (let i = 0; i < ops.length; i++) {
                const point = builder.savepoint();
                try {
                    const validated = validateAgentOp(ops[i]);
                    const staged = host.stage(validated.op, { builder, resolve: reference => lookup(host.session, aliases, reference) });
                    if (staged.created !== undefined) {
                        aliases.set(i + 1, staged.created);
                        result.created.push(staged.created);
                    }
                    if (staged.updated) result.updated.push(...staged.updated);
                    if (staged.deleted) result.deleted.push(...staged.deleted);
                    for (const note of [...validated.notes, ...(staged.notes ?? [])]) result.errors.push(`op ${i + 1}: note: ${note}`);
                    for (const problem of staged.problems ?? []) result.errors.push(`op ${i + 1}: ${problem}`);
                } catch (error) {
                    if (!(error instanceof AgentOpRefused) && !(error instanceof ApplyRefused)) throw error;
                    builder.rollbackTo(point);
                    result.errors.push(`op ${i + 1}: ${error.message}`);
                }
            }
            const applied = builder.commit();
            applied.release();
            return result;
        } catch (error) {
            // commit() can close the builder before throwing; abort is harmless only
            // while open, so a close failure must not obscure the original failure.
            try { builder.abort(); } catch { /* original failure wins */ }
            throw error;
        }
    });
}
