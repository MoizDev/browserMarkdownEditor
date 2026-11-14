import type { Node, NodeBase, Point, ConnectorEnd } from '../../model/nodes';
import { ARROWHEADS, DASHES, FIGURE_SHAPES, FILLS, FONTS, H_ALIGNS, SIZES, SWATCHES, V_ALIGNS, type Size } from '../../model/styles';
import type { RichText } from '../../text/richText';
import { object } from './envelope';
import type { LegacyShape } from './common';

export type RichTextReader = (value: unknown, owner: string) => RichText;
function num(v: unknown, field: string): number {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`Invalid ${field}`);
    return v;
}
function str(v: unknown, field: string): string {
    if (typeof v !== 'string') throw new Error(`Invalid ${field}`);
    return v;
}
function bool(v: unknown, field: string): boolean {
    if (typeof v !== 'boolean') throw new Error(`Invalid ${field}`);
    return v;
}
function pick<T extends string>(v: unknown, options: readonly T[], field: string): T {
    if (typeof v !== 'string' || !options.includes(v as T)) throw new Error(`Unknown ${field}`);
    return v as T;
}
function point(v: unknown, field: string): Point {
    const p = object(v);
    if (!p) throw new Error(`Invalid ${field}`);
    return { x: num(p.x, `${field}.x`), y: num(p.y, `${field}.y`) };
}
function url(v: unknown): string | null { const s = str(v, 'URL'); return s || null; }
const WIDTHS: Readonly<Record<Size, number>> = { s: 2, m: 3.5, l: 5, xl: 10 };

// The caller supplies the rich reader once TX-2 is available; no plain-text flattening is allowed.
export function readLabelledShape(shape: LegacyShape, base: NodeBase, rich: RichTextReader,
    ends?: { readonly start: ConnectorEnd; readonly end: ConnectorEnd }): Node | null {
    const p = shape.props;
    switch (shape.type) {
        case 'geo': {
            const size = pick(p.size, SIZES, 'size'), scale = num(p.scale, 'scale');
            return { ...base, kind: 'figure', shape: pick(p.geo, FIGURE_SHAPES, 'figure'), w: num(p.w, 'width'),
                h: num(p.h, 'height'), growY: num(p.growY, 'growth'), color: pick(p.color, SWATCHES, 'colour'),
                labelColor: pick(p.labelColor, SWATCHES, 'label colour'), fill: pick(p.fill, FILLS, 'fill'),
                dash: pick(p.dash, DASHES.filter(d => d !== 'none'), 'dash'), size,
                font: pick(p.font, FONTS, 'font'), align: pick(p.align, H_ALIGNS, 'alignment'),
                valign: pick(p.verticalAlign, V_ALIGNS, 'vertical alignment'), label: rich(p.richText, shape.id),
                width: WIDTHS[size] * scale, labelScale: scale, flipX: false, flipY: false, url: url(p.url) };
        }
        case 'text': return { ...base, kind: 'text', text: rich(p.richText, shape.id),
            color: pick(p.color, SWATCHES, 'colour'), size: pick(p.size, SIZES, 'size'), font: pick(p.font, FONTS, 'font'),
            align: pick(p.textAlign, V_ALIGNS, 'alignment'), autoSize: bool(p.autoSize, 'auto-size'),
            w: num(p.w, 'width'), scale: num(p.scale, 'scale') };
        case 'note': return { ...base, kind: 'sticky', text: rich(p.richText, shape.id),
            color: pick(p.color, SWATCHES, 'colour'), labelColor: pick(p.labelColor, SWATCHES, 'label colour'),
            size: pick(p.size, SIZES, 'size'), font: pick(p.font, FONTS, 'font'),
            align: pick(p.align, H_ALIGNS, 'alignment'), valign: pick(p.verticalAlign, V_ALIGNS, 'vertical alignment'),
            growY: num(p.growY, 'growth'), fit: num(p.fontSizeAdjustment, 'font adjustment'),
            scale: num(p.scale, 'scale'), url: url(p.url) };
        case 'arrow': {
            const size = pick(p.size, SIZES, 'size'), scale = num(p.scale, 'scale');
            const start = ends?.start ?? { ...point(p.start, 'start'), attach: null };
            const end = ends?.end ?? { ...point(p.end, 'end'), attach: null };
            return { ...base, kind: 'connector', route: pick(p.kind, ['arc', 'elbow'] as const, 'route'),
                start, end, bend: num(p.bend, 'bend'), elbowMid: num(p.elbowMidPoint, 'elbow midpoint'),
                headStart: pick(p.arrowheadStart, ARROWHEADS, 'start head'), headEnd: pick(p.arrowheadEnd, ARROWHEADS, 'end head'),
                color: pick(p.color, SWATCHES, 'colour'), labelColor: pick(p.labelColor, SWATCHES, 'label colour'),
                fill: pick(p.fill, FILLS, 'fill'), dash: pick(p.dash, DASHES.filter(d => d !== 'none'), 'dash'),
                size, font: pick(p.font, FONTS, 'font'), label: rich(p.richText, shape.id),
                labelAt: num(p.labelPosition, 'label position'), width: WIDTHS[size] * scale, labelScale: scale };
        }
        default: return null;
    }
}
