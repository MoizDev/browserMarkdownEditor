import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import { isLocked } from '../change/commands';
import { canAnimatePicture } from '../media/animatedFrames';
import { createPictureCommands } from '../media/commands';
import { fetchCardPreview } from '../media/cards';
import type { PictureCropPreset } from '../media/crop';
import { replacePicture } from '../media/replace';
import type { NodeId } from '../model/ids';
import type { UrlEnvironment } from '../security/urlPolicy';
import type { StoreMedia } from '../media/storage.types';
import type { BoardRuntime } from './runtime';

// Provenance: media actions for the one picture or link card a view has selected;
// independent host composition over the picture commands, replacement and preview gestures.

/** The single selected picture or link card, and whether an edit may run on it right now. */
export interface MediaSelection {
    readonly id: NodeId;
    readonly kind: 'picture' | 'linkcard';
    /** The reason an edit cannot run now (the row shows it), or null when it can. */
    readonly blocked: string | null;
    /** Replacing needs the document's proof-carrying storage port, which every board document now supplies. */
    readonly replaceable: boolean;
    /** A picture whose media is a video: its playback is offered by the view, not by these actions. */
    readonly video: boolean;
    /** An animated picture this view can decode frame by frame; its play row is offered by the view, as for video. */
    readonly animated: boolean;
}
export interface MediaActions {
    /** Null unless exactly one picture or link card is selected. `writable` is the view's own write permission. */
    selection(writable: boolean): MediaSelection | null;
    replace(id: NodeId, file: Blob, name: string): Promise<void>;
    crop(id: NodeId, preset: PictureCropPreset): void;
    invert(id: NodeId): void;
    /** Fetches the link preview for an explicit user request; the preview becomes inert text on commit. */
    cardPreview(id: NodeId): Promise<void>;
}
export interface MediaActionOptions {
    readonly runtime: BoardRuntime;
    readonly memory: MemoryAllocator;
    readonly environment: UrlEnvironment;
    current(): boolean;
    /** The document's storage port for replacement bytes (a PDF page's embedded port, or a file board's filesystem port); absent where replacing is not supported. */
    readonly storeMedia?: StoreMedia;
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
        cardPreview(id) { return fetchCardPreview({ runtime, id, memory, environment, current }); },
    };
}
