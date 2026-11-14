import type { Affine, PathCommand, Rgba } from '../../platform/types';
import { figureHatch, pathCommands, type FigureGeometry, type PositionedFigureText } from '../geom/providers';
import type { InkCoverage } from '../ink/outline';
import type { MediaEntry } from '../model/media';
import type { Node, StrokeNode } from '../model/nodes';
import type { FaceTable } from '../text/paint';
import { resolveSwatch, type PaintPalette } from './colour';
import { highlighterMaterials, inkMaterial, pathMaterial } from './material';
import type { PaintClip, PaintImageItem, PaintItem, PaintNode, PaintPathItem, PaintTextItem } from './paintStream';
import type { SceneResolveContext } from './sceneSource';
import { textPaintMaterial } from './textGeometry';
import type { BoardVectorGeometry } from './vectorGeometry';

function translated(matrix: Affine, x: number, y: number, scale = 1): Affine {
    return [matrix[0] * scale, matrix[1] * scale, matrix[2] * scale, matrix[3] * scale,
        matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]];
}
function rectangle(w: number, h: number): readonly PathCommand[] {
    return [['M', 0, 0], ['L', w, 0], ['L', w, h], ['L', 0, h], ['Z']];
}
function textItem(node: Readonly<Node>, geometryKey: string, label: PositionedFigureText, index: number,
    context: SceneResolveContext, palette: PaintPalette, faces: FaceTable): PaintTextItem {
    return { kind: 'text', key: `${node.id}:text:${index}:${palette.revision}`, nodeId: node.id, geometryKey: `${geometryKey}:text:${label.paint.key}`,
        localToWorld: translated(context.world, label.x, label.y, label.scale ?? 1), clips: context.clips,
        paint: label.paint, faces, material: textPaintMaterial(label.paint, palette, context.opacity) };
}

/** A canonical stroke is one item in each prescribed band. All chunk coverage is
 * unioned by the backend before applying colour, including overlapping chunks. */
export function paintStrokeNode(node: Readonly<StrokeNode>, coverage: readonly InkCoverage[], geometryKey: string,
    context: SceneResolveContext, palette: PaintPalette): PaintNode {
    const base = { kind: 'ink' as const, key: `${node.id}:${palette.revision}`, nodeId: node.id, geometryKey,
        localToWorld: context.world, clips: context.clips, coverage };
    if (node.tool === 'highlighter') {
        const material = highlighterMaterials(resolveSwatch(palette, node.color, 'highlight')!, context.opacity);
        return { underlay: [{ ...base, key: `${base.key}:underlay`, material: material.underlay }],
            content: [{ ...base, key: `${base.key}:overlay`, material: material.overlay }] };
    }
    return { content: [{ ...base, material: inkMaterial(resolveSwatch(palette, node.color)!, context.opacity) }] };
}

/** Geometry has already resolved draw/dash/crop contours. Paint only assigns
 * material roles, inherited alpha and the captured world/clip transforms. */
export async function paintVectorNode(node: Readonly<Node>, geometry: BoardVectorGeometry,
    context: SceneResolveContext, palette: PaintPalette, faces: FaceTable, options: {
        readonly media?: MediaEntry;
        readonly signal: AbortSignal;
        readonly cooperate?: () => Promise<void>;
    }): Promise<PaintNode> {
    const content: PaintItem[] = [], color = 'color' in node && node.color !== null ? node.color : 'grey';
    const base = { nodeId: node.id, geometryKey: geometry.key, localToWorld: context.world, clips: context.clips };
    let index = 0;
    const path = (d: readonly PathCommand[], width: number, fill: Parameters<typeof pathMaterial>[0], stroke = color,
        clips: readonly PaintClip[] = context.clips, strokeColour?: Rgba): PaintPathItem => ({ ...base, kind: 'path', key: `${node.id}:path:${index++}:${palette.revision}`,
        clips, d, fillRule: 'nonzero', material: pathMaterial(fill, width > 0 ? { color: strokeColour ?? resolveSwatch(palette, stroke)!, width,
            cap: 'round', join: 'round', miterLimit: 4 } : undefined, context.opacity) });
    const isImage = node.kind === 'picture' || node.kind === 'clip';
    if (isImage && node.media && options.media) {
        const media = options.media, crop = node.kind === 'picture' ? node.crop : null;
        const flipX = node.kind === 'picture' && node.flipX, flipY = node.kind === 'picture' && node.flipY;
        const imageWorld: Affine = [context.world[0] * (flipX ? -1 : 1), context.world[1] * (flipX ? -1 : 1),
            context.world[2] * (flipY ? -1 : 1), context.world[3] * (flipY ? -1 : 1),
            context.world[4] + (flipX ? context.world[0] * node.w : 0) + (flipY ? context.world[2] * node.h : 0),
            context.world[5] + (flipX ? context.world[1] * node.w : 0) + (flipY ? context.world[3] * node.h : 0)];
        let clips = context.clips;
        if (crop?.circle && geometry.attachments) clips = [...clips, { key: `${geometry.key}:crop`,
            d: [...pathCommands(geometry.attachments.outline)], fillRule: 'nonzero', localToWorld: context.world }];
        const image: PaintImageItem = { ...base, kind: 'image', key: `${node.id}:image:${node.media}`, imageKey: node.media,
            localToWorld: imageWorld, clips, rect: { x: 0, y: 0, width: node.w, height: node.h },
            ...(crop ? { sourceRect: { x: crop.x0 * media.w, y: crop.y0 * media.h,
                width: (crop.x1 - crop.x0) * media.w, height: (crop.y1 - crop.y0) * media.h } } : {}),
            opacity: context.opacity, blend: 'normal', inverted: node.kind === 'picture' && node.inverted };
        content.push(image);
    } else {
        for (const part of geometry.paths) {
            options.signal.throwIfAborted();
            const fillRole = 'fill' in part ? part.fill : node.kind === 'sticky' ? 'fill' : 'none';
            const hatched = node.kind === 'figure' && part.role === 'fill' && (fillRole === 'pattern' || fillRole === 'lined-fill');
            if (hatched) {
                // The plan leaves hatch calibration open: v1 uses an 8-unit 45°
                // local lattice, clipped by the same contour used for geometry.
                const d: PathCommand[] = [];
                let count = 0;
                for (const line of figureHatch(geometry as FigureGeometry, node, { x: 0, y: 0, width: node.w, height: node.h + node.growY },
                    Math.PI / 4, 8, 0, 1_000_000, 1_000_000)) {
                    d.push(['M', line.start.x, line.start.y], ['L', line.end.x, line.end.y]);
                    if ((++count & 255) === 0) { options.signal.throwIfAborted(); await options.cooperate?.(); }
                }
                content.push(path(d, 1, undefined, color, context.clips, resolveSwatch(palette, color, fillRole)));
            } else {
                const fill = part.role === 'fill' || part.role === 'surface' ? resolveSwatch(palette, color, fillRole) : undefined;
                content.push(path([...pathCommands(part.ops)], part.role === 'fill' || part.role === 'surface' ? 0 : part.width, fill));
            }
        }
        if (isImage) {
            // A missing asset remains a visible retained node, not an omitted item.
            content.push(path(rectangle(node.w, node.h), 1, resolveSwatch(palette, 'grey', 'semi'), 'grey'));
            content.push(path([['M', 0, 0], ['L', node.w, node.h], ['M', node.w, 0], ['L', 0, node.h]], 1, undefined, 'grey'));
        }
        if (node.kind === 'linkcard' || node.kind === 'embed') {
            // Preview fetching/activation is explicit; the inert card always has
            // a body even before any optional preview media is admitted.
            content.push(path(rectangle(node.w, node.h), 1, palette.background, 'grey'));
        }
    }
    for (let i = 0; i < geometry.text.length; i++) content.push(textItem(node, geometry.key, geometry.text[i], i, context, palette, faces));
    options.signal.throwIfAborted();
    return { content };
}
