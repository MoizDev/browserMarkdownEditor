import type { LineCap, LineJoin, Rgba } from '../../platform/types';
import type { Blend } from './colour';
import { opacity, withOpacity } from './colour';

export const HIGHLIGHT_UNDERLAY_ALPHA = 0.82;
export const HIGHLIGHT_OVERLAY_ALPHA = 0.35;
export type PaintBand = 'underlay' | 'content';
export interface StrokeMaterial {
    readonly color: Rgba;
    readonly width: number;
    readonly cap: LineCap;
    readonly join: LineJoin;
    readonly miterLimit: number;
    readonly dash?: Readonly<{ array: readonly number[]; phase: number }>;
}
export interface PathMaterial {
    readonly fill?: Rgba;
    readonly stroke?: StrokeMaterial;
    readonly blend: Blend;
}
export interface InkMaterial {
    readonly color: Rgba;
    readonly blend: Blend;
}
export interface TextMaterial {
    /** Flattened line/fragments in visual order; one resolved colour per fragment. */
    readonly glyphs: readonly Rgba[];
    /** Parallel to TextPaint backgrounds/decorations; roles resolved separately from glyphs. */
    readonly backgrounds: readonly Rgba[];
    readonly decorations: readonly Rgba[];
    readonly blend: Blend;
}

// Ordinary node/group opacity is inherited per contribution, NOT an isolated group alpha.
// There is deliberately no second opacity multiplier in the path/ink consumer contract.
export function pathMaterial(fill: Rgba | undefined, stroke: StrokeMaterial | undefined, inheritedOpacity = 1, blend: Blend = 'normal'): PathMaterial {
    opacity(inheritedOpacity);
    if (stroke) {
        if (!Number.isFinite(stroke.width) || stroke.width < 0 || !Number.isFinite(stroke.miterLimit) || stroke.miterLimit <= 0) throw new RangeError('Invalid path stroke metrics');
        if (stroke.dash && (!Number.isFinite(stroke.dash.phase) || !stroke.dash.array.length || stroke.dash.array.length % 2
            || stroke.dash.array.some(value => !Number.isFinite(value) || value <= 0))) throw new RangeError('Invalid path dash pattern');
    }
    return Object.freeze({
        fill: fill ? withOpacity(fill, inheritedOpacity) : undefined,
        stroke: stroke ? Object.freeze({ ...stroke, color: withOpacity(stroke.color, inheritedOpacity),
            dash: stroke.dash ? Object.freeze({ array: Object.freeze([...stroke.dash.array]), phase: stroke.dash.phase }) : undefined }) : undefined,
        blend,
    });
}
export function inkMaterial(colour: Rgba, inheritedOpacity = 1, blend: Blend = 'normal'): InkMaterial {
    return Object.freeze({ color: withOpacity(colour, inheritedOpacity), blend });
}
export function highlighterMaterials(pigment: Rgba, inheritedOpacity = 1): Readonly<{ underlay: InkMaterial; overlay: InkMaterial }> {
    opacity(inheritedOpacity);
    return Object.freeze({
        underlay: inkMaterial(pigment, inheritedOpacity * HIGHLIGHT_UNDERLAY_ALPHA),
        overlay: inkMaterial(pigment, inheritedOpacity * HIGHLIGHT_OVERLAY_ALPHA),
    });
}
