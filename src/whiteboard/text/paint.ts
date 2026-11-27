import type { Rect } from '../../platform/types';
import type { Font, Swatch } from '../model/styles';
import type { RichText } from './richText';
import type { FontKey } from './fonts';

export interface InkRef {
    readonly swatch: Swatch;
    readonly role: 'text' | 'label' | 'link' | 'code';
}
export interface PaintRect {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
    readonly ink: InkRef;
}
export interface Face {
    readonly key: FontKey;
    readonly loaded: boolean;
    readonly css: string;
    readonly size: number;
    readonly ascent: number;
    readonly descent: number;
    readonly xHeight: number;
}
export interface FaceTable { readonly faces: readonly Face[] }
export interface PaintFragment {
    readonly text: string;
    readonly x: number;
    readonly width: number;
    readonly rtl: boolean;
    readonly face: number;
    readonly ink: InkRef;
    readonly systemFallback: boolean;
    readonly src: readonly [number, number];
}
export interface PaintLine {
    readonly top: number;
    readonly bottom: number;
    readonly baseline: number;
    readonly x: number;
    readonly src: readonly [number, number];
    readonly direction: 'ltr' | 'rtl';
    readonly fragments: readonly PaintFragment[];
}
export interface TextPaint {
    readonly key: string;
    readonly fontEpoch: number;
    readonly faceTable?: FaceTable;
    readonly box: { readonly w: number; readonly h: number };
    readonly ink: Rect;
    readonly backgrounds: readonly PaintRect[];
    readonly lines: readonly PaintLine[];
    readonly decorations: readonly PaintRect[];
}

export type CaretAffinity = 'upstream' | 'downstream';
export interface CaretPosition {
    readonly offset: number;
    readonly affinity?: CaretAffinity;
}
export interface CaretStop extends CaretPosition {
    readonly affinity: CaretAffinity;
    readonly x: number;
    readonly top: number;
    readonly bottom: number;
    readonly line: number;
}
export interface TextCluster {
    readonly src: readonly [number, number];
    readonly bounds: Rect;
    readonly rtl: boolean;
    readonly line: number;
}
export interface CaretLine {
    readonly top: number;
    readonly bottom: number;
    readonly stops: readonly CaretStop[];
    readonly clusters: readonly TextCluster[];
}
export interface CaretIndex {
    readonly paintKey: string;
    readonly lines: readonly CaretLine[];
    hitTest(x: number, y: number): CaretStop;
    caret(position: CaretPosition): CaretStop;
    clusterAt(x: number, y: number): TextCluster | null;
    selection(start: number, end: number, visible?: { readonly top: number; readonly bottom: number }): readonly Rect[];
    selectionBounds(start: number, end: number): Rect | null;
    forEachSelection(start: number, end: number, visit: (rect: Rect) => void): void;
    characterBounds(start: number, end: number): readonly Rect[];
    navigate?(position: CaretPosition, direction: 'left' | 'right' | 'up' | 'down' | 'line-start' | 'line-end', goalX?: number): CaretStop;
    navigateWord?(position: CaretPosition, direction: 'left' | 'right', boundary: number): CaretStop;
}

export interface TextPadding { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number }
export interface TextLayoutStyle {
    readonly font: Font;
    readonly size: number;
    readonly ink: InkRef;
    readonly align: 'start' | 'middle' | 'end';
    readonly verticalAlign: 'start' | 'middle' | 'end';
    readonly padding: TextPadding;
    readonly minHeight: number;
    readonly overflow: 'allow' | 'grapheme' | 'shrink';
    readonly maxLines?: number;
    readonly ellipsis?: boolean;
}
export interface TextLayoutRequest {
    readonly text: RichText;
    readonly revision: string;
    readonly style: TextLayoutStyle;
    readonly width: number | null;
    readonly fontEpoch: number;
}
export interface TextMeasurement {
    readonly box: { readonly w: number; readonly h: number };
    readonly ink: Rect;
    readonly requiredHeight: number;
    readonly fontScale: number;
}
export interface TextLayoutEngine {
    readonly faceTable: FaceTable;
    prepare(request: TextLayoutRequest): Promise<void>;
    measure(request: TextLayoutRequest): TextMeasurement;
    layout(request: TextLayoutRequest): TextPaint;
    caretIndex(request: TextLayoutRequest, paint: TextPaint): CaretIndex;
}
