import type { MediaEntry, MediaId } from '../model/media';

export type MediaHolder = 'document' | 'history' | 'clipboard';
interface StoredMedia {
    readonly blob: Blob;
    readonly holders: Map<MediaHolder, number>;
}
export interface MediaLease { release(): void }

// Bytes are session-owned, not attached to the DOM or to a view. Undo and the
// clipboard can outlive a node; only the last holder makes bytes evictable.
export class MediaStore {
    private readonly entries = new Map<MediaId, StoredMedia>();
    private readonly pending = new Map<MediaId, Map<MediaHolder, number>>();
    private idle: number | null = null;

    put(id: MediaId, blob: Blob): void {
        const previous = this.entries.get(id);
        if (previous) return;
        this.entries.set(id, { blob, holders: this.pending.get(id) ?? new Map() });
        this.pending.delete(id);
        this.schedule();
    }

    get(id: MediaId): Blob | undefined { return this.entries.get(id)?.blob; }

    retain(id: MediaId, holder: MediaHolder): MediaLease {
        let counts = this.entries.get(id)?.holders ?? this.pending.get(id);
        if (!counts) {
            counts = new Map();
            this.pending.set(id, counts);
        }
        counts.set(holder, (counts.get(holder) ?? 0) + 1);
        let active = true;
        return { release: () => {
            if (!active) return;
            active = false;
            const count = counts.get(holder) ?? 0;
            if (count <= 1) counts.delete(holder);
            else counts.set(holder, count - 1);
            if (!counts.size) {
                if (this.pending.get(id) === counts) this.pending.delete(id);
                this.schedule();
            }
        } };
    }

    // The host re-verifies disk bytes and streams only missing assets. Its
    // collision policy remains authoritative; this class never receives handles.
    async restoreReferenced(entries: Iterable<MediaEntry>, restore: (entry: MediaEntry, bytes: Blob) => Promise<void>, signal: AbortSignal): Promise<void> {
        for (const entry of entries) {
            signal.throwIfAborted();
            const bytes = this.get(entry.id);
            if (bytes) await restore(entry, bytes);
        }
        signal.throwIfAborted();
    }

    clear(): void {
        if (this.idle !== null) clearTimeout(this.idle);
        this.idle = null;
        this.entries.clear();
        this.pending.clear();
    }

    private schedule(): void {
        if (this.idle !== null) return;
        this.idle = globalThis.setTimeout(() => {
            this.idle = null;
            for (const [id, entry] of this.entries) if (!entry.holders.size) this.entries.delete(id);
        }, 0);
    }
}
