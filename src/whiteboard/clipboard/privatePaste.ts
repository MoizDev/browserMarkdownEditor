import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { BoardRuntime } from '../host/runtime';
import { acquireBoardClipboard } from '../host/clipboardAcquisition';
import { decodeBoardClipboard } from '../host/clipboardDecode';
import type { MediaEntry } from '../model/media';
import type { NodeId } from '../model/ids';
import type { BoardJobIdentity } from '../workers/protocol';
import type { JobContext } from '../security/admission';
import type { ClipboardCopy } from './copy';
import type { CopySnapshot } from './snapshot';
import { insertNativeClipboard } from './insertNative';
import { planBoardClipboardPlacement } from './placement';
import { prepareBoardClipboardMediaInJob } from './prepareMedia';
import type { ClipboardIntent, ClipboardTarget } from './types';

// Provenance: private clipboard C5 admission, serial session jobs and atomic
// paste contracts; independent orchestration, no upstream engine source.
export interface PrivateClipboardPasteOptions {
    readonly runtime: BoardRuntime;
    readonly memory: MemoryAllocator;
    readonly encoded: string;
    readonly plain: string;
    readonly target: Readonly<ClipboardTarget>;
    readonly intent: ClipboardIntent;
    readonly receivingBoardId: string;
    readonly cameraZoom: number;
    readonly cache?: ClipboardCopy;
    current(target: Readonly<ClipboardTarget>): boolean;
    readBlob(entry: MediaEntry, signal: AbortSignal): Promise<Blob | null>;
    storeMedia(entry: MediaEntry, blob: Blob, signal: AbortSignal): Promise<string | null>;
    cooperate?(): Promise<void>;
}
/** The caller owns the one session job; this function never enqueues another job. */
export async function pastePrivateClipboardInJob(options: PrivateClipboardPasteOptions, context: JobContext): Promise<readonly NodeId[]> {
    const { runtime } = options, session = runtime.session, doc = session.doc, revision = doc.rev;
    const target = Object.freeze({ ...options.target, viewport: Object.freeze({ ...options.target.viewport }),
        pointer: options.target.pointer ? Object.freeze({ ...options.target.pointer }) : null });
    const identity: BoardJobIdentity = Object.freeze({ session: context.job.session, epoch: context.job.vaultEpoch, revision });
    const check = () => {
        runtime.jobs.assertContext(context); context.assertCurrent();
        if (!options.current(target) || runtime.session !== session || session.doc !== doc || doc.rev !== revision || session.isReadOnly) {
            throw new DOMException('Clipboard target became stale', 'AbortError');
        }
    };
    const current = (value: BoardJobIdentity) => value.session === identity.session && value.epoch === identity.epoch
        && value.revision === revision && runtime.jobs.isCurrent(context.job) && options.current(target) && session.doc === doc && doc.rev === revision;
    check();
    const encoded = new Blob([options.encoded], { type: 'text/plain' });
    const decoded = await decodeBoardClipboard({ encoded, identity, memory: options.memory, signal: context.signal, isCurrent: current });
    let acquisition: Awaited<ReturnType<typeof acquireBoardClipboard>> | undefined;
    try {
        check();
        const match = options.cache?.match(options.encoded, options.plain);
        acquisition = await acquireBoardClipboard({ decoded, identity, signal: context.signal, isCurrent: current,
            ...(match ? { cache: { match, encoded: options.encoded, plain: options.plain } } : {}), cooperate: options.cooperate });
        check();
        let containsFrame = false, visited = 0;
        for (const node of acquisition.load.doc.nodes.values()) {
            if (node.kind === 'frame') { containsFrame = true; break; }
            if ((++visited & 255) === 0) { await (options.cooperate?.() ?? new Promise<void>(resolve => setTimeout(resolve, 0))); check(); }
        }
        const placement = planBoardClipboardPlacement({ receivingBoardId: options.receivingBoardId, target, source: acquisition.payload,
            containsFrame, doc, cameraZoom: options.cameraZoom, intent: options.intent });
        const media = await prepareBoardClipboardMediaInJob({ runtime, acquisition, memory: options.memory, signal: context.signal,
            current: () => current(identity), readBlob: async (entry, signal) => {
                let cached: Blob | null = null;
                if (match?.readMedia) { try { cached = await match.readMedia(entry.id, signal); } catch { check(); } }
                check(); return cached ?? options.readBlob(entry, signal);
            }, storeMedia: options.storeMedia, cooperate: options.cooperate }, context);
        try {
            check();
            const owned = acquisition; acquisition = undefined;
            return await insertNativeClipboard({ runtime, acquisition: owned, media, placement, target, signal: context.signal,
                current: () => current(identity), cooperate: options.cooperate });
        } finally { media.release(); }
    } finally { decoded.release(); acquisition?.dispose(); }
}
export function pastePrivateClipboard(options: PrivateClipboardPasteOptions, signal?: AbortSignal): Promise<readonly NodeId[]> {
    return options.runtime.jobs.run(context => pastePrivateClipboardInJob(options, context), { signal, deadlineMs: 120_000 });
}

export interface DuplicateClipboardOptions extends Omit<PrivateClipboardPasteOptions, 'encoded' | 'plain' | 'intent' | 'cache'> {
    /** Caller retains the snapshot and its sample/media leases through completion. */
    readonly snapshot: CopySnapshot;
}
/** Duplicate never touches the OS clipboard, but still performs actual C5 admission. */
export async function duplicateClipboardInJob(options: DuplicateClipboardOptions, context: JobContext): Promise<readonly NodeId[]> {
    const { runtime, snapshot } = options, session = runtime.session, doc = session.doc, revision = doc.rev;
    const target = Object.freeze({ ...options.target, viewport: Object.freeze({ ...options.target.viewport }),
        pointer: options.target.pointer ? Object.freeze({ ...options.target.pointer }) : null });
    const identity: BoardJobIdentity = Object.freeze({ session: context.job.session, epoch: context.job.vaultEpoch, revision });
    const check = () => {
        runtime.jobs.assertContext(context); context.assertCurrent();
        if (!options.current(target) || runtime.session !== session || session.doc !== doc || doc.rev !== revision || session.isReadOnly) {
            throw new DOMException('Duplicate target became stale', 'AbortError');
        }
    };
    const current = (value: BoardJobIdentity) => value.session === identity.session && value.epoch === identity.epoch
        && value.revision === revision && runtime.jobs.isCurrent(context.job) && options.current(target) && session.doc === doc && doc.rev === revision;
    check();
    let acquisition: Awaited<ReturnType<typeof acquireBoardClipboard>> | undefined;
    try {
        acquisition = await acquireBoardClipboard({ decoded: { payload: snapshot.payload, cacheOnly: false, inline: [] },
            identity, signal: context.signal, isCurrent: current, cooperate: options.cooperate });
        check();
        let containsFrame = false, visited = 0;
        for (const node of acquisition.load.doc.nodes.values()) {
            if (node.kind === 'frame') { containsFrame = true; break; }
            if ((++visited & 255) === 0) { await (options.cooperate?.() ?? new Promise<void>(resolve => setTimeout(resolve, 0))); check(); }
        }
        const placement = planBoardClipboardPlacement({ receivingBoardId: options.receivingBoardId, target, source: acquisition.payload,
            containsFrame, doc, cameraZoom: options.cameraZoom, intent: 'duplicate' });
        const media = await prepareBoardClipboardMediaInJob({ runtime, acquisition, memory: options.memory, signal: context.signal,
            current: () => current(identity), readBlob: options.readBlob, storeMedia: options.storeMedia, cooperate: options.cooperate }, context);
        try {
            check();
            const owned = acquisition; acquisition = undefined;
            return await insertNativeClipboard({ runtime, acquisition: owned, media, placement, target, signal: context.signal,
                current: () => current(identity), cooperate: options.cooperate });
        } finally { media.release(); }
    } finally { acquisition?.dispose(); }
}
export function duplicateClipboard(options: DuplicateClipboardOptions, signal?: AbortSignal): Promise<readonly NodeId[]> {
    return options.runtime.jobs.run(context => duplicateClipboardInJob(options, context), { signal, deadlineMs: 120_000 });
}
