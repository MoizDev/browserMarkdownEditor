import type { Affine, PathCommand, Rgba } from '../../platform/types';
import { figureHatch, pathCommands, type FigureGeometry, type PositionedFigureText } from '../geom/providers';
import type { InkCoverage } from '../ink/outline';
import type { MediaEntry } from '../model/media';
import { planPictureTiles, type PictureTileRequest } from '../media/tilePlan';
import { parseMediaTileKey } from '../media/mips';
import type { Node, StrokeNode } from '../model/nodes';
import type { FaceTable } from '../text/paint';
import { resolveSwatch, type PaintPalette } from './colour';
import { highlighterMaterials, inkMaterial, pathMaterial } from './material';
import type { PaintClip, PaintImageItem, PaintItem, PaintNode, PaintPathItem, PaintTextItem } from './paintStream';
import type { SceneResolveContext } from './sceneSource';
import { POSTER_FAVICON, POSTER_FAVICON_INSET, posterImageHeight, textPaintMaterial } from './textGeometry';
import type { BoardVectorGeometry } from './vectorGeometry';

function translated(matrix: Affine, x: number, y: number, scale = 1): Affine {
    return [matrix[0] * scale, matrix[1] * scale, matrix[2] * scale, matrix[3] * scale,
        matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]];
}
/** A decoded picture's own size, scaled to fit a box and centred in it; the box's origin offsets the result. */
export interface PreviewMedia { readonly image?: MediaEntry; readonly favicon?: MediaEntry }
function fitted(entry: MediaEntry, w: number, h: number, origin = { x: 0, y: 0 }): { x: number; y: number; width: number; height: number } {
    const scale = Math.min(w / entry.w, h / entry.h), width = entry.w * scale, height = entry.h * scale;
    return { x: origin.x + (w - width) / 2, y: origin.y + (h - height) / 2, width, height };
}
function rectangle(w: number, h: number): readonly PathCommand[] {
    return [['M', 0, 0], ['L', w, 0], ['L', w, h], ['L', 0, h], ['Z']];
}
function textItem(node: Readonly<Node>, geometryKey: string, label: PositionedFigureText, index: number,
    context: SceneResolveContext, palette: PaintPalette, faces: FaceTable): PaintTextItem {
    return { kind: 'text', key: `${node.id}:text:${index}:${palette.revision}`, nodeId: node.id, geometryKey: `${geometryKey}:text:${label.paint.key}`,
        localToWorld: translated(context.world, label.x, label.y, label.scale ?? 1), clips: context.clips,
        paint: label.paint, faces: label.paint.faceTable ?? faces, material: textPaintMaterial(label.paint, palette, context.opacity) };
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

function* vectorNodePaint(node: Readonly<Node>, geometry: BoardVectorGeometry,
    context: SceneResolveContext, palette: PaintPalette, faces: FaceTable, options: {
        readonly media?: MediaEntry;
        readonly signal: AbortSignal;
        /** The request's scale and view: a picture at a reduced mip draws its visible tiles; absent, it draws its whole image. */
        readonly tiles?: PictureTileRequest;
        /** A link card's stored preview picture and favicon, when their media are present. */
        readonly preview?: PreviewMedia;
    }): Generator<void, PaintNode> {
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
        // A cropped picture tiles too: untiled, a large one was one whole-image decode however small its crop or its view.
        const tiles = node.kind === 'picture' && options.tiles ? planPictureTiles(node, { id: node.media, w: media.w, h: media.h,
            mime: media.mime, animated: media.animated }, imageWorld, options.tiles, crop) : null;
        if (tiles) {
            // A whole-mip item (the stand-in, or the whole picture at the level a worldless request could hold) names its picture, so
            // the GPU composer plans the finer tiles of each tile it composes itself: the board settles on a whole-scene request with
            // no world, which held a 4000x3000 picture at its 1000x750 level at 100% (measured, sharpness 0.19 vs canvas2d's 0.66).
            const facts = options.tiles?.deviceScale !== undefined ? { media: { id: node.media, w: media.w, h: media.h, mime: media.mime,
                animated: media.animated }, box: { w: node.w, h: node.h }, crop: crop ?? null } : null;
            // Each tile is its own image item, keyed by its tile key, so the paint pipeline acquires exactly the tiles it draws.
            for (const tile of tiles) {
                const parsed = facts && !tile.underlaid ? parseMediaTileKey(tile.key) : null;
                content.push({ ...base, kind: 'image', key: `${node.id}:tile:${tile.key}`, imageKey: tile.key,
                    localToWorld: imageWorld, clips, rect: tile.rect, sourceRect: tile.sourceRect,
                    opacity: context.opacity, blend: 'normal', inverted: node.kind === 'picture' && node.inverted, ...(tile.underlaid ? { underlaid: true as const } : {}),
                    ...(facts && parsed && parsed.column === -1 ? { picture: { ...facts, level: parsed.level } } : {}) });
            }
        } else {
            const image: PaintImageItem = { ...base, kind: 'image', key: `${node.id}:image:${node.media}`, imageKey: node.media,
                localToWorld: imageWorld, clips, rect: { x: 0, y: 0, width: node.w, height: node.h },
                ...(crop ? { sourceRect: { x: crop.x0 * media.w, y: crop.y0 * media.h,
                    width: (crop.x1 - crop.x0) * media.w, height: (crop.y1 - crop.y0) * media.h } } : {}),
                opacity: context.opacity, blend: 'normal', inverted: node.kind === 'picture' && node.inverted };
            content.push(image);
        }
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
                    if ((++count & 255) === 0) { options.signal.throwIfAborted(); yield; options.signal.throwIfAborted(); }
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
    if (node.kind === 'linkcard' && options.preview) {
        // A stored preview picture fills the card's top band, fitted and centred; its favicon sits on the title's line, left of the text.
        const band = posterImageHeight(node), image = options.preview.image, favicon = options.preview.favicon, title = geometry.text[0];
        if (image && band > 0) {
            content.push({ ...base, kind: 'image', key: `${node.id}:preview:image:${image.id}`, imageKey: image.id, localToWorld: context.world,
                clips: context.clips, rect: fitted(image, node.w, band), opacity: context.opacity, blend: 'normal', inverted: false });
        }
        if (favicon && node.preview?.favicon && title) {
            content.push({ ...base, kind: 'image', key: `${node.id}:preview:favicon:${favicon.id}`, imageKey: favicon.id, localToWorld: context.world,
                clips: context.clips, rect: fitted(favicon, POSTER_FAVICON, POSTER_FAVICON, { x: title.x - POSTER_FAVICON_INSET, y: title.y }),
                opacity: context.opacity, blend: 'normal', inverted: false });
        }
    }
    for (let i = 0; i < geometry.text.length; i++) content.push(textItem(node, geometry.key, geometry.text[i], i, context, palette, faces));
    options.signal.throwIfAborted();
    return { content };
}

/** Geometry has already resolved draw/dash/crop contours; painting assigns
 * material roles and captured transforms, without decoding media. */
export async function paintVectorNode(node: Readonly<Node>, geometry: BoardVectorGeometry,
    context: SceneResolveContext, palette: PaintPalette, faces: FaceTable, options: {
        readonly media?: MediaEntry; readonly signal: AbortSignal; readonly cooperate?: () => Promise<void>;
        readonly tiles?: PictureTileRequest; readonly preview?: PreviewMedia;
    }): Promise<PaintNode> {
    const job = vectorNodePaint(node, geometry, context, palette, faces, options);
    try {
        for (;;) {
            options.signal.throwIfAborted();
            const next = job.next(); if (next.done) return next.value;
            await options.cooperate?.(); options.signal.throwIfAborted();
        }
    } finally { job.return(undefined as never); }
}

export function paintVectorNodeNow(node: Readonly<Node>, geometry: BoardVectorGeometry,
    context: SceneResolveContext, palette: PaintPalette, faces: FaceTable, options: {
        readonly media?: MediaEntry; readonly signal: AbortSignal; readonly preview?: PreviewMedia;
    }): PaintNode {
    const job = vectorNodePaint(node, geometry, context, palette, faces, options);
    try {
        for (;;) {
            options.signal.throwIfAborted();
            const next = job.next(); if (next.done) return next.value;
        }
    } finally { job.return(undefined as never); }
}
