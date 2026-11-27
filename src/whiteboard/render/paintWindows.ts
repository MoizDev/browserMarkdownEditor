import type { PaintBand } from './material';
import type { LivePaintFrame, PaintFrame, PaintFrameRoot, PaintItem, PaintSource } from './paintStream';

export const PAINT_WINDOW_ITEMS = 256;

export interface PaintWindow { readonly band: PaintBand; readonly items: readonly PaintItem[] }

export type PaintRoot = PaintFrameRoot;

export function rootOf(source: PaintSource): PaintRoot {
    const { underlay: _underlay, content: _content, windows: _windows, liveOnly: _liveOnly, ...root } =
        source as Partial<PaintFrame> & Partial<LivePaintFrame> & PaintFrameRoot;
    return root;
}

export class PaintWindowBuilder {
    private readonly windows: PaintWindow[] = [];
    private band: PaintBand = 'underlay';
    private items: PaintItem[] = [];
    push(band: PaintBand, item: PaintItem): void {
        if (band !== this.band || this.items.length === PAINT_WINDOW_ITEMS) {
            this.close();
            this.band = band;
        }
        this.items.push(item);
    }
    private close(): void {
        if (!this.items.length) return;
        this.windows.push(Object.freeze({ band: this.band, items: Object.freeze(this.items) }));
        this.items = [];
    }
    finish(): readonly PaintWindow[] {
        this.close();
        return Object.freeze(this.windows);
    }
}

export function windowsOf(frame: PaintFrame, include?: (item: PaintItem) => boolean): readonly PaintWindow[] {
    const builder = new PaintWindowBuilder();
    for (const item of frame.underlay) if (!include || include(item)) builder.push('underlay', item);
    for (const item of frame.content) if (!include || include(item)) builder.push('content', item);
    return builder.finish();
}

export function windowsOfSource(source: PaintSource): readonly PaintWindow[] {
    return source.liveOnly ? source.windows : windowsOf(source);
}

export function filterWindows(windows: readonly PaintWindow[], include: ((item: PaintItem) => boolean) | undefined): readonly PaintWindow[] {
    if (!include) return windows;
    const builder = new PaintWindowBuilder();
    for (const window of windows) for (const item of window.items) if (include(item)) builder.push(window.band, item);
    return builder.finish();
}

export function* paintItemsOf(source: PaintSource): Generator<PaintItem> {
    if (source.liveOnly) {
        for (const window of source.windows) yield* window.items;
        return;
    }
    yield* source.underlay;
    yield* source.content;
}

export function* bandItemsOf(windows: readonly PaintWindow[], band: PaintBand): Generator<PaintItem> {
    for (const window of windows) {
        if (window.band !== band) continue;
        yield* window.items;
    }
}

export const PAINT_REF_BYTES = 16;
export function refBytesOf(windows: readonly PaintWindow[]): number {
    let items = 0;
    for (const window of windows) items += window.items.length;
    return items * PAINT_REF_BYTES;
}
