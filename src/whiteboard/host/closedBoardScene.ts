import type { RenderToken } from '../../platform/render/types';
import type { SampleStore } from '../ink/samples';
import type { BoardDoc } from '../model/doc';
import type { ParentId, SheetId } from '../model/ids';
import type { MediaEntry } from '../model/media';
import { hashMedia } from '../media/sha256';
import { MediaStore, type MediaLease } from '../media/store';
import { createBoardRenderServices } from '../render/services';
import { SessionScene } from '../scene/sessionScene';
import type { SelectionSnapshot } from '../selection';
import type { NativeExportRuntime } from './nativeExport';

/** A closed board's canonical read parts, owned for one request: the immutable document, its own render
 * services and a real scene over it, and the media it verifiably admitted. No session, camera or live store. */
export interface ClosedBoardSource {
    /** The narrowed parts the export producer and its capture snapshot read. */
    readonly runtime: NativeExportRuntime;
    readonly samples: SampleStore;
    dispose(): void;
}

/** Each embedded media is verified against its document entry before it enters the store, as a live admission does. */
export async function createClosedBoardSource(options: {
    readonly doc: BoardDoc;
    readonly samples: SampleStore;
    readonly token: RenderToken;
    readonly readMedia: (entry: MediaEntry, signal: AbortSignal) => Promise<Blob>;
    readonly signal: AbortSignal;
    readonly onError: (error: unknown) => void;
}): Promise<ClosedBoardSource> {
    const { doc, token, signal } = options;
    const media = new MediaStore(), leases: MediaLease[] = [];
    let render: ReturnType<typeof createBoardRenderServices> | undefined, scene: SessionScene | undefined;
    let disposed = false;
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        try { scene?.dispose(); } finally {
            try { render?.dispose(); } finally {
                try { for (const lease of leases.splice(0)) lease.release(); } finally { media.clear(); }
            }
        }
    };
    try {
        for (const entry of doc.media.values()) {
            signal.throwIfAborted();
            const blob = await options.readMedia(entry, signal);
            signal.throwIfAborted();
            if (blob.size !== entry.bytes || await hashMedia(blob, signal) !== entry.id) {
                throw new Error(`Closed board media is corrupt: ${entry.id}`);
            }
            leases.push(media.retain(entry.id, 'snapshot'));
            media.put(entry.id, blob);
            media.setFile(entry.id, entry.file);
        }
        render = createBoardRenderServices({ doc, samples: options.samples, media, token });
        scene = await SessionScene.create({ doc, token, bounds: render.bounds, retainNode: render.retainNode,
            realize: render.realize, preparePaint: render.preparePaint, subscribeInvalidation: render.subscribeInvalidation,
            retainRenderer: render.retainRenderer, invalidate() {}, onError: options.onError, signal });
        const first: SheetId | undefined = doc.sheetOrder[0]?.id;
        if (!first) throw new Error('Closed board has no sheet');
        // A read has no selection: the snapshot names the first sheet and nothing selected.
        const snapshot: SelectionSnapshot = { sheet: first, focus: first satisfies ParentId, selected: [], active: null };
        const runtime: NativeExportRuntime = Object.freeze({
            session: Object.freeze({ doc, owner: Object.freeze({ documentId: token.documentId, session: token.session }) }),
            scene,
            selection: Object.freeze({ getSnapshot: () => snapshot }),
            render,
            media,
        });
        return { runtime, samples: options.samples, dispose };
    } catch (error) {
        dispose();
        throw error;
    }
}
