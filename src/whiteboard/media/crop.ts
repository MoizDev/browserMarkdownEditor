import type { Op } from '../change/ops';
import type { MediaEntry } from '../model/media';
import type { Crop, PictureNode } from '../model/nodes';

// Provenance: media §7 crop presets and the picture's normalized source window;
// independent geometry, no upstream engine source.
export type PictureCropPreset = 'original' | 'square' | 'circle' | 'landscape' | 'portrait' | 'wide';
const RATIOS: Readonly<Record<Exclude<PictureCropPreset, 'original'>, number>> = Object.freeze({
    square: 1, circle: 1, landscape: 4 / 3, portrait: 3 / 4, wide: 16 / 9,
});
export function planPictureCrop(node: Readonly<PictureNode>, media: Readonly<MediaEntry>, preset: PictureCropPreset, zoom = 1): readonly Op[] {
    if (!['original', 'square', 'circle', 'landscape', 'portrait', 'wide'].includes(preset)
        || !Number.isFinite(zoom) || zoom < 1 || zoom > 100 || !Number.isFinite(media.w) || !Number.isFinite(media.h)
        || media.w <= 0 || media.h <= 0 || node.media !== media.id) throw new RangeError('Invalid picture crop');
    const old = node.crop ?? { x0: 0, y0: 0, x1: 1, y1: 1, circle: false };
    if (![old.x0, old.y0, old.x1, old.y1, node.w, node.h].every(Number.isFinite)
        || old.x0 < 0 || old.y0 < 0 || old.x1 > 1 || old.y1 > 1 || old.x1 <= old.x0 || old.y1 <= old.y0
        || node.w <= 0 || node.h <= 0) throw new RangeError('Invalid existing picture geometry');
    const source = preset === 'original' ? { x0: 0, y0: 0, x1: 1, y1: 1 } : old;
    const centreX = (source.x0 + source.x1) / 2, centreY = (source.y0 + source.y1) / 2;
    let width = (source.x1 - source.x0) * media.w, height = (source.y1 - source.y0) * media.h;
    if (preset !== 'original') {
        const ratio = RATIOS[preset];
        if (width / height > ratio) width = height * ratio; else height = width / ratio;
    }
    width /= zoom; height /= zoom;
    const halfX = width / (2 * media.w), halfY = height / (2 * media.h);
    const crop: Crop | null = preset === 'original' && zoom === 1 ? null
        : { x0: centreX - halfX, y0: centreY - halfY, x1: centreX + halfX, y1: centreY + halfY, circle: preset === 'circle' };
    const scaleX = node.w / ((old.x1 - old.x0) * media.w), scaleY = node.h / ((old.y1 - old.y0) * media.h);
    const w = width * scaleX, h = height * scaleY;
    if (![w, h].every(value => Number.isFinite(value) && value >= 1 && value <= 1_000_000)) throw new RangeError('Crop produces an invalid picture box');
    const dx = (node.w - w) / 2, dy = (node.h - h) / 2, cos = Math.cos(node.rotation), sin = Math.sin(node.rotation);
    const x = node.x + cos * dx - sin * dy, y = node.y + sin * dx + cos * dy;
    if (![x, y].every(value => Number.isFinite(value) && Math.abs(value) <= 10_000_000)) throw new RangeError('Crop produces an invalid picture position');
    return [{ t: 'set', id: node.id, key: 'crop', value: crop }, { t: 'set', id: node.id, key: 'w', value: w },
        { t: 'set', id: node.id, key: 'h', value: h }, { t: 'set', id: node.id, key: 'x', value: x }, { t: 'set', id: node.id, key: 'y', value: y }];
}
