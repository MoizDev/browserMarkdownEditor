import type { MediaLease, MediaStore } from '../media/store';
import type { MediaEntry } from '../model/media';
import type { MediaRestorePorts, PinnedMediaRestore } from './saveBuildTypes';

/** Snapshot retained bytes and filenames synchronously, before any save build awaits disk. */
export function createMediaRestorePin(store: MediaStore, ports: MediaRestorePorts): (revision: number) => PinnedMediaRestore {
    return revision => {
        if (!ports.isCurrent(revision)) throw new DOMException('Board revision changed', 'AbortError');
        const entries: Array<{ entry: MediaEntry; blob: Blob; lease: MediaLease }> = [];
        const seen = new Set<string>();
        try {
            for (const original of ports.referenced()) {
                if (seen.has(original.id)) continue;
                seen.add(original.id);
                const blob = store.get(original.id);
                if (!blob) continue;
                const lease = store.retain(original.id, 'document');
                entries.push({ entry: { ...original }, blob, lease });
            }
        } catch (error) { for (const item of entries) item.lease.release(); throw error; }
        let released = false;
        const current = (signal: AbortSignal) => {
            signal.throwIfAborted();
            if (released || !ports.isCurrent(revision)) throw new DOMException('Board revision changed', 'AbortError');
        };
        return {
            async restore(signal) {
                const changes: Array<{ id: MediaEntry['id']; expected: string | null; next: string | null }> = [];
                for (const { entry, blob } of entries) {
                    current(signal);
                    const name = await ports.restore(entry, blob, signal);
                    current(signal);
                    if (name !== entry.file) changes.push({ id: entry.id, expected: entry.file, next: name });
                }
                current(signal);
                if (!changes.length) return 'unchanged';
                if (!ports.updateFiles(changes, revision)) throw new DOMException('Board revision changed', 'AbortError');
                return 'changed';
            },
            release() {
                if (released) return;
                released = true;
                for (const item of entries) item.lease.release();
            },
        };
    };
}
