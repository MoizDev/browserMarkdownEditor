import type { BoardContentSource, BuildJob, SessionOwner } from './BoardSession';

export interface PinnedBoardBuild {
    readonly revision: number;
    build(signal: AbortSignal): Promise<Uint8Array | Blob>;
    release?(): void;
}

export function boardContentSource(owner: SessionOwner, snapshot: PinnedBoardBuild, onRelease: () => void): { source: BoardContentSource; release(): void } {
    if (!owner.documentId || !Number.isSafeInteger(owner.session) || owner.session < 1
        || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) {
        throw new RangeError('Invalid board content-source owner or revision');
    }
    const stableOwner = Object.freeze({ documentId: owner.documentId, session: owner.session });
    const revision = snapshot.revision;
    let refs = 1;
    const drop = () => {
        if (--refs !== 0) return;
        try { snapshot.release?.(); } finally { onRelease(); }
    };
    const retain = () => {
        if (refs === 0) throw new Error('Board source has been released');
        refs++;
        let held = true;
        return { release() { if (held) { held = false; drop(); } } };
    };
    const job: BuildJob = Object.freeze({
        kind: 'build', revision,
        run(signal: AbortSignal) {
            if (signal.aborted) return Promise.reject(new DOMException('Board build cancelled', 'AbortError'));
            let lease: ReturnType<typeof retain>;
            try { lease = retain(); }
            catch (error) { return Promise.reject(error); }
            try { return Promise.resolve(snapshot.build(signal)).finally(() => lease.release()); }
            catch (error) { lease.release(); return Promise.reject(error); }
        },
    });
    const source: BoardContentSource = Object.freeze({ kind: 'deferred', owner: stableOwner, revision, retain, read: () => job });
    let producer = true;
    return { source, release() { if (producer) { producer = false; drop(); } } };
}
