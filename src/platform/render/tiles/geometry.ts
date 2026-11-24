import type { Rect } from '../../types';
import { RENDER_CONSTANTS as POLICY } from '../constants';
import type { ByteLease, RectI, TextureHandle } from '../gfx/api';
import type { RenderToken } from '../types';

/** Content identity is path/camera independent (§5.1:455–484). sourceRole is consumer-owned. */
export interface TileContentIdentity {
    readonly documentToken: string;
    readonly sourceRole: string;
    readonly pageOrRegion: string;
    readonly contentRevision: string;
    readonly colourVersion: number;
    readonly tileSchema: 1;
}

export interface TileKey extends TileContentIdentity {
    readonly rasterScaleToken: string;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

export type TileState = 'absent' | 'queued' | 'running' | 'arrived' | 'resident' | 'cpu-only' | 'failed';

/** Handles only: producers/caches own creation, reference counts, publication and teardown. */
export interface TileRecord {
    key: TileKey;
    state: TileState;
    interior: RectI;
    gutter: typeof POLICY.tileGutterTexels;
    requestId?: number;
    requestEpoch: number;
    workerGeneration?: number;
    bitmap?: ImageBitmap;
    texture?: TextureHandle;
    cpuLease?: ByteLease;
    gpuLease?: ByteLease;
    lastVisibleFrame: number;
    lastUsedFrame: number;
    coverageClass: 'exact' | 'standin';
    failures: number;
}

export type TileScale = Readonly<{ kind: 'exact'; scale: number; token: string }> |
    Readonly<{ kind: 'level'; scale: number; token: string; level: number }>;

export interface TileGrid {
    readonly page: Readonly<Rect>;
    readonly scale: TileScale;
    readonly rasterWidth: number;
    readonly rasterHeight: number;
    readonly columns: number;
    readonly rows: number;
}

/** Render quads use these shared edges, not independently reconstructed x+width (§5.5:539). */
export interface TileEdges {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
}

export interface RasterTile {
    readonly column: number;
    readonly row: number;
    readonly interior: Readonly<RectI>;
    /** Unclipped raster quad. Never fit the last partial pixel into the shorter true page extent. */
    readonly edges: TileEdges;
    readonly clip: TileEdges;
    readonly textureUV: TileEdges;
    readonly textureWidth: number;
    readonly textureHeight: number;
}

function positive(value: number): void {
    if (!Number.isFinite(value) || value <= 0) throw new RangeError('Tile scale/extent must be finite and positive');
}

function integer(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Tile coordinates must be nonnegative safe integers');
}

export function validateTileRect(rect: Readonly<Rect>): void {
    if (![rect.x, rect.y, rect.width, rect.height, rect.x + rect.width, rect.y + rect.height].every(Number.isFinite) ||
        rect.width < 0 || rect.height < 0 || (rect.width > 0 && rect.x + rect.width <= rect.x) ||
        (rect.height > 0 && rect.y + rect.height <= rect.y)) throw new RangeError('Invalid tile region');
}

/** Canonical four-field token, including the session serial; rename changes none of these. */
export function renderTokenKey(token: RenderToken): string {
    return JSON.stringify([token.vaultEpoch, token.documentId, token.bytesGeneration, token.session]);
}

export function sameTileContent(a: TileContentIdentity, b: TileContentIdentity): boolean {
    return a.documentToken === b.documentToken && a.sourceRole === b.sourceRole &&
        a.pageOrRegion === b.pageOrRegion && a.contentRevision === b.contentRevision &&
        a.colourVersion === b.colourVersion && a.tileSchema === b.tileSchema;
}

/** A scalar is encoded by its actual Float64 bits, not decimal rounding (§5.2:500). */
export function exactScale(scale: number): TileScale {
    positive(scale);
    const bits = new DataView(new ArrayBuffer(8));
    bits.setFloat64(0, scale, false);
    return Object.freeze({ kind: 'exact', scale, token: `f64:${bits.getBigUint64(0, false).toString(16).padStart(16, '0')}` });
}

export function levelScale(level: number): TileScale {
    if (!Number.isSafeInteger(level)) throw new RangeError('Invalid tile level');
    const scale = 2 ** (level / POLICY.movingTileLevelsPerOctave);
    positive(scale);
    return Object.freeze({ kind: 'level', level, scale, token: `level:${level}` });
}

/** Caller supplies the camera's validated range; the portable boundary rejects overflow/underflow. */
export function movingScale(scale: number, previous?: TileScale): TileScale {
    positive(scale);
    if (previous?.kind === 'level') {
        const valid = levelScale(previous.level);
        if (previous.scale !== valid.scale || previous.token !== valid.token) throw new RangeError('Invalid prior tile level');
        if (previous.scale >= scale / POLICY.motionLevelKeepMinDivisor &&
            previous.scale <= scale * POLICY.motionLevelKeepMaxFactor) return previous;
    }
    return levelScale(Math.ceil(POLICY.movingTileLevelsPerOctave * Math.log2(scale)));
}

export function createTileGrid(page: Readonly<Rect>, scale: TileScale): TileGrid {
    validateTileRect(page);
    positive(scale.scale);
    const canonical = scale.kind === 'exact' ? exactScale(scale.scale) : levelScale(scale.level);
    if (scale.scale !== canonical.scale || scale.token !== canonical.token) throw new RangeError('Invalid scale token');
    const rasterWidth = Math.ceil(page.width * scale.scale);
    const rasterHeight = Math.ceil(page.height * scale.scale);
    integer(rasterWidth);
    integer(rasterHeight);
    if ((page.width > 0 && !rasterWidth) || (page.height > 0 && !rasterHeight)) throw new RangeError('Tile domain underflow');
    return Object.freeze({
        page: Object.freeze({ ...page }), scale: Object.freeze({ ...scale }), rasterWidth, rasterHeight,
        columns: Math.ceil(rasterWidth / POLICY.tileInteriorPixels),
        rows: Math.ceil(rasterHeight / POLICY.tileInteriorPixels),
    });
}

export function tileAt(grid: TileGrid, column: number, row: number): RasterTile {
    integer(column);
    integer(row);
    if (column >= grid.columns || row >= grid.rows) throw new RangeError('Tile outside raster domain');
    const x = column * POLICY.tileInteriorPixels;
    const y = row * POLICY.tileInteriorPixels;
    const right = Math.min(x + POLICY.tileInteriorPixels, grid.rasterWidth);
    const bottom = Math.min(y + POLICY.tileInteriorPixels, grid.rasterHeight);
    const page = grid.page;
    const edges = Object.freeze({
        left: page.x + x / grid.scale.scale, top: page.y + y / grid.scale.scale,
        right: page.x + right / grid.scale.scale, bottom: page.y + bottom / grid.scale.scale,
    });
    if (!Object.values(edges).every(Number.isFinite)) throw new RangeError('Tile world edge overflow');
    // Quad-to-texture mapping stays at exact r; clipping is separate (§5.2:496, §5.5:539–541).
    const clip = Object.freeze({ left: Math.max(page.x, edges.left), top: Math.max(page.y, edges.top),
        right: Math.min(page.x + page.width, edges.right), bottom: Math.min(page.y + page.height, edges.bottom) });
    const gutter = POLICY.tileGutterTexels;
    const textureWidth = right - x + 2 * gutter;
    const textureHeight = bottom - y + 2 * gutter;
    const textureUV = Object.freeze({ left: gutter / textureWidth, top: gutter / textureHeight,
        right: (gutter + right - x) / textureWidth, bottom: (gutter + bottom - y) / textureHeight });
    return Object.freeze({
        column, row, interior: Object.freeze({ x, y, width: right - x, height: bottom - y }),
        edges, clip, textureUV, textureWidth, textureHeight,
    });
}

/** Lazy viewport/prefetch-only enumeration; no whole-grid array, including for giant pages. */
export function* intersectingTiles(grid: TileGrid, region: Readonly<Rect>): Generator<RasterTile> {
    validateTileRect(region);
    if (!region.width || !region.height || !grid.columns || !grid.rows) return;
    const page = grid.page;
    const left = Math.max(region.x, page.x);
    const top = Math.max(region.y, page.y);
    const right = Math.min(region.x + region.width, page.x + page.width);
    const bottom = Math.min(region.y + region.height, page.y + page.height);
    if (right <= left || bottom <= top) return;
    const step = POLICY.tileInteriorPixels;
    // Expand one grid cell before exact edge filtering: inverse Float64 transforms can round inward.
    const firstColumn = Math.max(0, Math.floor((left - page.x) * grid.scale.scale / step) - 1);
    const firstRow = Math.max(0, Math.floor((top - page.y) * grid.scale.scale / step) - 1);
    const endColumn = Math.min(grid.columns, Math.ceil((right - page.x) * grid.scale.scale / step) + 1);
    const endRow = Math.min(grid.rows, Math.ceil((bottom - page.y) * grid.scale.scale / step) + 1);
    for (let row = firstRow; row < endRow; row++) {
        for (let column = firstColumn; column < endColumn; column++) {
            const tile = tileAt(grid, column, row);
            if (tile.clip.right > left && tile.clip.bottom > top && tile.clip.left < right && tile.clip.top < bottom) yield tile;
        }
    }
}

export function makeTileKey(content: TileContentIdentity, grid: TileGrid, tile: RasterTile): TileKey {
    return Object.freeze({ ...content, rasterScaleToken: grid.scale.token, ...tile.interior });
}

export function tileKeyString(key: TileKey): string {
    return JSON.stringify([key.documentToken, key.sourceRole, key.pageOrRegion, key.contentRevision,
        key.rasterScaleToken, key.colourVersion, key.tileSchema, key.x, key.y, key.width, key.height]);
}

export function tileDecodedBytes(tile: Pick<RasterTile, 'textureWidth' | 'textureHeight'>): number {
    integer(tile.textureWidth);
    integer(tile.textureHeight);
    if (!tile.textureWidth || !tile.textureHeight) throw new RangeError('Empty tile storage');
    const bytes = tile.textureWidth * tile.textureHeight * POLICY.decodedRgbaBytesPerPixel;
    integer(bytes);
    return bytes;
}

export interface LowCoveragePlan {
    readonly scale: TileScale;
    readonly tiledRegions: boolean;
    readonly maxPreviews: typeof POLICY.maxPagePreviewsPerPane;
}

export function lowCoveragePlan(width: number, height: number, fitWidthZoom: number, nominalDpr: number): LowCoveragePlan {
    for (const value of [width, height, fitWidthZoom, nominalDpr]) positive(value);
    const tiledRegions = Math.max(width, height) / Math.min(width, height) > POLICY.lowPreviewMaxAspectRatio;
    const fitScale = fitWidthZoom * nominalDpr / POLICY.lowPreviewScaleDivisor;
    // Vr-lead §5.4 ruling: a narrow page needs readable local tiles, not an empty 512-high preview.
    const scale = tiledRegions ? fitScale : Math.min(fitScale, POLICY.tileInteriorPixels / Math.max(width, height));
    positive(scale);
    return Object.freeze({
        scale: levelScale(Math.floor(POLICY.movingTileLevelsPerOctave * Math.log2(scale))),
        tiledRegions,
        maxPreviews: POLICY.maxPagePreviewsPerPane,
    });
}

export interface TileArrivalMetadata {
    readonly key: TileKey;
    readonly requestId: number;
    readonly workerGeneration: number;
    readonly pixelWidth: number;
    readonly pixelHeight: number;
    readonly premultiplied: boolean;
    readonly colorSpace: string;
    readonly origin: string;
    readonly rowBytes?: number;
    readonly byteLength?: number;
}

export interface ExpectedTileArrival {
    readonly key: TileKey;
    readonly requestId: number;
    readonly workerGeneration: number;
    readonly reservation: ByteLease;
    readonly reservationValid: boolean;
}

/** No camera epoch: equal content survives pan, zoom and rename (§5.1:480–484).
 * False means the producer/cache owner closes the unmatched transferable; this module owns none.
 */
export function admitTileArrival(arrival: TileArrivalMetadata, expected: ExpectedTileArrival, current: TileContentIdentity): boolean {
    if (!sameTileContent(arrival.key, current) || tileKeyString(arrival.key) !== tileKeyString(expected.key) ||
        arrival.requestId !== expected.requestId || arrival.workerGeneration !== expected.workerGeneration ||
        !expected.reservationValid || !Number.isSafeInteger(expected.requestId) || expected.requestId < 0 ||
        !Number.isSafeInteger(expected.workerGeneration) || expected.workerGeneration < 0 ||
        !arrival.premultiplied || arrival.colorSpace !== POLICY.colorSpace || arrival.origin !== 'top-left') return false;
    const width = expected.key.width + 2 * POLICY.tileGutterTexels;
    const height = expected.key.height + 2 * POLICY.tileGutterTexels;
    if (![expected.key.x, expected.key.y, expected.key.width, expected.key.height, width, height].every(Number.isSafeInteger) ||
        expected.key.x < 0 || expected.key.y < 0 || expected.key.width <= 0 || expected.key.height <= 0 ||
        expected.key.width > POLICY.tileInteriorPixels || expected.key.height > POLICY.tileInteriorPixels ||
        arrival.pixelWidth !== width || arrival.pixelHeight !== height) return false;
    let bytes = width * height * POLICY.decodedRgbaBytesPerPixel;
    if (arrival.rowBytes !== undefined || arrival.byteLength !== undefined) {
        if (!Number.isSafeInteger(arrival.rowBytes) || arrival.rowBytes! < width * POLICY.decodedRgbaBytesPerPixel ||
            !Number.isSafeInteger(arrival.byteLength) || arrival.byteLength! < arrival.rowBytes! * height) return false;
        bytes = arrival.byteLength!;
    }
    return Number.isSafeInteger(bytes) && Number.isSafeInteger(expected.reservation.bytes) && bytes <= expected.reservation.bytes;
}
