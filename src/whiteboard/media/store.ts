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
    private readonly locations = new Map<MediaId, string | null>();
    private idle: ReturnType<typeof setTimeout> | null = null;

    put(id: MediaId, blob: Blob): void {
        const previous = this.entries.get(id);
        if (previous) return;
        this.entries.set(id, { blob, holders: this.pending.get(id) ?? new Map() });
        this.pending.delete(id);
        this.schedule();
    }

    get(id: MediaId): Blob | undefined { return this.entries.get(id)?.blob; }

    currentFile(id: MediaId): string | null | undefined { return this.locations.get(id); }

    setFile(id: MediaId, file: string | null): void {
        if (file !== null && (!file || file === '.' || file === '..' || file.length > 255 || /[\\/\0]/.test(file))) {
            throw new Error('Invalid stored media name');
        }
        this.locations.set(id, file);
    }

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
    async restoreReferenced(entries: Iterable<MediaEntry>, restore: (entry: MediaEntry, bytes: Blob) => Promise<string | null>,
        updateFile: (id: MediaId, file: string | null) => void, signal: AbortSignal): Promise<void> {
        for (const entry of Array.from(entries)) {
            signal.throwIfAborted();
            const bytes = this.get(entry.id);
            if (!bytes) continue;
            const file = await restore(entry, bytes);
            signal.throwIfAborted();
            if (file !== null && (!file || file === '.' || file === '..' || file.length > 255 || /[\\/\0]/.test(file))) {
                throw new Error('Invalid stored media name');
            }
            if (entry.file !== file) updateFile(entry.id, file);
            this.setFile(entry.id, file);
        }
        signal.throwIfAborted();
    }

    clear(): void {
        if (this.idle !== null) clearTimeout(this.idle);
        this.idle = null;
        this.entries.clear();
        this.pending.clear();
        this.locations.clear();
    }

    private schedule(): void {
        if (this.idle !== null) return;
        this.idle = globalThis.setTimeout(() => {
            this.idle = null;
            for (const [id, entry] of this.entries) if (!entry.holders.size) this.entries.delete(id);
        }, 0);
    }
}
