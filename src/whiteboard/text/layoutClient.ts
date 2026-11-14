import type { WorkerClient } from '../../platform/workers';
import { BoardFonts } from './fonts';
import { BoardTextLayout } from './layout';
import type { Face, TextLayoutRequest, TextMeasurement, TextPaint } from './paint';

export interface LayoutProduct {
    readonly paint: TextPaint;
    readonly measurement: TextMeasurement;
    /** The particular append-only face table that owns this paint's indices. */
    readonly faces: readonly Face[];
}

function matches(a: LayoutProduct, b: LayoutProduct): boolean {
    if (a.paint.box.w !== b.paint.box.w || a.paint.box.h !== b.paint.box.h || a.paint.lines.length !== b.paint.lines.length) return false;
    for (let i = 0; i < a.paint.lines.length; i++) {
        const x = a.paint.lines[i], y = b.paint.lines[i];
        if (x.top !== y.top || x.bottom !== y.bottom || x.baseline !== y.baseline || x.fragments.length !== y.fragments.length) return false;
        for (let j = 0; j < x.fragments.length; j++) {
            const f = x.fragments[j], g = y.fragments[j], ff = a.faces[f.face], gf = b.faces[g.face];
            if (!ff || !gf || ff.css !== gf.css || ff.size !== gf.size || f.text !== g.text || f.rtl !== g.rtl || f.systemFallback !== g.systemFallback || f.x !== g.x || f.width !== g.width || f.src[0] !== g.src[0] || f.src[1] !== g.src[1]) return false;
        }
    }
    return true;
}

/**
 * The worker is shared with parsing. Session/revision guards reject replies after an edit or
 * vault switch; an unsupported, failed or discrepant worker falls back to main-thread layout.
 */
export class TextLayoutClient {
    private readonly versions = new Map<string, number>();
    private readonly unsubscribe: (() => void)[] = [];
    private compatibility: 'unknown' | 'matching' | 'different' = 'unknown';
    private epoch = 0;
    constructor(private readonly main: BoardTextLayout, private readonly fonts: BoardFonts, private readonly worker?: WorkerClient, onFontArrival?: () => void) {
        const changed = () => { this.compatibility = 'unknown'; onFontArrival?.(); };
        this.unsubscribe.push(fonts.subscribe(changed));
        if (worker) this.unsubscribe.push(worker.on('fontEpoch', changed));
    }
    /** Call on every vault/session switch, including a switch to a same-path document. */
    beginSession(): void { this.epoch++; this.versions.clear(); }
    private next(node: string): number {
        const version = (this.versions.get(node) ?? 0) + 1;
        this.versions.set(node, version);
        return version;
    }
    private onMain(request: TextLayoutRequest): LayoutProduct {
        const resolved = { ...request, fontEpoch: this.fonts.epoch };
        const paint = this.main.layout(resolved);
        return { paint, measurement: this.main.measure(resolved), faces: this.main.faceTable.faces };
    }
    /** Edited or immediately visible content never waits on a queued open-time job. */
    layoutNow(node: string, request: TextLayoutRequest): LayoutProduct {
        this.next(node);
        void this.main.prepare(request).catch(() => {});
        return this.onMain(request);
    }
    async layoutBackground(node: string, request: TextLayoutRequest, signal?: AbortSignal): Promise<LayoutProduct | null> {
        const version = this.next(node), epoch = this.epoch;
        const current = () => !signal?.aborted && this.epoch === epoch && this.versions.get(node) === version;
        let workerProduct: LayoutProduct | undefined;
        if (this.worker && this.compatibility !== 'different') {
            try {
                const [, product] = await Promise.all([
                    this.main.prepare(request),
                    this.worker.request<LayoutProduct>('layout', request, { priority: 2, signal }),
                ]);
                workerProduct = product;
            } catch {
                if (!current()) return null;
                this.compatibility = 'different';
            }
        }
        if (!current()) return null;
        if (workerProduct && this.compatibility === 'unknown') {
            const mainProduct = this.onMain(request);
            this.compatibility = matches(mainProduct, workerProduct) ? 'matching' : 'different';
            if (this.compatibility === 'different') return mainProduct;
        }
        if (workerProduct && this.compatibility === 'matching') return workerProduct;
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        if (!current()) return null;
        await this.main.prepare(request).catch(() => {});
        if (!current()) return null;
        return this.onMain(request);
    }
    dispose(): void { this.beginSession(); for (const unsubscribe of this.unsubscribe) unsubscribe(); }
}
