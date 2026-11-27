import type { Affine, PageDisplayItem } from '../../platform/types';
import type { TextMaterial } from '../render/material';
import type { FaceTable, TextPaint } from './paint';

export interface OutlineTextInput {
    readonly paint: TextPaint;
    readonly faces: FaceTable;
    readonly localToWorld: Affine;
}
export interface OutlineTextContext {
    readonly material: TextMaterial;
    readonly pageScale: number;
    readonly signal?: AbortSignal;
}
export type OutlineText = (input: OutlineTextInput, context: OutlineTextContext) => Promise<PageDisplayItem[]>;

export interface OutlineWorkerRequest extends OutlineTextInput {
    readonly material: TextMaterial;
    readonly pageScale: number;
}
export type OutlineWorkerReply = PageDisplayItem[];
export type OutlineWorkerOperation = 'textOutline';
