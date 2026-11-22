import type { Affine, Rect } from '../../platform/types';
import type { MediaId } from '../model/media';
import { pictureLevelFloor } from './levelFloor';
import { mediaMipLevel, mediaRasterGeometry, mediaTileKey, visibleMediaTiles, WHOLE_MIP_BYTES, wholeMip } from './mips';

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
export interface PictureTileItem {
    readonly key: string; readonly rect: Rect; readonly sourceRect: Rect;
    /** A tile drawn over the picture's coarse stand-in: when it cannot be decoded now it is left out, and the stand-in shows. */
    readonly underlaid?: true;
}

/** Tiles of one paint request: the frozen device scale and the visible world rectangle (absent for whole-board capture). */
export interface PictureTileRequest { readonly deviceScale: number | undefined; readonly world: Readonly<Rect> | undefined }


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

/** The stand-in under a tiled picture: at most a 1024x1024 decode. */
const STAND_IN_BYTES = 4 * 1024 * 1024;
/** The least share one picture's view tiles may take, so a small view still gets a sharp tile or two. */
const PICTURE_VIEW_MIN_BYTES = 8 * 1024 * 1024;
/** Bytes of the tiles a level would draw for this view (its whole mip when that is one decode). */
function visibleTileBytes(media: PictureTileSource, level: number, winX: number, winY: number, winW: number, winH: number,
    world: Readonly<Rect> | undefined, imageWorld: Affine, node: { readonly w: number; readonly h: number }): number {
    const factor = 2 ** level, mipW = Math.ceil(media.w / factor), mipH = Math.ceil(media.h / factor);
    if (wholeMip(mipW, mipH)) return 4 * mipW * mipH;
    const scaleX = node.w / winW, scaleY = node.h / winH;
    let bytes = 0;
    for (const tile of visibleMediaTiles(media.id, 0, level, media.w, media.h, { x: winX, y: winY, width: winW, height: winH })) {
        const g = mediaRasterGeometry(tile, media.w, media.h);
        const x0 = Math.max(winX, g.mipX * factor), y0 = Math.max(winY, g.mipY * factor);
        const x1 = Math.min(media.w, winX + winW, (g.mipX + g.interiorWidth) * factor), y1 = Math.min(media.h, winY + winH, (g.mipY + g.interiorHeight) * factor);
        if (!(x1 > x0 && y1 > y0)) continue;
        const rect = { x: (x0 - winX) * scaleX, y: (y0 - winY) * scaleY, width: (x1 - x0) * scaleX, height: (y1 - y0) * scaleY };
        if (world && !overlaps(worldBounds(rect, imageWorld), world)) continue;
        bytes += 4 * g.width * g.height;
    }
    return bytes;
}

/** A crop as fractions of the source (model Crop: x0 y0 x1 y1 in 0..1); the node's local box shows exactly this window. */
export interface PictureTileCrop { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }

/**
 * Null keeps the picture on its single whole-image item: no device scale, an animated, vector or video source,
 * or a full-resolution mip that fits one decode (wholeMip: by bytes, not only by side). Otherwise the visible tiles of the chosen
 * mip; a cropped picture draws the tiles under its crop window, mapped into its box.
 */
export function planPictureTiles(node: { readonly w: number; readonly h: number }, media: PictureTileSource,
    imageWorld: Affine, request: PictureTileRequest, crop: PictureTileCrop | null = null): PictureTileItem[] | null {
    const { deviceScale, world } = request;
    if (media.animated || !media.mime.startsWith('image/') || media.mime === 'image/svg+xml') return null;
    if (deviceScale === undefined || !Number.isFinite(deviceScale) || deviceScale <= 0) {
        // No device scale (a mirror or a capture without one): the picture whole, at the finest mip one decode can hold. Asking for
        // the full-resolution picture refused anything over 16 MiB of RGBA and left a placeholder where the view itself drew it.
        if (wholeMip(media.w, media.h)) return null;
        return [wholeMipItem(node, media, coarsestWholeLevel(media, WHOLE_MIP_BYTES), crop)];
    }
    if (!(node.w > 0) || !(node.h > 0)) return null;
    // The source window the box shows: the whole picture, or its crop.
    const winX = crop ? crop.x0 * media.w : 0, winY = crop ? crop.y0 * media.h : 0;
    const winW = crop ? (crop.x1 - crop.x0) * media.w : media.w, winH = crop ? (crop.y1 - crop.y0) * media.h : media.h;
    if (!(winW > 0) || !(winH > 0)) return null;
    // Device pixels per source pixel along the picture's local x: the world scale of its local x axis, the view's scale, and the picture's fit.
    const devicePerSource = deviceScale * Math.hypot(imageWorld[0], imageWorld[1]) * node.w / winW;
    if (!Number.isFinite(devicePerSource) || devicePerSource <= 0) return null;
    // The finest level the view needs, made coarser only while its visible tiles would not fit one picture's share of the CPU pool
    // (measured: an 8000x6000 picture at DPR 2 asked for twelve level-0 tiles, 48 MB, beside a 30 MB back buffer; every tile was
    // refused and the picture never showed). As memory allows, a finer level comes back with the next frame.
    // ...and no finer than the pool has given this picture at this device scale (levelFloor.ts).
    let level = Math.max(mediaMipLevel(devicePerSource, media.w, media.h), pictureLevelFloor(media.id, deviceScale));
    // The share: one RGBA copy of the tile world's device pixels (the pool grants it per visible pixel), and half again for tile
    // rounding. Twice was more than the pool holds beside a DPR 2 board: an 8000x6000 picture at 100% chose level 0, every tile
    // was refused, and the view showed only the placeholder (measured, 17 s). Tiles the pool still refuses leave the stand-in.
    const share = world ? Math.max(PICTURE_VIEW_MIN_BYTES, 1.5 * 4 * world.width * world.height * deviceScale * deviceScale) : PICTURE_VIEW_MIN_BYTES;
    while (level < 26 && visibleTileBytes(media, level, winX, winY, winW, winH, world, imageWorld, node) > share) level++;
    const factor = 2 ** level;
    const tiled = !wholeMip(Math.ceil(media.w / factor), Math.ceil(media.h / factor));
    if (level === 0 && !tiled) return null;
    const scaleX = node.w / winW, scaleY = node.h / winH, items: PictureTileItem[] = [];
    for (const tile of visibleMediaTiles(media.id, 0, level, media.w, media.h, { x: winX, y: winY, width: winW, height: winH })) {
        const geometry = mediaRasterGeometry(tile, media.w, media.h);
        // The tile's interior in source pixels, clipped at the picture's edge and its crop window, and where that interior sits in the
        // bitmap. The bitmap's own stretch is applied as well, so a clipped edge tile maps exactly.
        const sourceX0 = Math.max(winX, geometry.mipX * factor), sourceY0 = Math.max(winY, geometry.mipY * factor);
        const sourceX1 = Math.min(media.w, winX + winW, (geometry.mipX + geometry.interiorWidth) * factor);
        const sourceY1 = Math.min(media.h, winY + winH, (geometry.mipY + geometry.interiorHeight) * factor);
        if (!(sourceX1 > sourceX0 && sourceY1 > sourceY0)) continue;
        const rect: Rect = { x: (sourceX0 - winX) * scaleX, y: (sourceY0 - winY) * scaleY, width: (sourceX1 - sourceX0) * scaleX, height: (sourceY1 - sourceY0) * scaleY };
        if (!(rect.width > 0 && rect.height > 0)) continue;
        if (world && !overlaps(worldBounds(rect, imageWorld), world)) continue;
        const ratioX = geometry.sourceWidth / geometry.width, ratioY = geometry.sourceHeight / geometry.height;
        const sourceRect: Rect = { x: (sourceX0 - geometry.sourceX) / ratioX, y: (sourceY0 - geometry.sourceY) / ratioY,
            width: (sourceX1 - sourceX0) / ratioX, height: (sourceY1 - sourceY0) / ratioY };
        items.push({ key: mediaTileKey(tile), rect, sourceRect });
    }
    // The coarse stand-in under the tiles: the whole picture at a level of at most STAND_IN_BYTES, drawn first. A tile refused for
    // memory, or still decoding, leaves the stand-in showing (blurred, as a PDF page's stand-in) instead of a hole or a placeholder.
    const standIn = coarsestWholeLevel(media, STAND_IN_BYTES);
    if (standIn > level && items.length) return [wholeMipItem(node, media, standIn, crop), ...items.map(item => ({ ...item, underlaid: true as const }))];
    return items;
}

/** The finest level whose whole mip is one decode of at most `bytes`. */
function coarsestWholeLevel(media: PictureTileSource, bytes: number): number {
    let level = 1;
    while (level < 26) {
        const w = Math.ceil(media.w / 2 ** level), h = Math.ceil(media.h / 2 ** level);
        if (wholeMip(w, h) && 4 * w * h <= bytes) break;
        level++;
    }
    return level;
}
/** The whole picture (or its crop) from one whole mip. */
function wholeMipItem(node: { readonly w: number; readonly h: number }, media: PictureTileSource, level: number, crop: PictureTileCrop | null): PictureTileItem {
    const tile = { id: media.id, frame: 0, level, column: -1, row: -1 };
    const g = mediaRasterGeometry(tile, media.w, media.h);
    return { key: mediaTileKey(tile), rect: { x: 0, y: 0, width: node.w, height: node.h },
        sourceRect: crop ? { x: crop.x0 * g.width, y: crop.y0 * g.height, width: (crop.x1 - crop.x0) * g.width, height: (crop.y1 - crop.y0) * g.height }
            : { x: 0, y: 0, width: g.width, height: g.height } };
}
