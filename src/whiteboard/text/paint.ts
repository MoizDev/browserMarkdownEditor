import type { Rect } from '../../platform/types';
import type { Font, Swatch } from '../model/styles';
import type { RichText } from './richText';

/** All geometry is in block-local world units before the node transform, y down. */
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
    /** Canvas font at the 64px reference size, including fallback families. */
    readonly css: string;
    readonly size: number;
    readonly ascent: number;
    readonly descent: number;
    readonly xHeight: number;
}
/** A board-session table: face indices remain valid for the lifetime of the session. */
export interface FaceTable { readonly faces: readonly Face[] }
export interface PaintFragment {
    readonly text: string;
    readonly x: number;
    readonly width: number;
    readonly rtl: boolean;
    readonly face: number;
    readonly ink: InkRef;
    readonly systemFallback: boolean;
    /** Half-open UTF-16 range in the rich text's plain-text projection. */
    readonly src: readonly [number, number];
}
export interface PaintLine {
    readonly top: number;
    readonly bottom: number;
    readonly baseline: number;
    /** Left-to-right visual order; marker fragments are included. */
    readonly fragments: readonly PaintFragment[];
}
export interface TextPaint {
    readonly key: string;
    readonly fontEpoch: number;
    readonly box: { readonly w: number; readonly h: number };
    /** Conservative ink bounds, including the box and possible overhang. */
    readonly ink: Rect;
    readonly backgrounds: readonly PaintRect[];
    readonly lines: readonly PaintLine[];
    readonly decorations: readonly PaintRect[];
}

/** How to select a visual caret when an offset has more than one position. */
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
/** A grapheme's logical interval and its visual rectangle; RTL intervals still increase logically. */
export interface TextCluster {
    readonly src: readonly [number, number];
    readonly bounds: Rect;
    readonly rtl: boolean;
    readonly line: number;
}
export interface CaretLine {
    readonly top: number;
    readonly bottom: number;
    /** Visual left-to-right order, including separate positions at bidi boundaries. */
    readonly stops: readonly CaretStop[];
    readonly clusters: readonly TextCluster[];
}
export interface CaretIndex {
    readonly paintKey: string;
    readonly lines: readonly CaretLine[];
    /** Nearest grapheme boundary, choosing a line by y and then a stop by x. */
    hitTest(x: number, y: number): CaretStop;
    /** Resolve affinity at wraps and bidi boundaries; use paragraph-direction primary caret otherwise. */
    caret(position: CaretPosition): CaretStop;
    /** Selection boxes in visual order, including line-break extension where applicable. */
    selection(start: number, end: number): readonly Rect[];
    /** Character boxes for an EditContext UTF-16 range, one box per code unit. */
    characterBounds(start: number, end: number): readonly Rect[];
}

export interface TextPadding { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number }
export interface TextLayoutStyle {
    readonly font: Font;
    readonly size: number;
    readonly ink: InkRef;
    readonly align: 'start' | 'middle' | 'end';
    readonly verticalAlign: 'start' | 'middle' | 'end';
    readonly padding: TextPadding;
    /** Height reserved by the host; content can grow beyond it. */
    readonly minHeight: number;
    /** Overflow policy for a word wider than the available line. */
    readonly overflow: 'allow' | 'grapheme' | 'shrink';
}
export interface TextLayoutRequest {
    readonly text: RichText;
    /** Host-provided content revision, unique for distinct text in this session. */
    readonly revision: string;
    readonly style: TextLayoutStyle;
    /** Null means auto width, with breaks only at paragraph or explicit line breaks. */
    readonly width: number | null;
    /** The registry epoch at which measurements were made. */
    readonly fontEpoch: number;
}
export interface TextMeasurement {
    readonly box: { readonly w: number; readonly h: number };
    readonly ink: Rect;
    /** Natural content height including padding, before minHeight. */
    readonly requiredHeight: number;
    /** The actual font scale applied by the overflow policy. */
    readonly fontScale: number;
}
/** Synchronous layout on a document or worker canvas; no font loading or zoom is implicit. */
export interface TextLayoutEngine {
    readonly faceTable: FaceTable;
    measure(request: TextLayoutRequest): TextMeasurement;
    layout(request: TextLayoutRequest): TextPaint;
    /** Expensive prefix measurement is deferred until the node is edited. */
    caretIndex(request: TextLayoutRequest, paint: TextPaint): CaretIndex;
}
