import type { BoardWorkerClient } from '../workers/client';
import type { BoardJobIdentity } from '../workers/protocol';
import { BoardFonts, type FontKey } from './fonts';
import { BoardTextLayout } from './layout';
import type { Face, TextLayoutRequest, TextMeasurement, TextPaint } from './paint';

function layoutClass(request: TextLayoutRequest): string {
    let text = '', styles = 0;
    for (const block of request.text.blocks) {
        for (const run of block.runs) {
            text += run.text;
            styles |= (run.marks.b ? 1 : 0) | (run.marks.i ? 2 : 0) | (run.marks.code ? 4 : 0);
        }
    }
    const scripts = [/\p{Script=Latin}/u, /\p{Script=Arabic}/u, /\p{Script=Hebrew}/u, /\p{Script=Han}/u,
        /\p{Script=Devanagari}/u, /\p{Script=Thai}/u, /\p{Extended_Pictographic}/u];
    return JSON.stringify([request.style.font, styles, scripts.map(script => script.test(text))]);
}

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
    private readonly pending = new Map<string, AbortController>();
    private readonly unsubscribe: (() => void)[] = [];
    private readonly compatibleClasses = new Set<string>();
    private different = false;
    private epoch = 0;
    constructor(private readonly main: BoardTextLayout, private readonly fonts: BoardFonts, private readonly worker?: BoardWorkerClient, onFontArrival?: (key: FontKey) => void) {
        const changed = (key: FontKey) => { this.compatibleClasses.clear(); this.different = false; onFontArrival?.(key); };
        this.unsubscribe.push(fonts.subscribe((_epoch, key) => changed(key)));
        if (worker) this.unsubscribe.push(worker.on('fontEpoch', payload => {
            if (!payload || typeof payload !== 'object' || !('key' in payload)) return;
            const key = payload.key as Partial<FontKey> | null;
            if (!key || !['draw', 'sans', 'serif', 'mono'].includes(key.family ?? '') || typeof key.bold !== 'boolean' || typeof key.italic !== 'boolean') return;
            changed(key as FontKey);
        }));
    }
    /** Call on every vault/session switch, including a switch to a same-path document. */
    beginSession(): void {
        this.epoch++;
        this.versions.clear();
        for (const controller of this.pending.values()) controller.abort();
        this.pending.clear();
    }
    private next(node: string): number {
        this.pending.get(node)?.abort();
        this.pending.delete(node);
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
    async layoutBackground(node: string, request: TextLayoutRequest, identity: BoardJobIdentity, isCurrent: (identity: BoardJobIdentity) => boolean, signal?: AbortSignal): Promise<LayoutProduct | null> {
        const version = this.next(node), epoch = this.epoch;
        const controller = new AbortController();
        this.pending.set(node, controller);
        const abort = () => controller.abort();
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
        const current = () => !controller.signal.aborted && this.epoch === epoch && this.versions.get(node) === version && isCurrent(identity);
        try {
        let workerProduct: LayoutProduct | undefined;
        const kind = layoutClass(request);
        if (this.worker && !this.different) {
            try {
                const [, product] = await Promise.all([
                    this.main.prepare(request),
                    this.worker.request<LayoutProduct>('layout', request, identity, { priority: 2, signal: controller.signal }, current),
                ]);
                workerProduct = product;
            } catch {
                if (!current()) return null;
                this.different = true;
            }
        }
        if (!current()) return null;
        if (workerProduct && !this.compatibleClasses.has(kind)) {
            const mainProduct = this.onMain(request);
            if (!matches(mainProduct, workerProduct)) { this.different = true; return mainProduct; }
            this.compatibleClasses.add(kind);
        }
        if (workerProduct && !this.different) return workerProduct;
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        if (!current()) return null;
        await this.main.prepare(request).catch(() => {});
        if (!current()) return null;
        return this.onMain(request);
        } finally {
            if (this.pending.get(node) === controller) this.pending.delete(node);
            signal?.removeEventListener('abort', abort);
        }
    }
    dispose(): void { this.beginSession(); for (const unsubscribe of this.unsubscribe) unsubscribe(); }
}
