import type { MediaId } from '../model/media';

export interface MediaTile {
    readonly id: MediaId;
    readonly frame: number;
    readonly level: number;
    readonly column: number;
    readonly row: number;
}
export interface MediaRasterGeometry {
    readonly sourceX: number; readonly sourceY: number; readonly sourceWidth: number; readonly sourceHeight: number;
    readonly width: number; readonly height: number;
    readonly interiorX: number; readonly interiorY: number;
    readonly interiorWidth: number; readonly interiorHeight: number;
    readonly mipX: number; readonly mipY: number;
}
const TILE = 1024;

export function mediaTileKey(tile: MediaTile): string {
    if (!/^sha256:[0-9a-f]{64}$/.test(tile.id) || !Number.isSafeInteger(tile.frame) || tile.frame < 0
        || !Number.isSafeInteger(tile.level) || tile.level < 0 || tile.level > 26
        || !Number.isSafeInteger(tile.column) || !Number.isSafeInteger(tile.row)
        || tile.column < -1 || tile.row < -1 || (tile.column === -1) !== (tile.row === -1)) throw new RangeError('Invalid media tile');
    return `media:${tile.id.slice(7)}:${tile.frame}:${tile.level}:${tile.column}:${tile.row}`;
}

export function parseMediaTileKey(key: string): MediaTile {
    const match = /^media:([0-9a-f]{64}):(0|[1-9]\d*):(0|[1-9]\d*):(-1|0|[1-9]\d*):(-1|0|[1-9]\d*)$/.exec(key);
    if (!match) throw new Error('Invalid media tile key');
    const tile: MediaTile = { id: `sha256:${match[1]}`, frame: Number(match[2]), level: Number(match[3]), column: Number(match[4]), row: Number(match[5]) };
    if (mediaTileKey(tile) !== key) throw new Error('Invalid media tile key');
    return tile;
}

// Largest mip whose texel is no larger than one device pixel at rest.
export function mediaMipLevel(devicePixelsPerSourcePixel: number, width: number, height: number, near = false): number {
    if (!Number.isFinite(devicePixelsPerSourcePixel) || devicePixelsPerSourcePixel <= 0
        || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) throw new RangeError('Invalid media scale');
    const maximum = Math.min(26, Math.ceil(Math.log2(Math.max(width, height))));
    const level = Math.max(0, Math.min(maximum, Math.floor(Math.log2(1 / devicePixelsPerSourcePixel))));
    return near ? Math.min(maximum, level + 1) : level;
}

export function visibleMediaTiles(id: MediaId, frame: number, level: number, sourceWidth: number, sourceHeight: number,
    visible: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }): MediaTile[] {
    if (![visible.x, visible.y, visible.width, visible.height].every(Number.isFinite) || visible.width < 0 || visible.height < 0) throw new RangeError('Invalid visible media rectangle');
    const base: MediaTile = { id, frame, level, column: -1, row: -1 };
    mediaTileKey(base);
    if (!Number.isSafeInteger(sourceWidth) || !Number.isSafeInteger(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0
        || sourceWidth > (2 ** 26) / sourceHeight) throw new RangeError('Invalid media dimensions');
    const left = Math.max(0, visible.x), top = Math.max(0, visible.y);
    const right = Math.min(sourceWidth, visible.x + visible.width), bottom = Math.min(sourceHeight, visible.y + visible.height);
    if (left >= right || top >= bottom) return [];
    const factor = 2 ** level;
    const mipWidth = Math.ceil(sourceWidth / factor), mipHeight = Math.ceil(sourceHeight / factor);
    if (mipWidth <= 4096 && mipHeight <= 4096) return [base];
    const firstColumn = Math.floor(left / factor / TILE), lastColumn = Math.ceil(right / factor / TILE) - 1;
    const firstRow = Math.floor(top / factor / TILE), lastRow = Math.ceil(bottom / factor / TILE) - 1;
    const result: MediaTile[] = [];
    for (let row = firstRow; row <= lastRow; row++) {
        for (let column = firstColumn; column <= lastColumn; column++) result.push({ id, frame, level, column, row });
    }
    return result;
}

export function mediaRasterGeometry(tile: MediaTile, sourceWidth: number, sourceHeight: number): MediaRasterGeometry {
    mediaTileKey(tile);
    if (!Number.isSafeInteger(sourceWidth) || !Number.isSafeInteger(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0
        || sourceWidth > (2 ** 26) / sourceHeight) throw new RangeError('Invalid media dimensions');
    const factor = 2 ** tile.level;
    const mipWidth = Math.ceil(sourceWidth / factor), mipHeight = Math.ceil(sourceHeight / factor);
    const tiled = tile.column !== -1;
    if (!tiled && (mipWidth > 4096 || mipHeight > 4096)) throw new RangeError('Large mip requires tiles');
    const left = tiled ? tile.column * TILE : 0, top = tiled ? tile.row * TILE : 0;
    if (!Number.isSafeInteger(left) || !Number.isSafeInteger(top) || left >= mipWidth || top >= mipHeight) throw new RangeError('Media tile is outside its mip');
    const interiorWidth = Math.min(tiled ? TILE : mipWidth, mipWidth - left);
    const interiorHeight = Math.min(tiled ? TILE : mipHeight, mipHeight - top);
    const interiorX = tiled && left > 0 ? 1 : 0, interiorY = tiled && top > 0 ? 1 : 0;
    const rightApron = tiled && left + interiorWidth < mipWidth ? 1 : 0;
    const bottomApron = tiled && top + interiorHeight < mipHeight ? 1 : 0;
    const width = interiorWidth + interiorX + rightApron, height = interiorHeight + interiorY + bottomApron;
    const sourceX = (left - interiorX) * factor, sourceY = (top - interiorY) * factor;
    return { sourceX, sourceY, sourceWidth: Math.min(sourceWidth - sourceX, width * factor),
        sourceHeight: Math.min(sourceHeight - sourceY, height * factor), width, height,
        interiorX, interiorY, interiorWidth, interiorHeight, mipX: left, mipY: top };
}
