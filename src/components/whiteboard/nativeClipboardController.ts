import type { CameraController } from '../../platform/render/camera';
import { surfaceToWorld } from '../../platform/render/camera';
import { pageAt } from '../../platform/render/pageStack';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { NativeCanvasHost, NativeCanvasIdentity } from '../../types/nativeCanvas';
import { worldPose } from '../../whiteboard/change/coordinates';
import { classifyClipboard } from '../../whiteboard/clipboard/classify';
import { decodeBoardClipboard } from '../../whiteboard/host/clipboardDecode';
import { acquireBoardClipboard, acquireCopiedBoardClipboard, type BoardClipboardAcquisition } from '../../whiteboard/host/clipboardAcquisition';
import { readNativeClipboardMedia } from '../../whiteboard/host/clipboardCommands';
import { classifyClipboardJson } from '../../whiteboard/host/clipboardJsonKind';
import { createClipboardHtmlFrameHost } from '../../whiteboard/clipboard/htmlFrameHost';
import { insertClipboardText } from '../../whiteboard/clipboard/insertText';
import { insertNativeClipboard } from '../../whiteboard/clipboard/insertNative';
import { planBoardClipboardPlacement } from '../../whiteboard/clipboard/placement';
import { prepareBoardClipboardMediaInJob } from '../../whiteboard/clipboard/prepareMedia';
import { acceptsBoardDrag, captureTransfer } from '../../whiteboard/clipboard/transfer';
import type { CachedClipboard } from '../../whiteboard/clipboard/copy';
import type { CopySnapshot } from '../../whiteboard/clipboard/snapshot';
import type { ClipboardInput, ClipboardIntent, ClipboardPoint, ClipboardTarget } from '../../whiteboard/clipboard/types';
import type { createBoardMediaIngestor } from '../../whiteboard/host/mediaIngest';
import type { BoardRuntime } from '../../whiteboard/host/runtime';
import { isSheetParent } from '../../whiteboard/model/doc';
import type { MediaEntry, MediaId } from '../../whiteboard/model/media';
import type { MediaSource } from '../../whiteboard/media/ingest';
import { readPrivatePngDensity } from '../../whiteboard/media/privatePng';
import { boardPageStack } from '../../whiteboard/model/pages';
import type { BoardJobIdentity } from '../../whiteboard/workers/protocol';

export interface NativeClipboardControllerOptions {
    readonly runtime: BoardRuntime;
    readonly camera: CameraController;
    readonly host: NativeCanvasHost;
    readonly identity: NativeCanvasIdentity;
    readonly memory: MemoryAllocator;
    readonly ingestor: ReturnType<typeof createBoardMediaIngestor>;
    readonly pasteAtCursor: () => boolean;
    /** Last pointer in world coordinates, or null when it has not entered this view. */
    readonly pointer: () => ClipboardPoint | null;
    readonly surfacePoint: (clientX: number, clientY: number) => ClipboardPoint;
    readonly editingText: () => boolean;
    readonly finishGesture: () => void;
    readonly matchClipboard: (encoded: string, plain: string) => CachedClipboard | null;
    readonly readMedia: (entry: MediaEntry, signal: AbortSignal) => Promise<Blob | null>;
    readonly storeMedia: (entry: MediaEntry, blob: Blob, signal: AbortSignal) => Promise<string | null>;
    readonly notice: (message: string) => void;
    readonly onError: (error: unknown) => void;
}

/** Paste/drop own one serial session job; unsupported semantic converters remain explicit frontiers. */
export function createNativeClipboardController(options: NativeClipboardControllerOptions) {
    const { runtime, identity, host } = options, session = runtime.session, doc = session.doc;
    let disposed = false, pending = 0, retired: (() => void) | undefined;
    const lifetime = new AbortController(), jobs = new Set<AbortController>();
    const releaseRetired = () => { if (retired && pending === 0) { const done = retired; retired = undefined; disposed = true; lifetime.abort(); done(); } };
    const current = () => {
        const admitted = host.identity(identity.documentId);
        return !disposed && host.isCurrent(identity) && !!admitted && admitted.documentId === identity.documentId
            && admitted.session === identity.session && admitted.vaultActivation === identity.vaultActivation
            && admitted.bytesGeneration === identity.bytesGeneration && admitted.kind === identity.kind
            && runtime.session === session && session.doc === doc
            && session.owner.documentId === identity.documentId && session.owner.session === identity.session;
    };
    const targetNow = (pointer?: ClipboardPoint | null) => {
        if (!current() || session.isReadOnly) throw new Error(session.readOnlyReason ?? 'Board is not editable');
        options.finishGesture();
        if (!current() || session.isReadOnly || session.isGestureActive) throw new Error('Board is not ready for paste');
        const selection = runtime.selection.getSnapshot(), camera = options.camera.camera, viewport = options.camera.viewport;
        if (!Number.isFinite(camera.z) || camera.z <= 0 || viewport.width <= 0 || viewport.height <= 0) throw new Error('Board viewport is unavailable');
        const chosen = selection.selected.length === 1 ? doc.nodes.get(selection.selected[0]) : undefined;
        const location = pointer === undefined ? options.pointer() : pointer;
        const target: ClipboardTarget = Object.freeze({ session: `${identity.documentId}:${identity.session}`,
            vaultEpoch: identity.vaultActivation, generation: identity.bytesGeneration, sheet: selection.sheet,
            viewport: Object.freeze({ x: camera.x, y: camera.y, w: viewport.width / camera.z, h: viewport.height / camera.z }),
            pointer: location ? Object.freeze({ ...location }) : null, selectedFrame: chosen?.kind === 'frame' ? chosen.id : null,
            pasteAtCursor: options.pasteAtCursor() });
        return { target, zoom: camera.z };
    };
    const targetCurrent = (target: Readonly<ClipboardTarget>) => current() && !session.isReadOnly
        && target.session === `${identity.documentId}:${identity.session}` && target.vaultEpoch === identity.vaultActivation
        && target.generation === identity.bytesGeneration && runtime.selection.getSnapshot().sheet === target.sheet;
    const execute = (input: Promise<ClipboardInput> | null, captured: ReturnType<typeof targetNow>, intent: ClipboardIntent,
        duplicate?: { snapshot: CopySnapshot; media: ReadonlyMap<MediaId, Blob> },
        imageRead?: Promise<ClipboardInput | null>) => {
        const controller = new AbortController();
        jobs.add(controller);
        const stop = runtime.selection.subscribe(() => {
            if (runtime.selection.getSnapshot().sheet !== captured.target.sheet) controller.abort();
        });
        const signal = AbortSignal.any([lifetime.signal, controller.signal]);
        pending++;
        const work = runtime.jobs.run(async context => {
            const { target, zoom } = captured, revision = doc.rev;
            const check = () => { context.assertCurrent(); if (!targetCurrent(target) || doc.rev !== revision) throw new DOMException('Clipboard target changed', 'AbortError'); };
            check();
            const workerIdentity: BoardJobIdentity = { session: context.job.session, epoch: context.job.vaultEpoch, revision };
            const workerCurrent = (job: BoardJobIdentity) => job.session === workerIdentity.session && job.epoch === workerIdentity.epoch
                && job.revision === revision && runtime.jobs.isCurrent(context.job) && targetCurrent(target) && doc.rev === revision;
            const insertAcquisition = async (acquired: BoardClipboardAcquisition, copied?: CopySnapshot) => {
                let staged: Awaited<ReturnType<typeof prepareBoardClipboardMediaInJob>> | undefined, transferred = false;
                try {
                    check();
                    staged = await prepareBoardClipboardMediaInJob({ runtime, acquisition: acquired, memory: options.memory,
                        current: () => targetCurrent(target) && doc.rev === revision, signal: context.signal,
                        readBlob: async (entry, readSignal) => (copied ? readNativeClipboardMedia(copied, entry.id) : null)
                            ?? options.readMedia(entry, readSignal), storeMedia: options.storeMedia }, context);
                    check();
                    const placement = planBoardClipboardPlacement({ receivingBoardId: identity.documentId, target, source: acquired.payload,
                        containsFrame: [...acquired.load.doc.nodes.values()].some(node => node.kind === 'frame'), doc, cameraZoom: zoom, intent });
                    transferred = true;
                    await insertNativeClipboard({ runtime, acquisition: acquired, media: staged, placement, target,
                        current: targetCurrent, signal: context.signal });
                } finally { if (!transferred) { staged?.release(); acquired.dispose(); } }
            };
            if (duplicate) {
                const acquired = await acquireCopiedBoardClipboard(duplicate.snapshot, { identity: workerIdentity, isCurrent: workerCurrent,
                    signal: context.signal, media: duplicate.media });
                await insertAcquisition(acquired, duplicate.snapshot);
                return;
            }
            if (!input) throw new Error('Clipboard input is unavailable');
            const capturedInput = await input; check();
            const html = createClipboardHtmlFrameHost({ memory: options.memory, identity: workerIdentity, isCurrent: workerCurrent });
            let classified = await classifyClipboard(capturedInput, intent, { appOrigin: location.origin,
                markers: html.markers, jsonKind: (text, innerSignal) => classifyClipboardJson({ bytes: new Blob([text]), identity: workerIdentity,
                    memory: options.memory, isCurrent: workerCurrent, signal: innerSignal }) }, context.signal);
            check();
            if (classified.kind === 'files' && imageRead) {
                const read = await imageRead; check();
                if (read?.privatePng) classified = { kind: 'private-png', blob: read.privatePng };
            }
            if (classified.kind === 'private') {
                const decoded = await decodeBoardClipboard({ encoded: new Blob([classified.encoded]), identity: workerIdentity,
                    memory: options.memory, isCurrent: workerCurrent, signal: context.signal });
                try {
                    check();
                    const plain = capturedInput.text ?? '', match = options.matchClipboard(classified.encoded, plain);
                    const acquired = await acquireBoardClipboard({ decoded, identity: workerIdentity, isCurrent: workerCurrent, signal: context.signal,
                        ...(match ? { cache: { match, encoded: classified.encoded, plain } } : {}) });
                    await insertAcquisition(acquired, match?.snapshot);
                } finally { decoded.release(); }
                return;
            }
            if (classified.kind === 'text' || classified.kind === 'url' || classified.kind === 'html') {
                let projection: Awaited<ReturnType<typeof html.projectHTML>> | undefined;
                try {
                    const content = classified.kind === 'text' ? { kind: 'plain' as const, text: classified.text }
                        : classified.kind === 'url' ? { kind: 'url' as const, url: classified.url }
                            : (projection = await html.projectHTML(classified.html, context.signal), { kind: 'rich' as const, fragment: projection.rich });
                    check();
                    if (projection?.dataImages.length) throw new Error('Pasting HTML with embedded images is not yet available');
                    await insertClipboardText({ runtime, target, current: targetCurrent, receivingBoardId: identity.documentId,
                        cameraZoom: zoom, intent, content, signal: context.signal });
                } finally { projection?.release(); }
                return;
            }
            if (classified.kind === 'files' || classified.kind === 'svg' || classified.kind === 'private-png') {
                const files = classified.kind === 'files' ? classified.files : classified.kind === 'svg'
                    ? [{ blob: new Blob([classified.text], { type: 'image/svg+xml' }), name: 'clipboard.svg', directory: false }]
                    : [{ blob: classified.blob, name: 'clipboard.png', directory: false }];
                const rejected = files.filter(file => file.directory);
                if (rejected.length) options.notice('Folders cannot be pasted onto a board.');
                const sources: MediaSource[] = files.filter(file => !file.directory).map(file => ({ blob: file.blob, name: file.name }));
                if (classified.kind === 'private-png') {
                    const density = await readPrivatePngDensity({ blob: classified.blob, signal: context.signal,
                        identity: workerIdentity, memory: options.memory, isCurrent: workerCurrent }); check();
                    if (density !== null) sources[0] = { ...sources[0], pixelsPerWorldUnit: density };
                    else options.notice('Clipboard PNG has no usable density; using ordinary image size.');
                }
                if (!sources.length) return;
                const placement = planBoardClipboardPlacement({ receivingBoardId: identity.documentId, target, source: { from: null, bounds: { x: 0, y: 0, w: 0, h: 0 } },
                    containsFrame: false, doc, cameraZoom: zoom, intent });
                const centre = placement.worldCentre, stack = boardPageStack(doc.host);
                let page = -1, x = centre.x, y = centre.y, rotation = 0;
                if (isSheetParent(doc, placement.parent)) {
                    if (stack) { page = pageAt(stack, y); const box = stack.rects[page]; if (!box) throw new Error('Target page is unavailable'); x -= box.x; y -= box.y; }
                } else {
                    const pose = worldPose(doc, placement.parent), dx = x - pose.x, dy = y - pose.y;
                    const c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
                    x = c * dx + s * dy; y = -s * dx + c * dy; rotation = -pose.rotation;
                }
                check();
                await options.ingestor.ingestInJob(sources, { origin: 'paste', placement: { parent: placement.parent, page, x, y, rotation }, signal: context.signal }, context);
                return;
            }
            if (classified.kind !== 'empty') throw new Error(`Clipboard ${classified.kind} conversion is not yet available`);
            options.notice('The clipboard has no supported board content.');
        }, { signal, deadlineMs: 120_000 });
        return work.finally(() => { stop(); jobs.delete(controller); controller.abort(); pending--; releaseRetired(); });
    };
    const report = (fn: () => void) => { try { fn(); } catch (error) { options.onError(error); } };
    const pasteEvent = (event: ClipboardEvent) => {
        if (options.editingText() || !event.clipboardData) return false;
        return (() => { try { const captured = targetNow(), input = captureTransfer(event.clipboardData!); event.preventDefault();
            const imageRead = input.files.some(file => file.blob.type.startsWith('image/')) ? readClipboard().catch(() => null) : undefined;
            void execute(Promise.resolve(input), captured, 'paste', undefined, imageRead).catch(options.onError); return true; }
            catch (error) { options.onError(error); return false; } })();
    };
    const readClipboard = async (): Promise<ClipboardInput> => {
        const clipboard = navigator.clipboard as Clipboard & { read(options: { unsanitized: string[] }): Promise<ClipboardItems> };
        const items = await clipboard.read({ unsanitized: ['text/html'] });
        let html: string | null = null, text: string | null = null, svg: string | null = null, privatePng: Blob | null = null;
        const files: ClipboardInput['files'][number][] = [];
        for (const item of items) for (const type of item.types) {
            const blob = await item.getType(type);
            if (type === 'text/html' && html === null) html = await blob.text();
            else if (type === 'text/plain' && text === null) text = await blob.text();
            else if (type === 'image/svg+xml' && svg === null) svg = await blob.text();
            else if (type === 'web image/x-board+png' && !privatePng) privatePng = blob;
            else if (type.startsWith('image/') || type.startsWith('video/')) files.push({ blob, name: `clipboard.${type.split('/')[1]}`, directory: false });
        }
        return { html, text, svg, uriList: null, files, privatePng };
    };
    return {
        pasteEvent,
        paste(intent: 'paste' | 'paste-inverted' | 'paste-plain' | 'paste-plain-inverted' = 'paste') {
            if (options.editingText()) return;
            report(() => { const target = targetNow(); const read = readClipboard(); void read.catch(() => {}); void execute(read, target, intent).catch(options.onError); });
        },
        keydown(event: KeyboardEvent) {
            if (options.editingText() || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'v' || (!event.altKey && !event.shiftKey)) return false;
            event.preventDefault();
            const intent = event.shiftKey ? event.altKey ? 'paste-plain-inverted' : 'paste-plain' : 'paste-inverted';
            report(() => { const target = targetNow(); const read = readClipboard(); void read.catch(() => {}); void execute(read, target, intent).catch(options.onError); });
            return true;
        },
        duplicate(snapshot: CopySnapshot): Promise<void> {
            const target = targetNow(), media = new Map<MediaId, Blob>();
            for (const entry of snapshot.media) {
                const blob = readNativeClipboardMedia(snapshot, entry.id);
                if (blob) media.set(entry.id, blob);
            }
            return execute(null, target, 'duplicate', { snapshot, media });
        },
        capturePaste(input: ClipboardInput, intent: ClipboardIntent): () => Promise<void> {
            const target = targetNow();
            let consumed = false;
            return () => {
                if (consumed) return Promise.reject(new Error('Clipboard capture was already consumed'));
                consumed = true; return execute(Promise.resolve(input), target, intent);
            };
        },
        importFiles(files: readonly File[], point: ClipboardPoint): Promise<void> {
            if (!files.length) return Promise.resolve();
            const target = targetNow(point);
            const input: ClipboardInput = { html: null, text: null, svg: null, uriList: null, privatePng: null,
                files: files.map(file => ({ blob: file, name: file.name, directory: false })) };
            return execute(Promise.resolve(input), target, 'drop');
        },
        cancelPending() {
            const cancelled = jobs.size > 0;
            for (const job of jobs) job.abort();
            return cancelled;
        },
        dragover: acceptsBoardDrag,
        drop(event: DragEvent) {
            if (!event.dataTransfer || !acceptsBoardDrag(event)) return false;
            report(() => { const point = surfaceToWorld(options.surfacePoint(event.clientX, event.clientY), options.camera.camera);
                const target = targetNow(point), input = captureTransfer(event.dataTransfer!); void execute(Promise.resolve(input), target, 'drop').catch(options.onError); });
            return true;
        },
        retire(onIdle: () => void) { if (disposed) { onIdle(); return; } retired = onIdle; releaseRetired(); },
        dispose() { if (!disposed) { disposed = true; lifetime.abort(); } },
    };
}
