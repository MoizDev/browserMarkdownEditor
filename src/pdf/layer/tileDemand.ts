import {
    createTileGrid, exactScale, intersectingTiles, lowCoveragePlan, makeTileKey,
    movingScale, pageAt, renderTokenKey, tileKeyString, tilePrefetchRegion,
} from '../../platform/render';
import type {
    PageStack, RasterTile, Rect, RenderToken, TileContentIdentity, TileDemandClass, TileKey, TileScale,
} from '../../platform/render';
import { pdfVariantRevision } from '../fonts/profiles';

export interface PdfTileRequest {
    readonly key: TileKey;
    readonly text: string;
    readonly page: number;
    readonly tile: RasterTile;
    readonly scale: TileScale;
    readonly level: 'low' | 'motion' | 'exact';
    readonly priority: TileDemandClass;
    readonly distance: number;
}

export interface PdfDemandInput {
    readonly token: RenderToken;
    readonly source: 'outer' | 'original';
    readonly variant: 'plain' | 'emphasis';
    readonly pageVariant?: (page: number) => 'plain' | 'emphasis';
    readonly fontEpoch?: number;
    readonly geometryDigest: string;
    readonly stack: Readonly<PageStack>;
    readonly viewport: Readonly<Rect>;
    readonly rasterScale: number;
    readonly fitWidthZoom: number;
    readonly nominalDpr: number;
    readonly moving: boolean;
    readonly previousMotionScale?: TileScale;
    readonly motionScaleOverride?: TileScale;
    readonly velocity: Readonly<{ x: number; y: number }>;
    readonly direction: Readonly<{ x: number; y: number }>;
    covered(page: number, worldRegion: Readonly<Rect>): boolean;
}

export interface PdfDemandSet {
    readonly requests: readonly PdfTileRequest[];
    readonly motionScale?: TileScale;
}

function intersection(a: Readonly<Rect>, b: Readonly<Rect>): Rect | null {
    const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.width, b.x + b.width);
    const bottom = Math.min(a.y + a.height, b.y + b.height);
    return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

export function planPdfTileDemand(input: PdfDemandInput): PdfDemandSet {
    const { stack, viewport } = input;
    if (!stack.rects.length || viewport.width <= 0 || viewport.height <= 0) return { requests: [] };
    const motionScale = input.moving ? input.motionScaleOverride ?? movingScale(input.rasterScale, input.previousMotionScale) : undefined;
    // The key encodes the scale's float bits, and one zoom recomputes it with noise (1.4379084967320261 vs ...255):
    // each variant keyed a new tile and re-rastered identical pixels. Twelve significant digits is far below a texel.
    const scale = motionScale ?? exactScale(Number(input.rasterScale.toPrecision(12)));
    const prefetch = tilePrefetchRegion(viewport, input.velocity, false, input.direction);
    const lowRegion = tilePrefetchRegion(viewport, input.velocity, true, input.direction);
    const documentToken = renderTokenKey(input.token);
    const centreX = viewport.x + viewport.width / 2, centreY = viewport.y + viewport.height / 2;
    const pages: Array<{ index: number; distance: number }> = [];
    let first = pageAt(stack, lowRegion.y);
    if (first < 0) return { requests: [], motionScale };
    for (; first < stack.rects.length; first++) {
        const rect = stack.rects[first];
        if (rect.y >= lowRegion.y + lowRegion.height) break;
        if (!intersection(rect, lowRegion) || rect.width <= 0 || rect.height <= 0) continue;
        pages.push({ index: first, distance: Math.abs(rect.y + rect.height / 2 - centreY) });
    }
    pages.sort((a, b) => a.distance - b.distance || a.index - b.index);
    const requests: PdfTileRequest[] = [];
    const add = (page: number, region: Readonly<Rect>, levelScale: TileScale, level: PdfTileRequest['level']) => {
        const rect = stack.rects[page];
        const grid = createTileGrid(rect, levelScale);
        const content: TileContentIdentity = {
            documentToken, sourceRole: input.source, pageOrRegion: String(page),
            contentRevision: pdfVariantRevision(input.variant === 'plain' ? 'plain' : input.pageVariant?.(page) ?? input.variant,
                input.fontEpoch ?? 0), colourVersion: 0, tileSchema: 1,
        };
        for (const tile of intersectingTiles(grid, region)) {
            const worldTile = { x: tile.clip.left, y: tile.clip.top,
                width: tile.clip.right - tile.clip.left, height: tile.clip.bottom - tile.clip.top };
            const visible = intersection(worldTile, viewport);
            const priority: TileDemandClass = !visible ? 'prefetch' :
                input.covered(page, visible) ? 'visible-exact' : 'visible-hole';
            const key = makeTileKey(content, grid, tile);
            requests.push({ key, text: tileKeyString(key), page, tile, scale: levelScale, level, priority,
                distance: Math.hypot(worldTile.x + worldTile.width / 2 - centreX, worldTile.y + worldTile.height / 2 - centreY) });
        }
    };
    for (const { index } of pages) {
        const area = intersection(stack.rects[index], prefetch);
        if (area) add(index, area, scale, motionScale ? 'motion' : 'exact');
    }
    for (const { index } of pages.slice(0, 12)) {
        const rect = stack.rects[index];
        const low = lowCoveragePlan(rect.width, rect.height, input.fitWidthZoom, input.nominalDpr);
        if (low.scale.scale >= scale.scale) continue;
        const area = low.tiledRegions ? intersection(rect, lowRegion) : rect;
        if (area) add(index, area, low.scale, 'low');
    }
    requests.sort((a, b) => {
        const rank = (request: PdfTileRequest) => request.priority === 'visible-hole' ?
            (request.level === 'low' ? 0 : 1) : request.priority === 'visible-exact' ? 2 : 3;
        return rank(a) - rank(b) || a.distance - b.distance || a.page - b.page ||
            a.tile.row - b.tile.row || a.tile.column - b.tile.column;
    });
    return { requests, motionScale };
}
