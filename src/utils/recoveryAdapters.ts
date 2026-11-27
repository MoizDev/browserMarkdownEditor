import type { SessionAdapter } from './documentSessions';

const adapters = new Map<string, SessionAdapter>();
export function bindRecoveryAdapter(documentId: string, adapter: SessionAdapter): () => void {
    adapters.set(documentId, adapter);
    return () => { if (adapters.get(documentId) === adapter) adapters.delete(documentId); };
}
export function recoveryAdapter(documentId: string): SessionAdapter | undefined { return adapters.get(documentId); }
