import type { Affine, Rect } from '../../platform/types';
import type { MediaId } from '../model/media';
import { pictureLevelFloor } from './levelFloor';
import { mediaMipLevel, mediaRasterGeometry, mediaTileKey, visibleMediaTiles, WHOLE_MIP_BYTES, wholeMip } from './mips';

export interface PictureTileSource {
    readonly id: MediaId;
    readonly w: number;
    readonly h: number;
    readonly mime: string;
    readonly animated: boolean;
}
export interface PictureTileItem {
    readonly key: string; readonly rect: Rect; readonly sourceRect: Rect;
    readonly underlaid?: true;
}

export interface PictureTileRequest {
    readonly deviceScale: number | undefined;
    readonly world: Readonly<Rect> | undefined;
    readonly shareWorld?: Readonly<Rect>;
    readonly exactScale?: number;
}


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

const STAND_IN_BYTES = 4 * 1024 * 1024;
const PICTURE_VIEW_MIN_BYTES = 8 * 1024 * 1024;
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

export interface PictureTileCrop { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }

export function planPictureTiles(node: { readonly w: number; readonly h: number }, media: PictureTileSource,
    imageWorld: Affine, request: PictureTileRequest, crop: PictureTileCrop | null = null): PictureTileItem[] | null {
    const { world } = request, shareWorld = request.shareWorld ?? world;
    const gpuDrawn = imageWorld[1] === 0 && imageWorld[2] === 0 && imageWorld[0] > 0 && imageWorld[3] > 0;
    const deviceScale = gpuDrawn && request.exactScale !== undefined ? request.exactScale : request.deviceScale;
    if (media.animated || !media.mime.startsWith('image/') || media.mime === 'image/svg+xml') return null;
    // No device scale: a capture or an export (the PDF writer, recovery, image export) wants the picture itself under its media id,
    // which it resolves to the original bytes. A tile key there failed every save of a PDF board holding a large picture ('The PDF
    // was not saved: Invalid captured board image key'). Every view request carries a device scale (the selection preview too).
    if (deviceScale === undefined || !Number.isFinite(deviceScale) || deviceScale <= 0) return null;
    if (!(node.w > 0) || !(node.h > 0)) return null;
    const winX = crop ? crop.x0 * media.w : 0, winY = crop ? crop.y0 * media.h : 0;
    const winW = crop ? (crop.x1 - crop.x0) * media.w : media.w, winH = crop ? (crop.y1 - crop.y0) * media.h : media.h;
    if (!(winW > 0) || !(winH > 0)) return null;
    const devicePerSource = deviceScale * Math.hypot(imageWorld[0], imageWorld[1]) * node.w / winW;
    if (!Number.isFinite(devicePerSource) || devicePerSource <= 0) return null;
    let level = Math.max(mediaMipLevel(devicePerSource, media.w, media.h), pictureLevelFloor(media.id, deviceScale));
    const share = shareWorld ? Math.max(PICTURE_VIEW_MIN_BYTES, 1.5 * 4 * shareWorld.width * shareWorld.height * deviceScale * deviceScale) : PICTURE_VIEW_MIN_BYTES;
    while (level < 26 && visibleTileBytes(media, level, winX, winY, winW, winH, shareWorld, imageWorld, node) > share) level++;
    const factor = 2 ** level;
    const tiled = !wholeMip(Math.ceil(media.w / factor), Math.ceil(media.h / factor));
    if (level === 0 && !tiled) return null;
    const scaleX = node.w / winW, scaleY = node.h / winH, items: PictureTileItem[] = [];
    for (const tile of visibleMediaTiles(media.id, 0, level, media.w, media.h, { x: winX, y: winY, width: winW, height: winH })) {
        const geometry = mediaRasterGeometry(tile, media.w, media.h);
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
    const standIn = coarsestWholeLevel(media, STAND_IN_BYTES);
    if (standIn > level && items.length) return [wholeMipItem(node, media, standIn, crop), ...items.map(item => ({ ...item, underlaid: true as const }))];
    return items;
}

function coarsestWholeLevel(media: PictureTileSource, bytes: number): number {
    let level = 1;
    while (level < 26) {
        const w = Math.ceil(media.w / 2 ** level), h = Math.ceil(media.h / 2 ** level);
        if (wholeMip(w, h) && 4 * w * h <= bytes) break;
        level++;
    }
    return level;
}
function wholeMipItem(node: { readonly w: number; readonly h: number }, media: PictureTileSource, level: number, crop: PictureTileCrop | null): PictureTileItem {
    const tile = { id: media.id, frame: 0, level, column: -1, row: -1 };
    const g = mediaRasterGeometry(tile, media.w, media.h);
    return { key: mediaTileKey(tile), rect: { x: 0, y: 0, width: node.w, height: node.h },
        sourceRect: crop ? { x: crop.x0 * g.width, y: crop.y0 * g.height, width: (crop.x1 - crop.x0) * g.width, height: (crop.y1 - crop.y0) * g.height }
            : { x: 0, y: 0, width: g.width, height: g.height } };
}
