import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import { isLocked } from '../change/commands';
import { canAnimatePicture } from '../media/animatedFrames';
import { createPictureCommands } from '../media/commands';
import { fetchCardPreview } from '../media/cards';
import type { CropWindow, PictureCropPreset } from '../media/crop';
import type { MediaEntry } from '../model/media';
import { replacePicture } from '../media/replace';
import type { NodeId } from '../model/ids';
import type { UrlEnvironment } from '../security/urlPolicy';
import type { StoreMedia } from '../media/storage.types';
import type { BoardRuntime } from './runtime';

export interface MediaSelection {
    readonly id: NodeId;
    readonly kind: 'picture' | 'linkcard';
    readonly blocked: string | null;
    readonly replaceable: boolean;
    readonly video: boolean;
    readonly animated: boolean;
}
export interface PictureCropInfo { readonly width: number; readonly height: number; readonly window: CropWindow; readonly circle: boolean }
export interface MediaActions {
    selection(writable: boolean): MediaSelection | null;
    replace(id: NodeId, file: Blob, name: string): Promise<void>;
    crop(id: NodeId, preset: PictureCropPreset): void;
    invert(id: NodeId): void;
    cropSource(id: NodeId): PictureCropInfo | null;
    readOriginal(id: NodeId, signal: AbortSignal): Promise<Blob | null>;
    cropWindow(id: NodeId, window: CropWindow, circle: boolean): void;
    alternativeText(id: NodeId): string;
    setAlt(id: NodeId, text: string): void;
    downloadOriginal(id: NodeId): void;
    cardPreview(id: NodeId): Promise<void>;
}
export interface MediaActionOptions {
    readonly runtime: BoardRuntime;
    readonly memory: MemoryAllocator;
    readonly environment: UrlEnvironment;
    current(): boolean;
    readonly storeMedia?: StoreMedia;
    readonly readMedia?: (entry: MediaEntry, signal: AbortSignal) => Promise<Blob | null>;
}

export function createMediaActions(options: MediaActionOptions): MediaActions {
    const { runtime, memory, environment, current } = options;
    const commands = createPictureCommands({ runtime, current });
    return {
        selection(writable) {
            const selected = runtime.selection.getSnapshot().selected;
            if (selected.length !== 1) return null;
            const node = runtime.session.doc.nodes.get(selected[0]!);
            if (!node || (node.kind !== 'picture' && node.kind !== 'linkcard')) return null;
            const blocked = !writable ? 'This canvas is read-only.'
                : runtime.session.isGestureActive ? 'Finish the current gesture first.'
                : isLocked(runtime.session.doc, node) ? `This ${node.kind === 'picture' ? 'picture' : 'card'} is locked.`
                : null;
            const entry = node.kind === 'picture' && node.media ? runtime.session.doc.media.get(node.media) : undefined;
            const video = !!entry?.mime.startsWith('video/');
            const animated = !!entry && entry.animated && !video && canAnimatePicture(entry.mime);
            return Object.freeze({ id: node.id, kind: node.kind, blocked, replaceable: node.kind === 'picture' && options.storeMedia !== undefined, video, animated });
        },
        replace(id, file, name) {
            if (!options.storeMedia) return Promise.reject(new Error('Pictures cannot be replaced on this canvas.'));
            return replacePicture({ runtime, memory, id, bytes: file, name, current, storeMedia: options.storeMedia });
        },
        crop(id, preset) { commands.crop(id, preset); },
        invert(id) { commands.invert(id); },
        cropSource(id) {
            const node = runtime.session.doc.nodes.get(id);
            if (!node || node.kind !== 'picture' || !node.media) return null;
            const entry = runtime.session.doc.media.get(node.media);
            if (!entry) return null;
            const crop = node.crop ?? { x0: 0, y0: 0, x1: 1, y1: 1, circle: false };
            return Object.freeze({ width: entry.w, height: entry.h, circle: crop.circle,
                window: Object.freeze({ x0: crop.x0, y0: crop.y0, x1: crop.x1, y1: crop.y1 }) });
        },
        readOriginal(id, signal) {
            const node = runtime.session.doc.nodes.get(id);
            const entry = node && node.kind === 'picture' && node.media ? runtime.session.doc.media.get(node.media) : undefined;
            if (!entry) return Promise.reject(new Error('Picture is missing'));
            if (options.readMedia) return options.readMedia(entry, signal);
            return Promise.resolve(runtime.media.get(entry.id) ?? null);
        },
        cropWindow(id, window, circle) { commands.cropWindow(id, window, circle); },
        alternativeText(id) {
            const node = runtime.session.doc.nodes.get(id);
            if (!node || node.kind !== 'picture') throw new Error('Picture is missing');
            return node.alt;
        },
        setAlt(id, text) { commands.setAlt(id, text); },
        downloadOriginal(id) { commands.downloadOriginal(id); },
        cardPreview(id) { return fetchCardPreview({ runtime, id, memory, environment, current, ...(options.storeMedia ? { storeMedia: options.storeMedia } : {}) }); },
    };
}
