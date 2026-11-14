import { CaptureError, captureAbort } from './captureError';

interface CaptureJob {
    readonly paneId: string;
    readonly thumbnailKey: string | undefined;
    readonly signal: AbortSignal;
    readonly work: () => Promise<ImageBitmap>;
    readonly cancel: () => void;
    readonly resolve: (bitmap: ImageBitmap) => void;
    readonly reject: (error: unknown) => void;
    settled: boolean;
    running: boolean;
}

/** One App-owned queue shared by all pane capturers (§4.6). Aborting an active job
 * rejects its caller promptly, but keeps its slot until resource cleanup finishes.
 * A tile provider that is still unwinding cannot let a third capture exceed the cap.
 */
export class CaptureQueue {
    private readonly queued: CaptureJob[] = [];
    private readonly activePanes = new Set<string>();

    run(paneId: string, signal: AbortSignal, work: () => Promise<ImageBitmap>, thumbnailKey?: string): Promise<ImageBitmap> {
        if (signal.aborted) return Promise.reject(captureAbort(signal));
        return new Promise((resolve, reject) => {
            const job: CaptureJob = {
                paneId, thumbnailKey, signal, work, resolve, reject, settled: false, running: false,
                cancel: () => {
                    if (job.settled) return;
                    job.settled = true;
                    reject(captureAbort(signal));
                    if (!job.running) {
                        const index = this.queued.indexOf(job);
                        if (index >= 0) this.queued.splice(index, 1);
                        signal.removeEventListener('abort', job.cancel);
                        this.drain();
                    }
                },
            };
            if (thumbnailKey !== undefined) {
                for (let index = this.queued.length - 1; index >= 0; index--) {
                    const previous = this.queued[index];
                    if (previous.paneId !== paneId || previous.thumbnailKey !== thumbnailKey) continue;
                    this.queued.splice(index, 1);
                    previous.settled = true;
                    previous.signal.removeEventListener('abort', previous.cancel);
                    previous.reject(new CaptureError('superseded'));
                }
            }
            this.queued.push(job);
            signal.addEventListener('abort', job.cancel, { once: true });
            this.drain();
        });
    }

    private drain(): void {
        while (this.activePanes.size < 2) {
            const index = this.queued.findIndex(job => !this.activePanes.has(job.paneId));
            if (index < 0) return;
            const [job] = this.queued.splice(index, 1);
            if (job.signal.aborted) { job.cancel(); continue; }
            job.running = true;
            this.activePanes.add(job.paneId);
            void this.execute(job);
        }
    }

    private async execute(job: CaptureJob): Promise<void> {
        try {
            const bitmap = await job.work();
            if (job.settled || job.signal.aborted) {
                bitmap.close();
                if (!job.settled) { job.settled = true; job.reject(captureAbort(job.signal)); }
            } else {
                job.settled = true;
                job.resolve(bitmap);
            }
        } catch (error) {
            if (!job.settled) { job.settled = true; job.reject(error); }
        } finally {
            job.signal.removeEventListener('abort', job.cancel);
            this.activePanes.delete(job.paneId);
            this.drain();
        }
    }
}
