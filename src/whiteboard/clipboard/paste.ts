import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { BoardRuntime } from '../host/runtime';
import type { BoardClipboardAcquisition } from '../host/clipboardAcquisition';
import { decodeLegacyClipboard, type LegacyClipboardDecodeLease } from '../host/legacyClipboard';
import { readExcalidrawClipboard } from '../host/excalidrawClipboard';
import { inspectMedia } from '../media/inspect';
import type { MediaIngestor } from '../media/ingest';
import type { StoreMedia } from '../media/storage.types';
import type { EmbedManifest } from '../media/embed';
import type { MediaEntry, MediaId } from '../model/media';
import { newSheetId, type NodeId } from '../model/ids';
import type { Attachment } from '../model/nodes';
import type { BoardDoc } from '../model/doc';
import type { BoardJobIdentity } from '../workers/protocol';
import type { JobContext } from '../security/admission';
import { SECURITY_LIMITS } from '../security/limits';
import type { UrlEnvironment } from '../security/urlPolicy';
import { classifyClipboard, type ClipboardClassifierHost } from './classify';
import type { ClipboardCopy } from './copy';
import type { ExcalidrawBindingRequest, FinalExcalidrawDraft } from './excalidraw';
import type { ClipboardHtmlFrameHost } from './htmlFrameHost';
import { pasteClipboardHtmlInJob, type HtmlClipboardSource } from './htmlPaste';
import { insertNativeClipboard } from './insertNative';
import { pasteClipboardMediaInJob } from './mediaPaste';
import { planBoardClipboardPlacement } from './placement';
import { prepareBoardClipboardMediaInJob } from './prepareMedia';
import { pastePrivateClipboardInJob } from './privatePaste';
import { pasteClipboardTextInJob } from './textPaste';
import type { ClipboardInput, ClipboardIntent, ClipboardTarget } from './types';
import { missingPictureSentence } from '../media/missingMedia';
import { yieldToHost } from '../../platform/yieldToHost';

// Provenance: clipboard classification order, C5 external-source admission and
// one session job; independent composition, no upstream engine source.
export type ExternalClipboardSource =
    | { readonly kind: 'native-records'; readonly bytes: Blob }
    | { readonly kind: 'legacy'; readonly decoded: LegacyClipboardDecodeLease }
    | { readonly kind: 'excalidraw'; readonly draft: FinalExcalidrawDraft }
    | { readonly kind: 'html'; readonly source: HtmlClipboardSource };
export interface ExternalClipboardAdmission {
    readonly acquisition: BoardClipboardAcquisition;
    /** Actual canonical geometry of the admitted external source, in source world coordinates. */
    readonly bounds: Readonly<{ x: number; y: number; w: number; h: number }>;
}
export interface BoardClipboardPasteHost {
    readonly runtime: BoardRuntime;
    readonly memory: MemoryAllocator;
    readonly classifier: ClipboardClassifierHost;
    readonly html: ClipboardHtmlFrameHost;
    readonly ingestor: MediaIngestor;
    readonly cache?: ClipboardCopy;
    readonly receivingBoardId: string;
    readonly cameraZoom: number;
    readonly embedEnvironment?: UrlEnvironment;
    readonly embedManifest?: EmbedManifest;
    current(target: Readonly<ClipboardTarget>): boolean;
    readBlob(entry: MediaEntry, signal: AbortSignal): Promise<Blob | null>;
    readonly storeMedia: StoreMedia;
    /** Must encode actual source records and run native C5 before returning. */
    admitExternal(source: ExternalClipboardSource, context: JobContext, identity: BoardJobIdentity): Promise<ExternalClipboardAdmission>;
    resolveBinding(request: ExcalidrawBindingRequest, context: { readonly actualDraftDoc: BoardDoc; readonly signal: AbortSignal }): Promise<Attachment>;
    notice(message: string): void;
    noticeRefused(items: readonly { readonly name: string; readonly reason: string }[]): void;
    cooperate?(): Promise<void>;
}
function copyInput(input: ClipboardInput): ClipboardInput {
    if (!input || !Array.isArray(input.files) || input.files.length > SECURITY_LIMITS.mediaBatch
        || input.files.some(file => !file || !(file.blob instanceof Blob) || typeof file.name !== 'string'
            || typeof file.directory !== 'boolean')
        || input.privatePng !== null && !(input.privatePng instanceof Blob)) throw new TypeError('Invalid clipboard input');
    return Object.freeze({ html: input.html, text: input.text, svg: input.svg, uriList: input.uriList,
        files: Object.freeze(input.files.map(file => ({ name: file.name, directory: file.directory, blob: new Blob([file.blob], { type: file.blob.type }) }))),
        privatePng: input.privatePng ? new Blob([input.privatePng], { type: input.privatePng.type }) : null });
}
/** One job covers classification, conversion, all media storage and the single transaction. */
export function pasteBoardClipboard(host: BoardClipboardPasteHost, input: ClipboardInput, target: Readonly<ClipboardTarget>,
    intent: ClipboardIntent, signal?: AbortSignal): Promise<readonly NodeId[]> {
    const copied = copyInput(input), captured = Object.freeze({ ...target, viewport: Object.freeze({ ...target.viewport }),
        pointer: target.pointer ? Object.freeze({ ...target.pointer }) : null });
    const runtime = host.runtime, session = runtime.session, doc = session.doc, cachePin = host.cache?.pin();
    const bytes = copied.files.reduce((sum, file) => sum + (file.directory ? 0 : Math.min(file.blob.size, SECURITY_LIMITS.mediaBytes)), 0)
        + (copied.privatePng ? Math.min(copied.privatePng.size, SECURITY_LIMITS.mediaBytes) : 0);
    const deadlineMs = Math.min(600_000, Math.max(120_000, Math.ceil(bytes / (100 * 1024 * 1024)) * 30_000));
    return runtime.jobs.run(context => {
        if (runtime.session !== session || session.doc !== doc) throw new DOMException('Clipboard target became stale', 'AbortError');
        return pasteBoardClipboardInJob(host, copied, captured, intent, context, cachePin ?? undefined);
    }, { signal, deadlineMs }).finally(() => cachePin?.release());
}
/** Uses an existing session job, including when a text editor hands non-text content to the board. */
export async function pasteBoardClipboardInJob(host: BoardClipboardPasteHost, input: ClipboardInput, target: Readonly<ClipboardTarget>,
    intent: ClipboardIntent, context: JobContext, cache?: Pick<ClipboardCopy, 'match'>): Promise<readonly NodeId[]> {
    const copied = copyInput(input), captured = Object.freeze({ ...target, viewport: Object.freeze({ ...target.viewport }),
        pointer: target.pointer ? Object.freeze({ ...target.pointer }) : null });
    const runtime = host.runtime, session = runtime.session, doc = session.doc, revision = doc.rev;
        const check = () => {
            runtime.jobs.assertContext(context); context.assertCurrent();
            // No revision fence: a gesture committed while the paste is prepared is no reason to drop it (change/insertionLanding.ts).
            if (!host.current(captured) || runtime.session !== session || session.doc !== doc || session.isReadOnly) {
                throw new DOMException('Clipboard target became stale', 'AbortError');
            }
        };
        const identity: BoardJobIdentity = Object.freeze({ session: context.job.session, epoch: context.job.vaultEpoch, revision });
        const current = (value: BoardJobIdentity) => value.session === identity.session && value.epoch === identity.epoch && value.revision === revision
            && runtime.jobs.isCurrent(context.job) && host.current(captured) && session.doc === doc;
        check();
        const classification = await classifyClipboard(copied, intent, host.classifier, context.signal);
        try {
        check();
        // Called once the paste is in, so the records it names are this board's own (a paste into another folder keeps their names).
        const noticeMissing = (ids: readonly MediaId[]) => {
            const entry = ids.length === 1 ? runtime.session.doc.media.get(ids[0]) : undefined;
            host.notice(entry ? missingPictureSentence(entry, 'it was pasted as a grey box')
                : `${ids.length} pasted pictures are missing, so they were pasted as grey boxes. To bring them back, put their files in the .Assets folder beside this board and reopen the board.`);
        };
        const base = { runtime, target: captured, intent, current: host.current, receivingBoardId: host.receivingBoardId,
            cameraZoom: host.cameraZoom, embedEnvironment: host.embedEnvironment ?? { appOrigin: host.classifier.appOrigin },
            embedManifest: host.embedManifest, noticeMissing, cooperate: host.cooperate };
        if (classification.kind === 'private') return await pastePrivateClipboardInJob({ ...base, memory: host.memory, encoded: classification.encoded,
            plain: copied.text ?? '', cache, readBlob: host.readBlob, storeMedia: host.storeMedia }, context);
        if (classification.kind === 'text' || classification.kind === 'url') {
            const id = await pasteClipboardTextInJob({ ...base, content: classification.kind === 'text'
                ? { kind: 'plain', text: classification.text } : { kind: 'url', url: classification.url },
                aimAtSelectedLink: intent !== 'drop', signal: context.signal }, context);
            return id ? [id as NodeId] : [];
        }
        if (classification.kind === 'html') return pasteClipboardHtmlInJob({ ...base, memory: host.memory, frame: host.html,
            html: classification.html, storeMedia: host.storeMedia, noticeRefused: host.noticeRefused,
            admitSource: (source, owningContext, jobIdentity) => host.admitExternal({ kind: 'html', source }, owningContext, jobIdentity) }, context);
        if (classification.kind === 'files' || classification.kind === 'private-png' || classification.kind === 'svg') {
            const files = classification.kind === 'files' ? classification.files : classification.kind === 'svg'
                ? [{ blob: new Blob([classification.text], { type: 'image/svg+xml' }), name: 'clipboard.svg', directory: false }] : [];
            return pasteClipboardMediaInJob({ runtime, ingestor: host.ingestor, target: captured, intent, files,
                privatePng: classification.kind === 'private-png' ? classification.blob : null,
                current: host.current, noticeRefused: host.noticeRefused, notice: host.notice }, context);
        }
        if (classification.kind === 'empty') { host.notice('The clipboard has no supported content.'); return []; }
        let legacy: LegacyClipboardDecodeLease | undefined, draft: FinalExcalidrawDraft | undefined;
        let wire: Awaited<ReturnType<typeof readExcalidrawClipboard>> | undefined, acquisition: BoardClipboardAcquisition | undefined;
        try {
            let external: ExternalClipboardSource;
            if (classification.kind === 'native-records') external = { kind: 'native-records', bytes: new Blob([classification.text], { type: 'application/json' }) };
            else if (classification.kind === 'legacy') {
                legacy = await decodeLegacyClipboard({ envelope: new Blob([classification.envelope], { type: 'application/json' }),
                    identity, memory: host.memory, isCurrent: current, signal: context.signal }); check();
                external = { kind: 'legacy', decoded: legacy };
            } else {
                const { convertExcalidrawShapes, finalizeExcalidrawDraft } = await import('./excalidraw'); check();
                wire = await readExcalidrawClipboard({ bytes: new Blob([classification.text], { type: 'application/json' }),
                    identity, memory: host.memory, isCurrent: current, signal: context.signal });
                check();
                const sheet = newSheetId(doc), cooperate = host.cooperate ?? yieldToHost;
                const shapes = await convertExcalidrawShapes(wire.elements, { sheet, signal: context.signal, cooperate }); check();
                draft = await finalizeExcalidrawDraft(shapes, { elements: wire.elements, files: wire.files, sheet, signal: context.signal,
                    current: () => current(identity), cooperate, resolveBinding: host.resolveBinding,
                    inspectImage: (file, imageSignal) => inspectMedia(file.blob, { memory: host.memory, identity, isCurrent: current, signal: imageSignal }) });
                check();
                if (draft.skipped) host.notice(`${draft.skipped} unsupported or unavailable clipboard item(s) were skipped.`);
                if (!draft.nodes.length) return [];
                external = { kind: 'excalidraw', draft };
            }
            const admitted = await host.admitExternal(external, context, identity);
            acquisition = admitted.acquisition; check();
            let containsFrame = false, visited = 0;
            for (const node of acquisition.load.doc.nodes.values()) {
                if (node.kind === 'frame') { containsFrame = true; break; }
                if ((++visited & 255) === 0) { await (host.cooperate?.() ?? yieldToHost()); check(); }
            }
            const placement = planBoardClipboardPlacement({ receivingBoardId: host.receivingBoardId, target: captured, doc,
                source: { from: null, bounds: admitted.bounds }, containsFrame, cameraZoom: host.cameraZoom, intent });
            const media = await prepareBoardClipboardMediaInJob({ runtime, acquisition, memory: host.memory, signal: context.signal,
                current: () => current(identity), readBlob: (entry, mediaSignal) => {
                    const blob = draft?.blobs.get(entry.id); return blob ? Promise.resolve(blob) : host.readBlob(entry, mediaSignal);
                }, storeMedia: host.storeMedia, cooperate: host.cooperate }, context);
            try {
                check(); const owned = acquisition; acquisition = undefined;
                const inserted = await insertNativeClipboard({ runtime, acquisition: owned, media, placement, target: captured,
                    receivingBoardId: host.receivingBoardId, external: true, current: host.current, signal: context.signal, cooperate: host.cooperate });
                if (media.missing.length) noticeMissing(media.missing);
                return inserted;
            } finally { media.release(); }
        } finally { acquisition?.dispose(); draft?.release(); wire?.release(); legacy?.release(); }
        } finally { if ('release' in classification) classification.release?.(); }
}
