import type { Rgba } from '../../platform/types';
import type { DisplayPdfWriter } from './capturePdf';
import type { PinExportSnapshot } from './snapshot';
import { exportSnapshotPdf, exportSnapshotPng, exportSnapshotSvg, type SnapshotExportBounds } from './snapshotExport';

/** Per-pane cancellation only; all capture work remains on the canonical Scene/export workers. */
export class BoardExportCoordinator {
    private active: AbortController | null = null;
    private disposed = false;
    constructor(private readonly pin: PinExportSnapshot) {}

    private begin<T>(external: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
        if (this.disposed) return Promise.reject(new DOMException('Export owner ended', 'AbortError'));
        this.cancel();
        if (external.aborted) return Promise.reject(external.reason ?? new DOMException('Export cancelled', 'AbortError'));
        const controller = new AbortController();
        this.active = controller;
        const signal = AbortSignal.any([external, controller.signal]);
        // Calling work synchronously is essential: each export takes its C7 pin before the first await.
        try {
            const pending = work(signal);
            return pending.finally(() => { if (this.active === controller) this.active = null; });
        } catch (error) {
            if (this.active === controller) this.active = null;
            return Promise.reject(error);
        }
    }

    png(bounds: SnapshotExportBounds, signal: AbortSignal, options: { background?: string; clipboard?: boolean } = {}): Promise<Blob> {
        return this.begin(signal, active => exportSnapshotPng(this.pin, bounds, active, options));
    }
    svg(bounds: SnapshotExportBounds, signal: AbortSignal, background?: Rgba): Promise<Blob> {
        return this.begin(signal, active => exportSnapshotSvg(this.pin, bounds, active, background));
    }
    pdf(bounds: SnapshotExportBounds, writer: DisplayPdfWriter, signal: AbortSignal): Promise<Blob> {
        return this.begin(signal, active => exportSnapshotPdf(this.pin, bounds, writer, active));
    }
    cancel(): void {
        const active = this.active;
        this.active = null;
        active?.abort(new DOMException('Export superseded', 'AbortError'));
    }
    dispose(): void { if (!this.disposed) { this.disposed = true; this.cancel(); } }
}
