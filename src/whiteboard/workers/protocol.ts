import type { WorkerContext } from '../../platform/workers';

/** Identity is checked at both ends; revision is the exact document revision the job saw. */
export interface BoardJobIdentity {
    readonly session: string;
    readonly epoch: number;
    readonly revision: number;
}
export interface BoardWorkerEnvelope<T> {
    readonly identity: BoardJobIdentity;
    readonly payload: T;
}
export type BoardWorkerHandler = (payload: unknown, context: WorkerContext) => unknown | Promise<unknown>;

export function validBoardIdentity(value: unknown): value is BoardJobIdentity {
    if (!value || typeof value !== 'object') return false;
    const item = value as Record<string, unknown>;
    return typeof item.session === 'string' && item.session.length > 0 && item.session.length <= 128
        && Number.isSafeInteger(item.epoch) && (item.epoch as number) >= 0
        && Number.isSafeInteger(item.revision) && (item.revision as number) >= 0;
}
export function matchingIdentity(a: BoardJobIdentity, b: BoardJobIdentity): boolean {
    return a.session === b.session && a.epoch === b.epoch && a.revision === b.revision;
}
export function boardEnvelope(value: unknown): value is BoardWorkerEnvelope<unknown> {
    return !!value && typeof value === 'object' && validBoardIdentity((value as BoardWorkerEnvelope<unknown>).identity)
        && Object.hasOwn(value, 'payload');
}

/** A worker's operation only sees its payload; replies and events always carry the original token. */
export function boardHandlers(handlers: Readonly<Record<string, BoardWorkerHandler>>): Record<string, BoardWorkerHandler> {
    const wrapped: Record<string, BoardWorkerHandler> = Object.create(null) as Record<string, BoardWorkerHandler>;
    for (const [name, handler] of Object.entries(handlers)) {
        wrapped[name] = async (args, context) => {
            if (!boardEnvelope(args)) throw new TypeError('Invalid board worker identity');
            const identity: BoardJobIdentity = { session: args.identity.session, epoch: args.identity.epoch, revision: args.identity.revision };
            const scoped: WorkerContext = {
                get cancelled() { return context.cancelled; },
                signal: context.signal,
                slice: () => context.slice(),
                heartbeat: () => context.heartbeat(),
                transfer: (...items) => context.transfer(...items),
                emit: (event, payload, transfer) => context.emit(event, { identity, payload }, transfer),
            };
            const payload = await handler(args.payload, scoped);
            return { identity, payload } satisfies BoardWorkerEnvelope<unknown>;
        };
    }
    return wrapped;
}

/** WorkerHost also calls this for results that arrive after cancellation or a deadline. */
export function closeWorkerResult(value: unknown): void {
    const pending: unknown[] = [value];
    const seen = new Set<object>();
    while (pending.length) {
        const next = pending.pop();
        if (!next || typeof next !== 'object' || seen.has(next)) continue;
        seen.add(next);
        if (typeof ImageBitmap !== 'undefined' && next instanceof ImageBitmap) { next.close(); continue; }
        if (typeof MessagePort !== 'undefined' && next instanceof MessagePort) { next.close(); continue; }
        if (next instanceof ArrayBuffer || ArrayBuffer.isView(next) || next instanceof Blob) continue;
        for (const key of Object.keys(next)) {
            const descriptor = Object.getOwnPropertyDescriptor(next, key);
            if (descriptor && 'value' in descriptor) pending.push(descriptor.value);
        }
    }
}
