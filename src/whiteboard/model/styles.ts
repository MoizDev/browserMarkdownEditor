import type { ExtBag } from './json';

// document-model.md §7, M-7: names persist; the scene packs their stable indices.
export const SWATCHES = [
    'black', 'grey', 'light-violet', 'violet', 'blue', 'light-blue', 'yellow',
    'orange', 'green', 'light-green', 'light-red', 'red', 'white',
] as const;
export type Swatch = typeof SWATCHES[number];

export const SWATCH_INDEX: Readonly<Record<Swatch, number>> = Object.freeze({
    black: 0, grey: 1, 'light-violet': 2, violet: 3, blue: 4, 'light-blue': 5,
    yellow: 6, orange: 7, green: 8, 'light-green': 9, 'light-red': 10, red: 11, white: 12,
});

export const SIZES = ['s', 'm', 'l', 'xl'] as const;
export type Size = typeof SIZES[number];
export const FONTS = ['draw', 'sans', 'serif', 'mono'] as const;
export type Font = typeof FONTS[number];
export const FILLS = ['none', 'semi', 'solid', 'pattern', 'fill', 'lined-fill'] as const;
export type Fill = typeof FILLS[number];
export const DASHES = ['draw', 'solid', 'dashed', 'dotted', 'none'] as const;
export type Dash = typeof DASHES[number];
export const H_ALIGNS = ['start', 'middle', 'end', 'start-legacy', 'middle-legacy', 'end-legacy'] as const;
export type HAlign = typeof H_ALIGNS[number];
export const V_ALIGNS = ['start', 'middle', 'end'] as const;
export type VAlign = typeof V_ALIGNS[number];
export type TextAlign = VAlign;
export const ARROWHEADS = ['none', 'arrow', 'triangle', 'square', 'dot', 'pipe', 'diamond', 'inverted', 'bar'] as const;
export type Arrowhead = typeof ARROWHEADS[number];
export const FIGURE_SHAPES = [
    'cloud', 'rectangle', 'ellipse', 'triangle', 'diamond', 'pentagon', 'hexagon',
    'octagon', 'star', 'rhombus', 'rhombus-2', 'oval', 'trapezoid', 'arrow-right',
    'arrow-left', 'arrow-up', 'arrow-down', 'x-box', 'check-box', 'heart',
] as const;
export type FigureShape = typeof FIGURE_SHAPES[number];

// 00-frame.md §1: engine tool names are independent of imported file vocabulary.
export const TOOLS = [
    'select', 'hand', 'pen', 'highlighter', 'eraser', 'laser', 'text', 'figure',
    'connector', 'polyline', 'frame', 'sticky', 'media',
] as const;
export type ToolId = typeof TOOLS[number];

export interface NextStyles {
    readonly color: Swatch;
    readonly fill: Fill;
    readonly dash: Dash;
    readonly size: Size;
    readonly font: Font;
    readonly align: HAlign;
    readonly textAlign: TextAlign;
    readonly valign: VAlign;
    readonly headStart: Arrowhead;
    readonly headEnd: Arrowhead;
    readonly route: 'arc' | 'elbow';
    readonly spline: 'line' | 'cubic';
    readonly highlighterColor: Swatch;
}

export interface UiBlock {
    readonly tool: ToolId;
    readonly next: NextStyles;
    readonly penWidth: number;
    readonly ext: ExtBag | null;
}
