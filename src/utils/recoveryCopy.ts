import type { RecoveryEntry } from './recoveryJournal';
import { loadChunk } from '../platform/chunkLoad';

type CopyData = string | Uint8Array | Blob;
export interface RecoveryMediaAsset {
    readonly id: string;
    readonly hash: string;
    readonly extension: string;
    readonly file: string | null;
    readonly blob: Blob;
}
type Serializer = (payload: unknown, signal: AbortSignal, mediaFiles?: ReadonlyMap<string, string>) => Promise<CopyData>;
type MediaGetter = (payload: unknown) => readonly RecoveryMediaAsset[];

const serializers = new Map<string, { serialize: Serializer; media?: MediaGetter }>();

export function registerRecoveryCopySerializer(kind: string, serialize: Serializer, media?: MediaGetter): () => void {
    const registration = { serialize, media };
    serializers.set(kind, registration);
    return () => { if (serializers.get(kind) === registration) serializers.delete(kind); };
}

export function recoveryCopyMedia(entry: Pick<RecoveryEntry, 'kind' | 'copy'>): readonly RecoveryMediaAsset[] {
    const copy = entry.copy;
    if (!copy || typeof copy !== 'object' || copy instanceof Uint8Array || copy instanceof Blob || copy.kind !== 'recipe') return [];
    return serializers.get(entry.kind)?.media?.(copy.payload) ?? [];
}

export async function materializeRecoveryCopy(entry: Pick<RecoveryEntry, 'kind' | 'copy'>,
    signal: AbortSignal, mediaFiles?: ReadonlyMap<string, string>): Promise<CopyData> {
    signal.throwIfAborted();
    const copy = entry.copy;
    if (typeof copy === 'string' || copy instanceof Uint8Array || copy instanceof Blob) return copy;
    if (!copy || copy.kind !== 'recipe') throw new Error('Invalid recovery copy');
    if (entry.kind === 'drawing' || entry.kind === 'notebook' || entry.kind === 'pdf') {
        await loadChunk(() => import('../whiteboard/host/recoveryCopy'));
        signal.throwIfAborted();
    }
    const registration = serializers.get(entry.kind);
    if (!registration) throw new Error(`No recovery copy serializer registered for ${entry.kind}`);
    const result = await registration.serialize(copy.payload, signal, mediaFiles);
    signal.throwIfAborted();
    if (typeof result !== 'string' && !(result instanceof Uint8Array) && !(result instanceof Blob)) {
        throw new Error('Invalid serialized recovery copy');
    }
    return result;
}
