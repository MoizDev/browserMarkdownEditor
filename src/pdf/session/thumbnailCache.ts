import type { ByteLease } from '../../platform/render/gfx/api';
import { getPlatformRuntime } from '../../platform/render/platformRuntime';
import type { MemoryCacheHandle } from '../../platform/render/memoryGovernor';
import type { TileEmphasisArgs } from '../emphasis/types';
import type { PdfPoolDocument } from '../pool/types';

const RESERVATION = 160 * 160 * 4;
let serial = 0;
type Task = { page: number; controller: AbortController; release(): void };
export interface ThumbnailWorkQueue { running: Set<object>; wake(): void; setWake(listener: () => void): () => void }
export function createThumbnailWorkQueue(): ThumbnailWorkQueue {
    let listener = () => {};
    return { running: new Set(), wake: () => listener(), setWake(next) {
        listener = next;
        return () => { if (listener === next) listener = () => {}; };
    } };
}

/** One visible panel owns its 2D preview backing and its admitted decoded bytes. */
export class PdfThumbnailCache {
    private readonly cache: MemoryCacheHandle;
    private readonly canvases = new Map<number, HTMLCanvasElement>();
    private readonly entries = new Map<number, { canvas: HTMLCanvasElement; release(): void }>();
    private readonly tasks = new Map<number, Task>();
    private readonly failed = new Set<number>();
    private wanted: number[] = [];
    private live = 0;
    private disposed = false;
    private pumping = false;
    private noticePending = false;

    constructor(private readonly document: PdfPoolDocument, private readonly queue: ThumbnailWorkQueue,
        private readonly current: () => boolean, private readonly variant: (page: number) => TileEmphasisArgs,
        private readonly changed: () => void, private readonly notice: (message: string) => void) {
        const now = performance.now();
        this.cache = getPlatformRuntime().governor.register({ id: `pdf-thumbnails:${++serial}`, pool: 'cpu', kind: 'working',
            class: 'scene-cache', owner: document.token, hiddenAt: null, lastVisibleAt: now, lastUsedAt: now,
            memory: () => ({ live: this.live, retiring: 0 }), evict: bytes => this.evict(bytes) });
    }
    private valid(): boolean { return !this.disposed && !this.document.closed && this.current(); }
    private notify(message: string): void {
        if (this.noticePending) return;
        this.noticePending = true;
        queueMicrotask(() => { this.noticePending = false; if (this.valid()) this.notice(message); });
    }
    private release(lease: ByteLease): () => void {
        let held = true;
        return () => {
            if (!held) return;
            held = false; this.live -= lease.bytes; this.cache.release(lease);
        };
    }
    private drop(page: number): void {
        const entry = this.entries.get(page);
        if (!entry) return;
        this.entries.delete(page);
        entry.canvas.width = 0; entry.canvas.height = 0; entry.release();
    }
    private cancel(task: Task): void { task.controller.abort(); task.release(); }
    private evict(bytes: number): void {
        let remaining = bytes;
        for (const page of [...this.entries.keys()].reverse()) {
            if (remaining <= 0) break;
            this.failed.add(page); this.drop(page); remaining -= RESERVATION;
        }
        for (const task of this.tasks.values()) {
            if (remaining <= 0) break;
            if (!task.controller.signal.aborted) { this.failed.add(task.page); this.cancel(task); remaining -= RESERVATION; }
        }
        if (remaining < bytes) {
            this.notify('Some page thumbnails were cleared to free memory.');
            queueMicrotask(() => { if (this.valid()) this.changed(); });
        }
    }
    setWindow(pages: readonly number[]): void {
        if (!this.valid()) return;
        this.wanted = [...pages].slice(0, 10);
        const keep = new Set(this.wanted);
        for (const page of this.entries.keys()) if (!keep.has(page)) this.drop(page);
        for (const [page, task] of this.tasks) if (!keep.has(page)) this.cancel(task);
        let changed = false;
        for (const page of this.failed) if (!keep.has(page)) { this.failed.delete(page); changed = true; }
        if (changed) this.changed();
        this.pump();
    }
    attach(page: number, canvas: HTMLCanvasElement | null): void {
        if (canvas) this.canvases.set(page, canvas);
        else { this.canvases.delete(page); this.drop(page); }
        this.pump();
    }
    failures(): ReadonlySet<number> { return new Set(this.failed); }
    pump(): void {
        if (this.pumping || !this.valid()) return;
        this.pumping = true;
        try {
            for (const page of this.wanted) {
                if (this.queue.running.size >= 2) break;
                const canvas = this.canvases.get(page);
                if (!canvas || this.entries.has(page) || this.tasks.has(page) || this.failed.has(page)) continue;
                const lease = this.cache.reserve(RESERVATION);
                if (!lease) {
                    this.failed.add(page); this.notify('Page thumbnails are unavailable under memory pressure.'); this.changed();
                    break;
                }
                this.live += lease.bytes;
                const task: Task = { page, controller: new AbortController(), release: this.release(lease) };
                this.tasks.set(page, task); this.queue.running.add(task);
                void this.run(task, canvas);
            }
        } finally { this.pumping = false; }
    }
    private async run(task: Task, canvas: HTMLCanvasElement): Promise<void> {
        let bitmap: ImageBitmap | undefined, retained = false;
        try {
            const variant = this.variant(task.page);
            bitmap = await this.document.thumbnail(task.page, 160, { ...variant, annotations: true, forms: true, signal: task.controller.signal });
            if (!this.valid() || task.controller.signal.aborted || !this.wanted.includes(task.page) || this.canvases.get(task.page) !== canvas) return;
            if (bitmap.width < 1 || bitmap.height < 1 || bitmap.width > 160 || bitmap.height > 160) throw new Error('Invalid thumbnail dimensions');
            canvas.width = bitmap.width; canvas.height = bitmap.height;
            const context = canvas.getContext('2d');
            if (!context) throw new Error('Thumbnail canvas unavailable');
            context.drawImage(bitmap, 0, 0);
            this.entries.set(task.page, { canvas, release: task.release }); retained = true;
        } catch {
            if (this.valid() && !task.controller.signal.aborted && this.wanted.includes(task.page)) {
                canvas.width = 0; canvas.height = 0; this.failed.add(task.page);
                this.notify('A page thumbnail could not be rendered.'); this.changed();
            }
        } finally {
            bitmap?.close();
            if (!retained) task.release();
            if (this.tasks.get(task.page) === task) this.tasks.delete(task.page);
            this.queue.running.delete(task);
            this.queue.wake();
        }
    }
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const page of this.entries.keys()) this.drop(page);
        for (const task of this.tasks.values()) this.cancel(task);
        this.canvases.clear(); this.wanted = []; this.cache.close();
    }
}
