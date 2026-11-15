import type { PaintBand } from './material';
import type { LivePaintFrame, PaintFrame, PaintFrameRoot, PaintItem, PaintSource } from './paintStream';

/** Items per window. A window is the unit every prepared-paint consumer iterates: a published paint is an
 * ordered list of windows of at most this many items, so no consumer holds a whole-sheet item array of its
 * own. The bound is the consumer batch size (one draw or one GPU scan step), not a capacity limit. */
export const PAINT_WINDOW_ITEMS = 256;

/** One ordered, bounded slice of a single band of a prepared paint. */
export interface PaintWindow { readonly band: PaintBand; readonly items: readonly PaintItem[] }

/** Explicit root metadata of a prepared paint: the canonical token, revision, sensitive and ink sets of its
 * source. It carries no items; the items are only reachable through the windows. */
export type PaintRoot = PaintFrameRoot;

/** The root of any paint source: everything but its item representation. */
export function rootOf(source: PaintSource): PaintRoot {
    const { underlay: _underlay, content: _content, windows: _windows, liveOnly: _liveOnly, ...root } =
        source as Partial<PaintFrame> & Partial<LivePaintFrame> & PaintFrameRoot;
    return root;
}

/** Builds the ordered windows of a paint in canonical order: a window closes when it is full or the band changes,
 * so every underlay window precedes every content window. */
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

/** The windows of a canonical frame's two bands, in canonical order. An excluded item is skipped in place:
 * the windows then hold only what the consumer prepares, never a whole-frame copy of the excluded items. */
export function windowsOf(frame: PaintFrame, include?: (item: PaintItem) => boolean): readonly PaintWindow[] {
    const builder = new PaintWindowBuilder();
    for (const item of frame.underlay) if (!include || include(item)) builder.push('underlay', item);
    for (const item of frame.content) if (!include || include(item)) builder.push('content', item);
    return builder.finish();
}

/** The ordered windows of any paint source. A live frame already holds its windows; a full frame's windows are
 * built from its band arrays (legacy and readDocument paths keep those arrays by contract). */
export function windowsOfSource(source: PaintSource): readonly PaintWindow[] {
    return source.liveOnly ? source.windows : windowsOf(source);
}

/** The same windows with every item `include` rejects skipped in place; `undefined` keeps them as they are. */
export function filterWindows(windows: readonly PaintWindow[], include: ((item: PaintItem) => boolean) | undefined): readonly PaintWindow[] {
    if (!include) return windows;
    const builder = new PaintWindowBuilder();
    for (const window of windows) for (const item of window.items) if (include(item)) builder.push(window.band, item);
    return builder.finish();
}

/** Every item of a paint source in canonical draw order (underlay, then content). A live frame's windows are
 * walked one at a time; a full frame's arrays are walked in place. Nothing is copied into a new array. */
export function* paintItemsOf(source: PaintSource): Generator<PaintItem> {
    if (source.liveOnly) {
        for (const window of source.windows) yield* window.items;
        return;
    }
    yield* source.underlay;
    yield* source.content;
}

/** Every item of one band, in canonical order, across the windows; the iteration holds one window at a time. */
export function* bandItemsOf(windows: readonly PaintWindow[], band: PaintBand): Generator<PaintItem> {
    for (const window of windows) {
        if (window.band !== band) continue;
        yield* window.items;
    }
}
