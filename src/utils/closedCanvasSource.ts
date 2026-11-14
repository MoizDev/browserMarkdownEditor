import type { FileSystemContextValue } from '../types';
import type { RenderToken } from '../platform/render/types';
import { createJobAuthority, type JobAuthority } from '../whiteboard/security/admission';
import { hashBytes, sameStat, type DiskVersion } from './diskVersion';
import type { ContentSource, SourceOwner } from './documentBuffers';
import type { DocumentSessionStore, SessionAdapter, SessionEntry } from './documentSessions';
import type { createClosedCanvasVersions } from './closedCanvasVersions';

export interface ClosedCanvasSourceLease {
    readonly bytes: Blob;
    readonly token: RenderToken;
    readonly diskRevision: number;
    readonly authority: JobAuthority;
    readonly signal: AbortSignal;
    isCurrent(): boolean;
    assertBaseline(signal: AbortSignal): Promise<void>;
    release(): Promise<void>;
}

/** A C5 projection owns only this immutable read lease, never an editable board. */
export async function acquireClosedCanvasSource(options: {
    readonly root: FileSystemDirectoryHandle;
    readonly activation: number;
    readonly path: string;
    readonly handle: FileSystemFileHandle;
    readonly kind: 'drawing' | 'notebook';
    readonly signal: AbortSignal;
    readonly documentId: string;
    readonly sessions: DocumentSessionStore;
    readonly versions: ReturnType<typeof createClosedCanvasVersions>;
    readonly io: Pick<FileSystemContextValue, 'readFileSnapshot' | 'verifyVaultFileIdentity' | 'statFile' | 'handleIO'>;
    isCurrent(): boolean;
}): Promise<ClosedCanvasSourceLease> {
    const { root, activation, path, handle, signal, sessions, io } = options;
    const guard = () => {
        signal.throwIfAborted();
        if (!options.isCurrent()) throw new DOMException('Closed canvas source changed', 'AbortError');
    };
    guard();
    const lock = await options.versions.acquire(root, activation, path, signal);
    let transferred = false;
    try {
        guard();
        if (!await io.verifyVaultFileIdentity(root, path, handle)) throw new DOMException('Closed canvas entry changed', 'AbortError');
        guard();
        const snapshot = await io.readFileSnapshot(handle, signal);
        let bytes: Blob, version: DiskVersion;
        try {
            const data = await snapshot.blob.arrayBuffer();
            guard();
            const hash = await hashBytes(data);
            guard();
            const fingerprint = await snapshot.fingerprint(signal);
            guard();
            if (hash !== fingerprint.hash || data.byteLength !== fingerprint.size) throw new DOMException('Closed canvas bytes changed', 'AbortError');
            version = fingerprint;
            bytes = new Blob([data]);
        } finally { snapshot.dispose(); }
        const assertBaseline = async (requestSignal: AbortSignal) => {
            requestSignal.throwIfAborted(); guard();
            if (!await io.verifyVaultFileIdentity(root, path, handle)) throw new DOMException('Closed canvas entry changed', 'AbortError');
            guard(); requestSignal.throwIfAborted();
            const fresh = await io.readFileSnapshot(handle, requestSignal);
            try {
                const current = await fresh.fingerprint(requestSignal);
                guard(); requestSignal.throwIfAborted();
                if (!sameStat(version, current) || version.hash !== current.hash
                    || !await io.verifyVaultFileIdentity(root, path, handle) || !sameStat(version, await io.statFile(handle))) {
                    throw new DOMException('Closed canvas baseline changed', 'AbortError');
                }
                guard(); requestSignal.throwIfAborted();
            } finally { fresh.dispose(); }
        };
        await assertBaseline(signal);
        const diskRevision = await lock.observe(handle, version, io.handleIO.sameEntry, options.isCurrent);
        guard();
        if (sessions.get(options.documentId)) throw new Error('Closed canvas owner id is already in use');
        let entry!: SessionEntry<SnapshotAdapter>;
        type SnapshotAdapter = SessionAdapter & { readonly authority: JobAuthority; revoke(): void };
        entry = sessions.ensure(options.documentId, options.kind, 0, (owner: SourceOwner): SnapshotAdapter => {
            const authority = createJobAuthority(`${owner.documentId}:${owner.session}`, activation, 0);
            let live = true;
            const listeners = new Set<(source: ContentSource) => void>();
            const source: ContentSource = Object.freeze({ kind: 'deferred', owner, revision: 0,
                read: () => { if (!live) throw new DOMException('Closed canvas source released', 'AbortError'); return bytes; } });
            return {
                authority,
                revoke() { authority.dispose(); },
                hasPendingEdits: () => false,
                checkpoint: () => { if (!live) throw new DOMException('Closed canvas source released', 'AbortError'); return source; },
                acknowledge: () => { throw new Error('A read-only snapshot cannot acknowledge writes'); },
                onChange(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
                async dispose() {
                    authority.dispose();
                    try { await authority.drain(); } finally { live = false; listeners.clear(); lock.release(); }
                },
            };
        });
        transferred = true;
        const token: RenderToken = Object.freeze({ vaultEpoch: activation, documentId: entry.documentId,
            session: entry.serial, bytesGeneration: entry.bytesGeneration });
        const isCurrent = () => !signal.aborted && options.isCurrent() && sessions.get(entry.documentId) === entry
            && entry.bytesGeneration === token.bytesGeneration;
        let released: Promise<void> | undefined;
        return { bytes, token, diskRevision, authority: entry.adapter.authority, signal, isCurrent,
            async assertBaseline(requestSignal) { if (!isCurrent()) throw new DOMException('Closed canvas owner changed', 'AbortError');
                await assertBaseline(requestSignal); if (!isCurrent()) throw new DOMException('Closed canvas owner changed', 'AbortError'); },
            release() {
                if (!released) released = (async () => {
                    entry.adapter.revoke();
                    await entry.adapter.authority.drain();
                    if (sessions.get(entry.documentId) === entry) sessions.release(entry.documentId, 'kind-change');
                    await sessions.settled(entry.documentId);
                })();
                return released;
            },
        };
    } finally { if (!transferred) lock.release(); }
}
