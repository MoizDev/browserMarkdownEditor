import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import { pageAt } from '../../platform/render/pageStack';
import { normalizedRotation, worldPose } from '../change/coordinates';
import type { Op } from '../change/ops';
import { acquireBoardGeometryScope } from '../commands/geometryScope';
import { notebookGrowthOp } from '../commands/pagesAndSheets';
import type { BoardRuntime } from '../host/runtime';
import { inspectMedia } from '../media/inspect';
import type { MediaLease } from '../media/store';
import { isSheetParent } from '../model/doc';
import { newNodeId, type NodeId } from '../model/ids';
import { isSafeMediaFile, type MediaEntry, type MediaId } from '../model/media';
import { createPicture, createText, type Node } from '../model/nodes';
import { createAddedBoardDoc } from '../model/overlayDoc';
import { keysBetween } from '../model/orderKey';
import { boardPageStack } from '../model/pages';
import type { JobContext } from '../security/admission';
import type { BoardJobIdentity } from '../workers/protocol';
import type { ClipboardHtmlFrameHost } from './htmlFrameHost';
import { insertClipboardText } from './insertText';
import { planBoardClipboardPlacement } from './placement';
import type { ClipboardIntent, ClipboardTarget } from './types';

// Provenance: isolated HTML projection, verified media staging and one-step
// clipboard insertion; independent composition, no upstream engine source.
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
    storeMedia(entry: MediaEntry, blob: Blob, signal: AbortSignal): Promise<string | null>;
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
    const cooperate = async () => { check(); await (options.cooperate?.() ?? new Promise<void>(resolve => setTimeout(resolve, 0))); check(); };
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
        const records = new Map<MediaId, { entry: MediaEntry; blob: Blob; file: string | null }>();
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
                    const file = await options.storeMedia(entry, image.blob, context.signal); check();
                    if (!isSafeMediaFile(file)) throw new Error('Invalid stored image name');
                    if (old && old.file !== file && (old.ext?.raw.size || old.ext?.fields.size || (doc.preservedMediaRefs.get(info.id) ?? 0) > 0)) {
                        throw new Error('Cannot remap an image with preserved filename dependencies');
                    }
                    const blob = new Blob([image.blob], { type: info.mime });
                    leases.push(runtime.media.retain(info.id, 'snapshot')); runtime.media.put(info.id, blob);
                    item = { entry: old ?? { ...entry, file }, blob, file }; records.set(info.id, item);
                }
                const scale = Math.min(1, 5000 / Math.max(info.width, info.height));
                images.push({ id: info.id, alt: image.alt.slice(0, 10_000), width: info.width * scale, height: info.height * scale });
            } catch (error) {
                check(); refused.push({ name: image.alt || 'Clipboard image', reason: error instanceof Error ? error.message : 'Image could not be read' });
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
            textNode = width > 1200 ? { ...textNode, autoSize: false, w: 600 } : { ...textNode, w: width };
            scope.release(); scope = undefined; candidate = createAddedBoardDoc(doc, [textNode]);
            scope = await acquireBoardGeometryScope(runtime, [textNode.id], { doc: candidate, signal: context.signal, current: () => { check(); return true; }, cooperate }); check();
            textBounds = scope.logicalBounds(textNode.id); scope.release(); scope = undefined;
        }
        const height = Math.max(textBounds?.height ?? 0, ...images.map(item => item.height));
        const width = (textBounds?.width ?? 0) + images.reduce((sum, image) => sum + image.width, 0);
        if (!Number.isFinite(width) || !Number.isFinite(height)) throw new RangeError('HTML content bounds overflow');
        const placement = planBoardClipboardPlacement({ receivingBoardId: options.receivingBoardId, target, doc, cameraZoom: options.cameraZoom,
            intent: options.intent, containsFrame: false, source: { from: null, bounds: { x: 0, y: 0, w: width, h: height } } });
        const parent = placement.parent, siblings = doc.children.get(parent) ?? [];
        const orders = keysBetween(siblings.at(-1)?.order ?? null, null, images.length + (textNode ? 1 : 0));
        const worldNodes: Node[] = []; let left = 0, order = 0;
        if (textNode && textBounds) {
            worldNodes.push({ ...textNode, order: orders[order++], page: -1, x: -textBounds.x, y: (height - textBounds.height) / 2 - textBounds.y });
            left += textBounds.width;
        }
        for (const image of images) {
            worldNodes.push(createPicture({ id: allocate(), parent: target.sheet, order: orders[order++], page: -1, x: left, y: (height - image.height) / 2,
                ext: null, w: image.width, h: image.height, media: image.id, crop: null, flipX: false, flipY: false, alt: image.alt,
                inverted: false, playing: true, url: null }));
            left += image.width;
        }
        const pose = isSheetParent(doc, parent) ? null : worldPose(doc, parent);
        let additions = worldNodes.map(node => {
            const wx = node.x + placement.delta.x, wy = node.y + placement.delta.y;
            if (pose) {
                const dx = wx - pose.x, dy = wy - pose.y, c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
                return { ...node, parent, x: c * dx + s * dy, y: -s * dx + c * dy, rotation: normalizedRotation(-pose.rotation), page: -1 } as Node;
            }
            return { ...node, parent, x: wx - (first?.x ?? 0), y: wy - (first?.y ?? 0), page: stack ? 0 : -1 } as Node;
        });
        const mediaEntries = [...records.values()].map(item => ({ ...item.entry, file: item.file }));
        const candidate = createAddedBoardDoc(doc, additions, mediaEntries), ids = additions.map(node => node.id);
        scope = await acquireBoardGeometryScope(runtime, ids, { doc: candidate, signal: context.signal, current: () => { check(); return true; }, cooperate }); check();
        let deepest = -Infinity; const bounds = new Map<NodeId, ReturnType<typeof scope.logicalBounds>>();
        for (const id of ids) { const box = scope.logicalBounds(id); bounds.set(id, box); deepest = Math.max(deepest, box.y + box.height); }
        const growth = doc.host.kind === 'notebook' ? notebookGrowthOp(doc, deepest) : undefined;
        const host = growth?.key === 'host.paper' && doc.host.kind === 'notebook' ? { ...doc.host, paper: growth.value } : doc.host;
        const grown = boardPageStack(host);
        if (!pose && grown && first) additions = additions.map(node => {
            const box = bounds.get(node.id)!, page = pageAt(grown, box.y + box.height / 2), origin = grown.rects[page];
            if (!origin) throw new Error('HTML destination page is unavailable');
            return { ...node, x: node.x + first.x - origin.x, y: node.y + first.y - origin.y, page } as Node;
        });
        const ops: Op[] = [];
        for (const item of records.values()) {
            const old = doc.media.get(item.entry.id);
            if (!old) ops.push({ t: 'media', op: 'add', entry: item.entry });
            else if (old.file !== item.file) ops.push({ t: 'media', op: 'set-file', id: old.id, file: item.file });
        }
        if (growth) ops.push(growth);
        for (const node of additions) ops.push({ t: 'create', node });
        check();
        return await session.enqueueAfterGesture(context.signal, () => {
            check(); session.history.open('Paste');
            try {
                const applied = session.apply({ origin: 'paste', label: 'Paste', ops });
                try { for (const item of records.values()) runtime.media.setFile(item.entry.id, item.file); runtime.selection.setScope(parent, ids); }
                finally { applied.release(); }
                return Object.freeze(ids);
            } finally { session.history.close(); }
        });
    } finally { scope?.release(); for (const lease of leases) lease.release(); projected.release(); }
}
export function pasteClipboardHtml(options: HtmlClipboardPasteOptions, signal?: AbortSignal): Promise<readonly NodeId[]> {
    return options.runtime.jobs.run(context => pasteClipboardHtmlInJob(options, context), { signal, deadlineMs: 120_000 });
}
