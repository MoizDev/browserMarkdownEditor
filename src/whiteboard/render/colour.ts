import type { Rgba } from '../../platform/types';
import type { RgbaP } from '../../platform/render/gfx/api';
import type { Fill, Swatch } from '../model/styles';

export type Blend = 'normal' | 'multiply';
export type SwatchColours = Readonly<Record<Swatch, Rgba>>;
export interface PaintPalette {
    readonly revision: number;
    readonly stroke: SwatchColours;
    readonly highlight: SwatchColours;
    readonly fills: Readonly<Partial<Record<Exclude<Fill, 'none'>, SwatchColours>>>;
    readonly background: Rgba;
}

export function resolveSwatch(palette: PaintPalette, swatch: Swatch, role: 'stroke' | 'highlight' | Fill = 'stroke'): Rgba | undefined {
    if (role === 'none') return undefined;
    const colour = role === 'stroke' ? palette.stroke[swatch] : role === 'highlight' ? palette.highlight[swatch] : palette.fills[role]?.[swatch];
    if (!colour) throw new RangeError(`Palette does not define ${role}/${swatch}`);
    return colour;
}
export function rgba(r: number, g: number, b: number, a = 1): Rgba {
    if (![r, g, b, a].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) throw new RangeError('Expected straight encoded-sRGB channels in [0,1]');
    return Object.freeze([r, g, b, a]);
}
export function opacity(value: number): number {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError('Expected opacity in [0,1]');
    return value;
}
export function withOpacity(colour: Rgba, inheritedOpacity: number): Rgba {
    return rgba(colour[0], colour[1], colour[2], colour[3] * opacity(inheritedOpacity));
}
export function premultiplyColour(colour: Rgba, coverage = 1): RgbaP {
    const alpha = colour[3] * opacity(coverage);
    return Object.freeze([colour[0] * alpha, colour[1] * alpha, colour[2] * alpha, alpha]);
}
function relativeLuminance(colour: Rgba): number {
    const linear = (channel: number) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    return 0.2126 * linear(colour[0]) + 0.7152 * linear(colour[1]) + 0.0722 * linear(colour[2]);
}
function contrastRatio(a: Rgba, b: Rgba): number {
    const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
    return (light + 0.05) / (dark + 0.05);
}
const INK_BLACK = rgba(0, 0, 0), INK_WHITE = rgba(1, 1, 1);
export const LABEL_MIN_CONTRAST = 4.5;
export function legibleInk(backdrop: Rgba, ink: Rgba): Rgba {
    if (contrastRatio(backdrop, ink) >= LABEL_MIN_CONTRAST) return ink;
    return contrastRatio(backdrop, INK_BLACK) >= contrastRatio(backdrop, INK_WHITE) ? INK_BLACK : INK_WHITE;
}
export function colourCss(colour: Rgba): string {
    return `rgba(${colour[0] * 255} ${colour[1] * 255} ${colour[2] * 255} / ${colour[3]})`;
}

export function compositeColour(source: RgbaP, destination: RgbaP, blend: Blend, out: Float64Array, offset = 0): void {
    if (!Number.isInteger(offset) || offset < 0 || offset + 4 > out.length) throw new RangeError('Invalid colour output range');
    const sa = source[3], da = destination[3];
    for (let i = 0; i < 3; i++) out[offset + i] = blend === 'normal' ? source[i] + destination[i] * (1 - sa)
        : source[i] * (1 - da) + destination[i] * (1 - sa) + source[i] * destination[i];
    out[offset + 3] = sa + da * (1 - sa);
}
