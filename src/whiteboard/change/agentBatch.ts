import type { Applied, CommandBuilder, Op, TransactionOrigin, TxBuilder } from './ops';
import { ApplyFailed, ApplyRefused } from './errors';

export class AgentOpError extends Error {
    constructor(message: string) { super(message); this.name = 'AgentOpError'; }
}
export interface AgentCommandResult<T> {
    readonly value: T;
    readonly notes?: readonly string[]; // Existing errors channel, prefixed "op N: note: ...".
}
export interface AgentCommandContext<T> {
    readonly builder: CommandBuilder; // No commit: a command cannot publish part of its batch.
    readonly opNumber: number; // 1-based, matching $N aliases and wire error labels.
    readonly prior: ReadonlyMap<number, T>; // Successful original op numbers only, never renumbered.
}
export type AgentBatchResult<T> =
    | { readonly ok: true; readonly applied: Applied; readonly accepted: ReadonlyMap<number, T>; readonly errors: readonly string[] }
    | { readonly ok: false; readonly applied: null; readonly accepted: ReadonlyMap<number, T>; readonly errors: readonly string[]; readonly error: unknown };
interface BatchSession { begin(origin: TransactionOrigin, label: string): TxBuilder }
function message(error: unknown): string {
    return error instanceof ApplyRefused ? error.reason : error instanceof Error ? error.message : 'Unexpected operation failure';
}

// CH §2.5: external I/O/readiness finishes BEFORE begin. execute is synchronous,
// reads session.doc's staged values, and publishes aliases/results only on success.
// The successful caller owns applied and must release its receipt after use.
export function runAgentBatch<Input, Result>(session: BatchSession, inputs: readonly Input[],
    execute: (input: Input, context: AgentCommandContext<Result>) => AgentCommandResult<Result>): AgentBatchResult<Result> {
    const accepted = new Map<number, Result>(), errors: string[] = [];
    let builder: TxBuilder | undefined;
    try {
        if (!Array.isArray(inputs) || inputs.length > 200) throw new AgentOpError('A canvas batch accepts at most 200 operations');
        builder = session.begin('agent', 'agent canvas edit');
        const batch = builder;
        const port: CommandBuilder = Object.freeze({
            push: (op: Op) => batch.push(op), savepoint: () => batch.savepoint(),
            rollbackTo: (point: number) => batch.rollbackTo(point), abort: () => batch.abort(),
        });
        for (let i = 0; i < inputs.length; i++) {
            const point = builder.savepoint(), errorPoint = errors.length;
            try {
                const result = execute(inputs[i], { builder: port, opNumber: i + 1, prior: accepted });
                if (!result || typeof result !== 'object' || !Object.hasOwn(result, 'value') || 'then' in result) throw new ApplyFailed('agent-translator', 'Agent translation must finish synchronously');
                accepted.set(i + 1, result.value);
                for (const note of result.notes ?? []) errors.push(`op ${i + 1}: note: ${note}`);
            } catch (error) {
                if (!(error instanceof ApplyRefused) && !(error instanceof AgentOpError)) throw error;
                builder.rollbackTo(point);
                accepted.delete(i + 1);
                errors.length = errorPoint;
                errors.push(`op ${i + 1}: ${message(error)}`);
            }
        }
        const applied = builder.commit(); // Normalization refusal takes back the WHOLE batch.
        return { ok: true, applied, accepted, errors };
    } catch (caught) {
        let error: unknown = caught;
        try { builder?.abort(); }
        catch (abortError) { error = abortError; }
        accepted.clear();
        errors.push(error instanceof ApplyFailed && error.unsafe
            ? `no changes were committed: ${message(error)}`
            : `nothing was applied: ${message(error)}`);
        return { ok: false, applied: null, accepted, errors, error };
    }
}
