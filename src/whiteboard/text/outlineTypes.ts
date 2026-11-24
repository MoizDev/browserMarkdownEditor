import type { Affine, PageDisplayItem } from '../../platform/types';
import type { TextMaterial } from '../render/material';
import type { FaceTable, TextPaint } from './paint';

/** The export worker receives precisely the layout painted on screen. */
export interface OutlineTextInput {
    readonly paint: TextPaint;
    readonly faces: FaceTable;
    readonly localToWorld: Affine;
}
export interface OutlineTextContext {
    /** Colours are resolved per glyph, background and decoration by the producer. */
    readonly material: TextMaterial;
    /** Target page units per world unit; raster fallback is 4× 72 dpi. */
    readonly pageScale: number;
    readonly signal?: AbortSignal;
}
/** Returns ordered block-local items; the caller applies localToWorld and clips once. */
export type OutlineText = (input: OutlineTextInput, context: OutlineTextContext) => Promise<PageDisplayItem[]>;

/** Serializable export-worker request and reply; cancellation travels in the worker envelope. */
export interface OutlineWorkerRequest extends OutlineTextInput {
    readonly material: TextMaterial;
    readonly pageScale: number;
}
export type OutlineWorkerReply = PageDisplayItem[];
/** Operation name inside workers/protocol.ts's identity envelope. */
export type OutlineWorkerOperation = 'textOutline';
