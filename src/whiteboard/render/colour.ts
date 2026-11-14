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

// The host chooses light for page/paper ink and the app theme for a whiteboard. This snapshot
// contains colours, not document edits: a new palette revision never changes geometry identity.
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
export function colourCss(colour: Rgba): string {
    return `rgba(${colour[0] * 255} ${colour[1] * 255} ${colour[2] * 255} / ${colour[3]})`;
}

// W3C source-over blend algebra in ENCODED sRGB, as required by rendering §5.2. The source
// already includes coverage; premultiply once. A caller-owned output avoids allocations in an
// image/mip loop. Multiply includes BOTH uncovered terms, including a transparent backdrop.
export function compositeColour(source: RgbaP, destination: RgbaP, blend: Blend, out: Float64Array, offset = 0): void {
    if (!Number.isInteger(offset) || offset < 0 || offset + 4 > out.length) throw new RangeError('Invalid colour output range');
    const sa = source[3], da = destination[3];
    for (let i = 0; i < 3; i++) out[offset + i] = blend === 'normal' ? source[i] + destination[i] * (1 - sa)
        : source[i] * (1 - da) + destination[i] * (1 - sa) + source[i] * destination[i];
    out[offset + 3] = sa + da * (1 - sa);
}
