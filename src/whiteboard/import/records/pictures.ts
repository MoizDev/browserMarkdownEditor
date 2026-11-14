import type { MediaId } from '../../model/media';
import type { Crop, Node, NodeBase } from '../../model/nodes';
import { object, type LegacyObject } from './envelope';
import type { LegacyShape } from './common';

function number(value: unknown, key: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid ${key}`);
    return value;
}
function text(value: unknown, key: string): string {
    if (typeof value !== 'string') throw new Error(`Invalid ${key}`);
    return value;
}
function boolean(value: unknown, key: string): boolean {
    if (typeof value !== 'boolean') throw new Error(`Invalid ${key}`);
    return value;
}
function crop(value: unknown): Crop | null {
    if (value === null) return null;
    const box = object(value), top = object(box?.topLeft), bottom = object(box?.bottomRight);
    if (!box || !top || !bottom) throw new Error('Invalid image crop');
    return { x0: number(top.x, 'crop x0'), y0: number(top.y, 'crop y0'),
        x1: number(bottom.x, 'crop x1'), y1: number(bottom.y, 'crop y1'), circle: false };
}
function mediaId(value: unknown, assets: ReadonlyMap<string, MediaId>): MediaId | null {
    if (value === null) return null;
    if (typeof value !== 'string') throw new Error('Invalid asset reference');
    return assets.get(value) ?? null;
}
export function readPictureShape(shape: LegacyShape, base: NodeBase, assets: ReadonlyMap<string, MediaId>,
    bookmarks: ReadonlyMap<string, LegacyObject>): Node | null {
    const p = shape.props;
    switch (shape.type) {
        case 'image': return { ...base, kind: 'picture', w: number(p.w, 'width'), h: number(p.h, 'height'),
            media: mediaId(p.assetId, assets), crop: crop(p.crop), flipX: boolean(p.flipX, 'flip X'),
            flipY: boolean(p.flipY, 'flip Y'), alt: text(p.altText, 'alt text'),
            inverted: shape.meta.inverted === undefined ? false : boolean(shape.meta.inverted, 'inverted flag'),
            playing: boolean(p.playing, 'playing'), url: text(p.url, 'URL') || null };
        case 'video': {
            if (text(p.url, 'URL')) throw new Error('Video URL cannot be represented');
            return { ...base, kind: 'clip', w: number(p.w, 'width'), h: number(p.h, 'height'),
                media: mediaId(p.assetId, assets), autoplay: boolean(p.autoplay, 'autoplay'),
                playing: boolean(p.playing, 'playing'), time: number(p.time, 'time'), alt: text(p.altText, 'alt text') };
        }
        case 'bookmark': {
            const asset = typeof p.assetId === 'string' ? bookmarks.get(p.assetId) : null;
            if (p.assetId !== null && !asset) throw new Error('Missing bookmark metadata');
            const props = object(asset?.props);
            if (asset && !props) throw new Error('Invalid bookmark metadata');
            if (props && (text(props.image, 'bookmark image') || text(props.favicon, 'bookmark favicon'))) {
                throw new Error('Remote bookmark preview images cannot yet be represented');
            }
            return { ...base, kind: 'linkcard', w: number(p.w, 'width'), h: number(p.h, 'height'),
                url: text(p.url, 'URL'), preview: props ? { title: text(props.title, 'title'),
                    description: text(props.description, 'description'), image: null, favicon: null } : null };
        }
        default: return null;
    }
}
