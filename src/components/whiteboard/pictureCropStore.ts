import type { MediaActions } from '../../whiteboard/host/mediaActions';
import type { NodeId } from '../../whiteboard/model/ids';
import { windowForAspect, withZoom, type CropAspect, type CropWindow } from './nativeCropGeometry';

/** One picture being cropped on the canvas. `window` is the draft; the picture keeps its committed crop until Apply. */
export interface PictureCropSession {
    readonly id: NodeId;
    /** The original bytes, for the faded and the kept parts of the picture. Revoked when the session ends. */
    readonly url: string;
    readonly width: number;
    readonly height: number;
    readonly window: CropWindow;
    readonly circle: boolean;
    readonly aspect: CropAspect;
}
export interface PictureCropStore {
    get(): PictureCropSession | null;
    subscribe(listener: () => void): () => void;
    /** Starts a crop of one picture; a crop already open is ended first, keeping nothing. */
    open(id: NodeId): Promise<void>;
    setWindow(window: CropWindow): void;
    setAspect(aspect: CropAspect): void;
    setCircle(circle: boolean): void;
    setZoom(zoom: number): void;
    /** Applies the draft as one undo step, when it changed, then ends the crop. */
    commit(): void;
    /** Ends the crop and drops the draft. */
    cancel(): void;
    dispose(): void;
}

function sameWindow(a: CropWindow, b: CropWindow): boolean {
    return a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1;
}

/**
 * The crop session for a document's board. It is an external store, not React state, so the overlay, the image toolbar,
 * the double-click and the keyboard all read one draft. The media port is the document's own (MediaActions), so Apply is
 * the same command the picture menu's crop row runs.
 */
export function createPictureCropStore(options: {
    readonly media: MediaActions;
    readonly canStart: () => boolean;
    readonly signal: AbortSignal;
}): PictureCropStore {
    const { media, signal } = options;
    let session: PictureCropSession | null = null, committed: { window: CropWindow; circle: boolean } | null = null;
    let serial = 0, ended = false;
    const listeners = new Set<() => void>();
    const emit = () => { for (const listener of [...listeners]) listener(); };
    const replace = (next: PictureCropSession | null) => {
        const previous = session;
        session = next;
        if (previous && previous.url !== next?.url) URL.revokeObjectURL(previous.url);
        emit();
    };
    const close = () => { committed = null; replace(null); };
    const store: PictureCropStore = {
        get: () => session,
        subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        async open(id) {
            if (ended || !options.canStart()) throw new Error('This picture cannot be cropped now.');
            const info = media.cropSource(id);
            if (!info) throw new Error('This picture cannot be cropped.');
            const token = ++serial;
            const blob = await media.readOriginal(id, signal);
            if (!blob) throw new Error('The picture bytes are unavailable.');
            if (ended || signal.aborted || token !== serial) return;
            const url = URL.createObjectURL(blob);
            committed = { window: info.window, circle: info.circle };
            replace({ id, url, width: info.width, height: info.height, window: info.window, circle: info.circle,
                aspect: info.circle ? 'circle' : 'original' });
        },
        setWindow(window) {
            if (!session) return;
            if (sameWindow(session.window, window)) return;
            replace({ ...session, window });
        },
        setAspect(aspect) {
            if (!session) return;
            const window = windowForAspect(session.window, aspect, session.width, session.height);
            replace({ ...session, aspect, window, circle: aspect === 'circle' });
        },
        setCircle(circle) {
            if (!session) return;
            replace({ ...session, circle });
        },
        setZoom(zoom) {
            if (!session) return;
            replace({ ...session, window: withZoom(session.window, zoom) });
        },
        commit() {
            const open = session, base = committed;
            if (!open) return;
            close();
            if (base && sameWindow(base.window, open.window) && base.circle === open.circle) return;
            media.cropWindow(open.id, open.window, open.circle);
        },
        cancel() { if (session) close(); },
        dispose() { ended = true; committed = null; if (session) replace(null); listeners.clear(); },
    };
    return store;
}
