import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import { acquireBoardGeometryScope } from '../commands/geometryScope';
import type { BoardRuntime } from '../host/runtime';
import type { BoardClipboardAcquisition } from '../host/clipboardAcquisition';
import { inspectMedia } from '../media/inspect';
import type { MediaLease } from '../media/store';
import type { StoreMedia } from '../media/storage.types';
import { newNodeId, type NodeId, type SheetId } from '../model/ids';
import type { MediaEntry, MediaId } from '../model/media';
import { createPicture, createText, type Node } from '../model/nodes';
import { createAddedBoardDoc } from '../model/overlayDoc';
import { keysBetween } from '../model/orderKey';
import { boardPageStack } from '../model/pages';
import type { JobContext } from '../security/admission';
import type { BoardJobIdentity } from '../workers/protocol';
import type { ClipboardHtmlFrameHost } from './htmlFrameHost';
import { insertClipboardText, pastedTextFit } from './insertText';
import { insertNativeClipboard } from './insertNative';
import { prepareBoardClipboardMediaInJob } from './prepareMedia';
import { planBoardClipboardPlacement } from './placement';
import type { ClipboardIntent, ClipboardTarget } from './types';
import { yieldToHost } from '../../platform/yieldToHost';

// Provenance: isolated HTML projection, verified media staging and one-step
// clipboard insertion; independent composition, no upstream engine source.
export interface HtmlClipboardSource {
    readonly provisionalSheet: SheetId;
    readonly nodes: readonly Node[];
    readonly media: readonly MediaEntry[];
    readonly blobs: ReadonlyMap<MediaId, Blob>;
}
export interface HtmlClipboardPasteOptions {
    readonly runtime: BoardRuntime;
    readonly memory: MemoryAllocator;
    readonly frame: Pick<ClipboardHtmlFrameHost, 'projectHTML'>;
    readonly html: string;
    readonly target: Readonly<ClipboardTarget>;
    readonly intent: ClipboardIntent;
    readonly receivingBoardId: string;
    readonly cameraZoom: number;
    current(target: Readonly<ClipboardTarget>): boolean;
    readonly storeMedia: StoreMedia;
    /** Real native encoding, C5 admission and canonical source geometry. */
    admitSource(source: HtmlClipboardSource, context: JobContext, identity: BoardJobIdentity): Promise<{
        readonly acquisition: BoardClipboardAcquisition; readonly bounds: Readonly<{ x: number; y: number; w: number; h: number }>;
    }>;
    noticeRefused(items: readonly { readonly name: string; readonly reason: string }[]): void;
    cooperate?(): Promise<void>;
}
export async function pasteClipboardHtmlInJob(options: HtmlClipboardPasteOptions, context: JobContext): Promise<readonly NodeId[]> {
    const { runtime } = options, session = runtime.session, doc = session.doc, revision = doc.rev, owner = session.owner;
    const target = Object.freeze({ ...options.target, viewport: Object.freeze({ ...options.target.viewport }),
        pointer: options.target.pointer ? Object.freeze({ ...options.target.pointer }) : null });
    const check = () => {
        runtime.jobs.assertContext(context); context.assertCurrent();
        if (!options.current(target) || runtime.session !== session || session.doc !== doc || doc.rev !== revision
            || session.owner !== owner || session.isReadOnly || runtime.selection.getSnapshot().sheet !== target.sheet) throw new DOMException('HTML paste became stale', 'AbortError');
    };
    const cooperate = async () => { check(); await (options.cooperate?.() ?? yieldToHost()); check(); };
    const identity: BoardJobIdentity = Object.freeze({ session: context.job.session, epoch: context.job.vaultEpoch, revision });
    const current = (job: BoardJobIdentity) => job.session === identity.session && job.epoch === identity.epoch && job.revision === revision
        && runtime.jobs.isCurrent(context.job) && options.current(target) && session.doc === doc && doc.rev === revision;
    check();
    const projected = await options.frame.projectHTML(options.html, context.signal);
    const leases: MediaLease[] = [];
    let scope: Awaited<ReturnType<typeof acquireBoardGeometryScope>> | undefined;
    try {
        check();
        const refused = projected.refusedImages.map(item => ({ ...item }));
        if (!projected.dataImages.length) {
            if (refused.length) options.noticeRefused(refused);
            const id = await insertClipboardText({ runtime, target, current: options.current, receivingBoardId: options.receivingBoardId,
                cameraZoom: options.cameraZoom, intent: options.intent, content: { kind: 'rich', fragment: projected.rich }, signal: context.signal, cooperate: options.cooperate });
            return id ? [id as NodeId] : [];
        }
        const records = new Map<MediaId, { entry: MediaEntry; blob: Blob }>();
        const images: { id: MediaId; alt: string; width: number; height: number }[] = [];
        for (const image of projected.dataImages) {
            check();
            try {
                const info = await inspectMedia(image.blob, { memory: options.memory, identity, isCurrent: current, signal: context.signal }); check();
                if (!info.mime.startsWith('image/') || info.duration !== null) throw new Error('HTML image bytes are not a supported picture');
                let item = records.get(info.id);
                if (!item) {
                    const old = doc.media.get(info.id);
                    if (old && (old.mime !== info.mime || old.bytes !== image.blob.size || old.w !== info.width || old.h !== info.height
                        || old.duration !== null || old.animated !== info.animated)) throw new Error('Existing image metadata conflicts with verified bytes');
                    const entry: MediaEntry = old ?? { id: info.id, mime: info.mime, bytes: image.blob.size, w: info.width, h: info.height,
                        duration: null, animated: info.animated, name: image.alt.slice(0, 10_000), file: null, ext: null };
                    const blob = new Blob([image.blob], { type: info.mime });
                    leases.push(runtime.media.retain(info.id, 'snapshot')); runtime.media.put(info.id, blob);
                    // Admission first; the final shared media stage performs
                    // storage exactly once under this same job and one receipt.
                    item = { entry, blob }; records.set(info.id, item);
                }
                const scale = Math.min(1, 5000 / Math.max(info.width, info.height));
                images.push({ id: info.id, alt: image.alt.slice(0, 10_000), width: info.width * scale, height: info.height * scale });
            } catch (error) {
                check(); refused.push({ name: image.alt.slice(0, 10_000) || 'Clipboard image',
                    reason: error instanceof Error ? error.message.slice(0, 500) : 'Image could not be read' });
            }
            await cooperate();
        }
        if (refused.length) options.noticeRefused(refused);
        const textLength = projected.rich.blocks.reduce((total, block) => total + block.runs.reduce((count, run) => count + run.text.length, 0), projected.rich.blocks.length - 1);
        if (!images.length && !textLength) return [];
        const reserved = new Set<NodeId>();
        const allocate = () => { const id = newNodeId({ nodes: { has: id => doc.nodes.has(id) || reserved.has(id) }, sheets: doc.sheets }); reserved.add(id); return id; };
        const textId = textLength ? allocate() : undefined, stack = boardPageStack(doc.host), first = stack?.rects[0];
        if (stack && !first) throw new Error('Clipboard target page is unavailable');
        const style = { ...doc.ui.next }, initialSiblings = doc.children.get(target.sheet) ?? [];
        const initialOrder = keysBetween(initialSiblings.at(-1)?.order ?? null, null, 1)[0];
        let textNode = textId ? createText({ id: textId, parent: target.sheet, order: initialOrder, page: stack ? 0 : -1,
            x: -(first?.x ?? 0), y: -(first?.y ?? 0), ext: null, text: projected.rich,
            color: style.color, size: style.size, font: style.font, align: style.textAlign, autoSize: true, w: 1, scale: 1 }) : undefined;
        let textBounds: { x: number; y: number; width: number; height: number } | undefined;
        if (textNode) {
            let candidate = createAddedBoardDoc(doc, [textNode]);
            scope = await acquireBoardGeometryScope(runtime, [textNode.id], { doc: candidate, signal: context.signal, current: () => { check(); return true; }, cooperate }); check();
            const prepared = runtime.render.text.prepareNow(textNode, { revision: `html:${textNode.id}:${revision}` });
            if (!prepared) throw new Error('HTML text layout is unavailable');
            const width = Math.max(1, prepared.paint.box.w);
            if (!Number.isFinite(width)) throw new Error('HTML text layout is invalid');
            textNode = { ...textNode, ...pastedTextFit(width, textNode.text.blocks.length, target.viewport.w) };
            scope.release(); scope = undefined; candidate = createAddedBoardDoc(doc, [textNode]);
            scope = await acquireBoardGeometryScope(runtime, [textNode.id], { doc: candidate, signal: context.signal, current: () => { check(); return true; }, cooperate }); check();
            textBounds = scope.logicalBounds(textNode.id); scope.release(); scope = undefined;
        }
        const height = Math.max(textBounds?.height ?? 0, ...images.map(item => item.height));
        const width = (textBounds?.width ?? 0) + images.reduce((sum, image) => sum + image.width, 0);
        if (!Number.isFinite(width) || !Number.isFinite(height)) throw new RangeError('HTML content bounds overflow');
        const orders = keysBetween(null, null, images.length + (textNode ? 1 : 0));
        const worldNodes: Node[] = []; let left = 0, order = 0;
        if (textNode && textBounds) {
            worldNodes.push({ ...textNode, order: orders[order++], page: -1, x: -textBounds.x, y: (height - textBounds.height) / 2 - textBounds.y });
            left += textBounds.width;
        }
        for (const image of images) {
            worldNodes.push(createPicture({ id: allocate(), parent: target.sheet, order: orders[order++], page: -1, x: left, y: (height - image.height) / 2,
                ext: null, w: image.width, h: image.height, media: image.id, crop: null, flipX: false, flipY: false, alt: image.alt,
                inverted: false, url: null }));
            left += image.width;
        }
        const source: HtmlClipboardSource = { provisionalSheet: target.sheet, nodes: Object.freeze(worldNodes),
            media: Object.freeze([...records.values()].map(item => item.entry)),
            blobs: new Map([...records].map(([id, item]) => [id, item.blob])) };
        let acquisition: BoardClipboardAcquisition | undefined;
        try {
            const admitted = await options.admitSource(source, context, identity); acquisition = admitted.acquisition; check();
            const placement = planBoardClipboardPlacement({ receivingBoardId: options.receivingBoardId, target, doc,
                cameraZoom: options.cameraZoom, intent: options.intent, containsFrame: false,
                source: { from: null, bounds: admitted.bounds } });
            const media = await prepareBoardClipboardMediaInJob({ runtime, acquisition, memory: options.memory, signal: context.signal,
                current: () => current(identity), readBlob: async entry => records.get(entry.id)?.blob ?? null,
                storeMedia: options.storeMedia, cooperate: options.cooperate }, context);
            try {
                check();
                if (media.missing.length) throw new Error('An admitted HTML image lost its verified bytes');
                const owned = acquisition; acquisition = undefined;
                return await insertNativeClipboard({ runtime, acquisition: owned, media, placement, target,
                    receivingBoardId: options.receivingBoardId, external: true, current: options.current,
                    signal: context.signal, cooperate: options.cooperate });
            } finally { media.release(); }
        } finally { acquisition?.dispose(); }
    } finally { scope?.release(); for (const lease of leases) lease.release(); projected.release(); }
}
export function pasteClipboardHtml(options: HtmlClipboardPasteOptions, signal?: AbortSignal): Promise<readonly NodeId[]> {
    return options.runtime.jobs.run(context => pasteClipboardHtmlInJob(options, context), { signal, deadlineMs: 120_000 });
}
