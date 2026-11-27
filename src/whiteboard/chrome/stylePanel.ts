import type { Rgba } from '../../platform/types';
import { styleGeometryMetrics } from '../geom/styleMetrics';
import type { Node } from '../model/nodes';
import type { NodeId } from '../model/ids';
import { SWATCHES, type Arrowhead, type Dash, type Fill, type FigureShape, type Font, type HAlign, type Size, type Swatch,
    type TextAlign, type VAlign } from '../model/styles';
import { colourCss, resolveSwatch, type PaintPalette } from '../render/colour';
import type { BoardSession } from '../session/BoardSession';
import { penSliderFromScale } from './penWidth';
import { selectedNodes, type BoardStyleCommands } from './styleCommands';

export const MIXED = 'mixed' as const;
export type Shared<T> = T | typeof MIXED | null;

export type StyleRow = 'colour' | 'opacity' | 'fill' | 'dash' | 'size' | 'width' | 'font' | 'textAlign' | 'labelAlign'
    | 'shape' | 'route' | 'heads' | 'spline';

const ROWS_BY_KIND: Readonly<Record<string, readonly StyleRow[]>> = {
    'stroke:pen': ['colour', 'dash', 'width'],
    'stroke:highlighter': ['colour', 'width'],
    figure: ['colour', 'fill', 'dash', 'size', 'font', 'labelAlign', 'shape'],
    text: ['colour', 'size', 'width', 'font', 'textAlign'],
    sticky: ['colour', 'size', 'width', 'font', 'labelAlign'],
    connector: ['colour', 'dash', 'size', 'font', 'route', 'heads'],
    polyline: ['colour', 'dash', 'size', 'spline'],
};

const ROWS_FOR_TOOL: Readonly<Record<string, readonly StyleRow[]>> = {
    select: ['colour', 'fill', 'dash', 'size'],
    pen: ['colour', 'width'],
    highlighter: ['colour', 'width'],
    text: ['colour', 'size', 'font', 'textAlign'],
    sticky: ['colour', 'size', 'font', 'labelAlign'],
    figure: ['colour', 'fill', 'dash', 'size', 'font', 'labelAlign', 'shape'],
    connector: ['colour', 'dash', 'size', 'font', 'route', 'heads'],
    polyline: ['colour', 'dash', 'size', 'spline'],
};

export function rowsForNode(node: Node): readonly StyleRow[] {
    if (node.kind === 'stroke') return ROWS_BY_KIND[node.tool === 'pen' ? 'stroke:pen' : 'stroke:highlighter'];
    return ROWS_BY_KIND[node.kind] ?? [];
}

export interface StylePanelModel {
    readonly rows: readonly StyleRow[];
    readonly colour: Shared<Swatch>;
    readonly swatches: readonly { readonly id: Swatch; readonly css: string }[];
    readonly nextColourCss: string;
    readonly indicatorOutline: string;
    readonly opacity: Shared<number>;
    readonly fill: Shared<Fill>;
    readonly dash: Shared<Dash>;
    readonly size: Shared<Size>;
    readonly font: Shared<Font>;
    readonly textAlign: Shared<TextAlign>;
    readonly labelAlign: Shared<HAlign>;
    readonly labelVAlign: Shared<VAlign>;
    readonly shape: Shared<FigureShape>;
    readonly route: Shared<'arc' | 'elbow'>;
    readonly headStart: Shared<Arrowhead>;
    readonly headEnd: Shared<Arrowhead>;
    readonly spline: Shared<'line' | 'cubic'>;
    readonly width: { readonly position: number; readonly mixed: boolean };
    readonly selection: boolean;
}

export function luminance(color: Rgba): number {
    const linear = (value: number) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    return 0.2126 * linear(color[0]) + 0.7152 * linear(color[1]) + 0.0722 * linear(color[2]);
}

export function indicatorOutline(pigment: Rgba, background: Rgba): string {
    const a = luminance(pigment), b = luminance(background);
    const black = Math.min((a + 0.05) / 0.05, (b + 0.05) / 0.05);
    const white = Math.min(1.05 / (a + 0.05), 1.05 / (b + 0.05));
    return black >= white ? '#000' : '#fff';
}

export function sharedValue<T>(values: readonly T[]): Shared<T> {
    if (!values.length) return null;
    return values.every(value => value === values[0]) ? values[0] : MIXED;
}

const ROW_ORDER: readonly StyleRow[] = ['colour', 'opacity', 'fill', 'dash', 'size', 'width', 'font', 'textAlign', 'labelAlign',
    'shape', 'route', 'heads', 'spline'];

export function stylePanelModel(
    session: BoardSession,
    commands: BoardStyleCommands,
    selection: readonly NodeId[],
    activeTool: string,
    variant: string | undefined,
    palette: PaintPalette,
    panelBackground: Rgba,
): StylePanelModel {
    const doc = session.doc, next = doc.ui.next;
    const nodes = selectedNodes(doc, selection);
    const selected = nodes.length > 0;
    const nodeRows = new Set<StyleRow>(nodes.flatMap(rowsForNode));
    const toolRows = new Set<StyleRow>(ROWS_FOR_TOOL[activeTool] ?? []);
    const rows = ROW_ORDER.filter(row => selected ? row === 'opacity' || nodeRows.has(row) : toolRows.has(row));
    const highlighter = activeTool === 'highlighter';
    const nextPigment = resolveSwatch(palette, highlighter ? next.highlighterColor : next.color, highlighter ? 'highlight' : 'stroke')!;
    const width = commands.currentWidthScale();
    const widthScale = width ?? styleGeometryMetrics.legacyEquivalent('stroke:pen', 's', doc.ui.penWidth);
    const figures = nodes.flatMap(node => node.kind === 'figure' ? [node] : []);
    const labelled = nodes.flatMap(node => node.kind === 'figure' || node.kind === 'sticky' ? [node] : []);
    const texts = nodes.flatMap(node => node.kind === 'text' ? [node] : []);
    const connectors = nodes.flatMap(node => node.kind === 'connector' ? [node] : []);
    const polylines = nodes.flatMap(node => node.kind === 'polyline' ? [node] : []);
    return {
        rows,
        colour: selected ? sharedValue(nodes.flatMap(node => 'color' in node && node.color !== null ? [node.color] : []))
            : commands.currentColor(),
        swatches: SWATCH_CHOICES.map(id => ({ id, css: colourCss(resolveSwatch(palette, id)!) })),
        nextColourCss: colourCss(nextPigment),
        indicatorOutline: indicatorOutline(nextPigment, panelBackground),
        opacity: selected ? sharedValue(nodes.map(node => node.opacity)) : null,
        fill: selected ? sharedValue(figures.map(node => node.fill)) : next.fill,
        dash: selected ? sharedValue(nodes.flatMap(node => 'dash' in node ? [node.dash] : [])) : next.dash,
        size: selected ? sharedValue(nodes.flatMap(node => 'size' in node ? [node.size] : [])) : next.size,
        font: selected ? sharedValue(nodes.flatMap(node => 'font' in node ? [node.font] : [])) : next.font,
        textAlign: selected ? sharedValue(texts.map(node => node.align)) : next.textAlign,
        labelAlign: selected ? sharedValue(labelled.map(node => node.align)) : next.align,
        labelVAlign: selected ? sharedValue(labelled.map(node => node.valign)) : next.valign,
        shape: selected ? sharedValue(figures.map(node => node.shape))
            : activeTool === 'figure' ? (variant as FigureShape | undefined) ?? 'rectangle' : null,
        route: selected ? sharedValue(connectors.map(node => node.route)) : next.route,
        headStart: selected ? sharedValue(connectors.map(node => node.headStart)) : next.headStart,
        headEnd: selected ? sharedValue(connectors.map(node => node.headEnd)) : next.headEnd,
        spline: selected ? sharedValue(polylines.map(node => node.spline)) : next.spline,
        width: { position: penSliderFromScale(widthScale), mixed: width === null },
        selection: selected,
    };
}

export const SWATCH_CHOICES: readonly Swatch[] = SWATCHES.filter(color => color !== 'white');
