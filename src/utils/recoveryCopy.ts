import type { RecoveryEntry } from './recoveryJournal';

type CopyData = string | Uint8Array | Blob;
type Serializer = (payload: unknown, signal: AbortSignal) => Promise<CopyData>;

// Registration belongs to the document kind, not a particular session: journal
// entries can outlive the session that captured them.
const serializers = new Map<string, { serialize: Serializer }>();

export function registerRecoveryCopySerializer(kind: string, serialize: Serializer): () => void {
    const registration = { serialize };
    serializers.set(kind, registration);
    return () => { if (serializers.get(kind) === registration) serializers.delete(kind); };
}

export async function materializeRecoveryCopy(entry: Pick<RecoveryEntry, 'kind' | 'copy'>,
    signal: AbortSignal): Promise<CopyData> {
    signal.throwIfAborted();
    const copy = entry.copy;
    if (typeof copy === 'string' || copy instanceof Uint8Array || copy instanceof Blob) return copy;
    if (!copy || copy.kind !== 'recipe') throw new Error('Invalid recovery copy');
    const registration = serializers.get(entry.kind);
    if (!registration) throw new Error(`No recovery copy serializer registered for ${entry.kind}`);
    const result = await registration.serialize(copy.payload, signal);
    signal.throwIfAborted();
    if (typeof result !== 'string' && !(result instanceof Uint8Array) && !(result instanceof Blob)) {
        throw new Error('Invalid serialized recovery copy');
    }
    return result;
}
