import type { WriterSource } from './protocol';

const STAGE_IDLE_MS = 30_000;
const HASH = /^[0-9a-f]{64}$/;

/** A staged native document owns all of its PDFium handles. */
export interface OwnedWriterStage {
    close(): void | Promise<void>;
}
export interface WriterStage<T extends OwnedWriterStage> {
    readonly session: string;
    readonly revision: number;
    readonly sourceFingerprint: string;
    readonly geometryEngine: WriterSource['geometryEngine'];
    readonly native: T;
}
type Slot<T extends OwnedWriterStage> = WriterStage<T> & { deadline: number; timer: ReturnType<typeof setTimeout> };

/** Worker-private, one-use stages. Failed, expired or cancelled assembly never
 * leaves mutable PDFium state available to another revision. */
export class WriterStageStore<T extends OwnedWriterStage> {
    private readonly entries = new Map<string, Slot<T>>();
    private closed = false;

    put(stage: WriterStage<T>): string {
        if (this.closed || this.entries.size >= 16 || !stage.session || !Number.isSafeInteger(stage.revision) || stage.revision < 0 ||
            !HASH.test(stage.sourceFingerprint) || !stage.geometryEngine.id || !stage.geometryEngine.build ||
            !Number.isSafeInteger(stage.geometryEngine.generation) || stage.geometryEngine.generation < 0) throw new Error('Invalid PDF writer stage');
        const id = crypto.randomUUID();
        const timer = setTimeout(() => { void this.discard(id).catch(() => {}); }, STAGE_IDLE_MS);
        this.entries.set(id, { ...stage, geometryEngine: { ...stage.geometryEngine }, deadline: Date.now() + STAGE_IDLE_MS, timer });
        return id;
    }

    /** Consuming removes the timer before yielding ownership to finish's finally. */
    async take(id: string, revision: number): Promise<WriterStage<T>> {
        const slot = this.entries.get(id);
        if (!slot || this.closed) throw new Error('PDF writer stage is missing or expired');
        this.entries.delete(id);
        clearTimeout(slot.timer);
        if (slot.deadline <= Date.now() || slot.revision !== revision) {
            await slot.native.close();
            throw new Error('PDF writer stage is expired or belongs to a different revision');
        }
        return slot;
    }

    async discard(id: string): Promise<void> {
        const slot = this.entries.get(id);
        if (!slot) return;
        this.entries.delete(id);
        clearTimeout(slot.timer);
        await slot.native.close();
    }

    async releaseSession(session: string): Promise<void> {
        const ids = [...this.entries].filter(([, stage]) => stage.session === session).map(([id]) => id);
        await Promise.allSettled(ids.map(id => this.discard(id)));
    }

    async dispose(): Promise<void> {
        this.closed = true;
        await Promise.allSettled([...this.entries.keys()].map(id => this.discard(id)));
    }
}
