import type { Affine, PageDisplayItem, Rgba } from '../../platform/types';
import type { FaceTable, InkRef, TextPaint } from './paint';

/** The export worker receives precisely the layout painted on screen. */
export interface OutlineTextInput {
    readonly paint: TextPaint;
    readonly faces: FaceTable;
    readonly localToWorld: Affine;
}
export interface OutlineTextContext {
    /** Resolves the final leaf colour, including inherited alpha. */
    resolveInk(ink: InkRef): Rgba;
    /** Target page units per world unit; raster fallback is 4× 72 dpi. */
    readonly pageScale: number;
    readonly signal?: AbortSignal;
}
/** Returns ordered block-local items; the caller applies localToWorld and clips once. */
export type OutlineText = (input: OutlineTextInput, context: OutlineTextContext) => Promise<PageDisplayItem[]>;
