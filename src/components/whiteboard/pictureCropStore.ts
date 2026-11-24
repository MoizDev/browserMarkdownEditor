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
/** A crop edge a Ctrl/Cmd-press on a selection handle asked for: the press is still down when the crop session opens. */
export interface PictureCropEdgeGrab {
    readonly dx: -1 | 0 | 1;
    readonly dy: -1 | 0 | 1;
    readonly pointerId: number;
    readonly x: number;
    readonly y: number;
}
export interface PictureCropStore {
    get(): PictureCropSession | null;
    subscribe(listener: () => void): () => void;
    /** Starts a crop of one picture; a crop already open is ended first, keeping nothing. `duringGesture` lets the start happen
     *  while the press that asked for it still holds the board's gesture (the handle press of beginEdge). */
    open(id: NodeId, duringGesture?: boolean): Promise<void>;
    /** Starts a crop of one picture whose `edge` the still-held press drags. The press ending before the session opens cancels it. */
    beginEdge(id: NodeId, edge: { readonly dx: -1 | 0 | 1; readonly dy: -1 | 0 | 1 }, pointer: { readonly pointerId: number; readonly x: number; readonly y: number }): Promise<void>;
    /** The pending edge grab, once: the crop editor takes it when its session is open and starts the drag from that press. */
    takeEdge(): PictureCropEdgeGrab | null;
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
    readonly canStart: (duringGesture: boolean) => boolean;
    readonly signal: AbortSignal;
}): PictureCropStore {
    const { media, signal } = options;
    let session: PictureCropSession | null = null, committed: { window: CropWindow; circle: boolean } | null = null;
    let edge: PictureCropEdgeGrab | null = null;
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
        async open(id, duringGesture = false) {
            if (ended || !options.canStart(duringGesture)) throw new Error('This picture cannot be cropped now.');
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
        async beginEdge(id, handle, pointer) {
            const grab: PictureCropEdgeGrab = { dx: handle.dx, dy: handle.dy, pointerId: pointer.pointerId, x: pointer.x, y: pointer.y };
            edge = grab;
            // The press's own release ends the grab too, so a click that outlives no drag never starts one when the editor opens.
            window.addEventListener('pointerup', () => { if (edge === grab) edge = null; }, { once: true, capture: true });
            try { await store.open(id, true); } catch (error) { if (edge === grab) edge = null; throw error; }
        },
        takeEdge() { const grab = edge; edge = null; return grab; },
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
