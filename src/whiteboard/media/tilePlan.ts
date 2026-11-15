import type { Affine, Rect } from '../../platform/types';
import type { MediaId } from '../model/media';
import { mediaMipLevel, mediaRasterGeometry, mediaTileKey, visibleMediaTiles } from './mips';

// Provenance: picture tile plan for one paint request; independent. It chooses the mip and the visible tiles
// a picture draws at the request's device scale, and maps each tile's interior into the picture's local units.

export interface PictureTileSource {
    readonly id: MediaId;
    readonly w: number;
    readonly h: number;
    readonly mime: string;
    readonly animated: boolean;
}
/** One tile to draw: its residency key, where its interior lands in the picture's local units, and that interior in the tile's own pixels. */
export interface PictureTileItem { readonly key: string; readonly rect: Rect; readonly sourceRect: Rect }

/** Tiles of one paint request: the frozen device scale and the visible world rectangle (absent for whole-board capture). */
export interface PictureTileRequest { readonly deviceScale: number | undefined; readonly world: Readonly<Rect> | undefined }

/** A mip above this side is decoded in tiles, the same bound mediaRasterGeometry enforces for a whole mip. */
const WHOLE_MIP_SIDE = 4096;

function worldBounds(rect: Rect, m: Affine): Rect {
    const corners = [[rect.x, rect.y], [rect.x + rect.width, rect.y], [rect.x, rect.y + rect.height], [rect.x + rect.width, rect.y + rect.height]]
        .map(([x, y]) => [m[0] * x! + m[2] * y! + m[4], m[1] * x! + m[3] * y! + m[5]]);
    const xs = corners.map(([x]) => x!), ys = corners.map(([, y]) => y!);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
function overlaps(a: Rect, b: Readonly<Rect>): boolean {
    return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/**
 * Null keeps the picture on its single whole-image item: no device scale, an animated, vector or video source,
 * or a full-resolution mip that fits one decode. Otherwise the visible tiles of the chosen mip.
 */
export function planPictureTiles(node: { readonly w: number; readonly h: number }, media: PictureTileSource,
    imageWorld: Affine, request: PictureTileRequest): PictureTileItem[] | null {
    const { deviceScale, world } = request;
    if (deviceScale === undefined || !Number.isFinite(deviceScale) || deviceScale <= 0) return null;
    if (media.animated || !media.mime.startsWith('image/') || media.mime === 'image/svg+xml') return null;
    if (!(node.w > 0) || !(node.h > 0)) return null;
    // Device pixels per source pixel along the picture's local x: the world scale of its local x axis, the view's scale, and the picture's fit.
    const devicePerSource = deviceScale * Math.hypot(imageWorld[0], imageWorld[1]) * node.w / media.w;
    if (!Number.isFinite(devicePerSource) || devicePerSource <= 0) return null;
    const level = mediaMipLevel(devicePerSource, media.w, media.h), factor = 2 ** level;
    const tiled = Math.ceil(media.w / factor) > WHOLE_MIP_SIDE || Math.ceil(media.h / factor) > WHOLE_MIP_SIDE;
    if (level === 0 && !tiled) return null;
    const scaleX = node.w / media.w, scaleY = node.h / media.h, items: PictureTileItem[] = [];
    for (const tile of visibleMediaTiles(media.id, 0, level, media.w, media.h, { x: 0, y: 0, width: media.w, height: media.h })) {
        const geometry = mediaRasterGeometry(tile, media.w, media.h);
        // The tile's interior in source pixels, clipped at the picture's edge, and where that interior sits in the bitmap.
        // The bitmap's own stretch is applied as well, so a clipped edge tile maps exactly.
        const sourceX0 = geometry.mipX * factor, sourceY0 = geometry.mipY * factor;
        const sourceX1 = Math.min(media.w, (geometry.mipX + geometry.interiorWidth) * factor);
        const sourceY1 = Math.min(media.h, (geometry.mipY + geometry.interiorHeight) * factor);
        const rect: Rect = { x: sourceX0 * scaleX, y: sourceY0 * scaleY, width: (sourceX1 - sourceX0) * scaleX, height: (sourceY1 - sourceY0) * scaleY };
        if (!(rect.width > 0 && rect.height > 0)) continue;
        if (world && !overlaps(worldBounds(rect, imageWorld), world)) continue;
        const ratioX = geometry.sourceWidth / geometry.width, ratioY = geometry.sourceHeight / geometry.height;
        const sourceRect: Rect = { x: (sourceX0 - geometry.sourceX) / ratioX, y: (sourceY0 - geometry.sourceY) / ratioY,
            width: (sourceX1 - sourceX0) / ratioX, height: (sourceY1 - sourceY0) / ratioY };
        items.push({ key: mediaTileKey(tile), rect, sourceRect });
    }
    return items;
}
