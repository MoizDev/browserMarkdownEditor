import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import { pageAt } from '../../platform/render/pageStack';
import { isLocked, selectedRoots } from '../change/commands';
import { normalizedRotation, worldPose } from '../change/coordinates';
import { planDelete } from '../commands/delete';
import { notebookGrowthOp } from '../commands/pagesAndSheets';
import type { BoardRuntime } from '../host/runtime';
import { hasOpaqueDescendant, isSheetParent } from '../model/doc';
import { newNodeId, type NodeId } from '../model/ids';
import { isSafeMediaFile, type MediaEntry } from '../model/media';
import { createPicture } from '../model/nodes';
import { boardPageStack } from '../model/pages';
import type { BoardJobIdentity } from '../workers/protocol';
import { inspectMedia } from './inspect';

// Provenance: media §10a, actual export capture and atomic delete/create
// contracts; independent transaction, no upstream engine source.
export interface FlattenCapture {
    readonly blob: Blob;
    readonly bounds: Readonly<{ x: number; y: number; width: number; height: number }>;
    /** Topmost actually captured root, not a guessed z-order. */
    readonly topmost: NodeId;
    release(): void;
}
export interface FlattenOptions {
    readonly runtime: BoardRuntime;
    readonly memory: MemoryAllocator;
    readonly signal?: AbortSignal;
    current(): boolean;
    /** Capture must use the canonical ordered paint stream, excluding these locked subtrees. */
    capture(roots: readonly NodeId[], excludedLocked: readonly NodeId[], signal: AbortSignal): Promise<FlattenCapture>;
    storeMedia(entry: MediaEntry, blob: Blob, signal: AbortSignal): Promise<string | null>;
}
export function flattenSelectionToImage(options: FlattenOptions): Promise<NodeId | null> {
    const { runtime } = options, session = runtime.session, doc = session.doc, revision = doc.rev, owner = session.owner;
    const selection = runtime.selection.getSnapshot(), roots = selectedRoots(doc, selection.selected).filter(node => !isLocked(doc, node));
    for (const node of roots) if (node.kind === 'opaque' || hasOpaqueDescendant(doc, node.id)) throw new Error('Opaque content cannot be flattened');
    if (!roots.length) return Promise.resolve(null);
    const ids = roots.map(node => node.id), rootSet = new Set(ids), excluded: NodeId[] = [], seen = new Set<NodeId>();
    const pending = [...roots];
    while (pending.length) {
        const node = pending.pop()!; if (seen.has(node.id)) continue; seen.add(node.id);
        if (node.locked) { excluded.push(node.id); continue; }
        for (const child of doc.children.get(node.id) ?? []) pending.push(child);
    }
    return runtime.jobs.run(async context => {
        const identity: BoardJobIdentity = Object.freeze({ session: context.job.session, epoch: context.job.vaultEpoch, revision });
        const current = (value: BoardJobIdentity) => value.session === identity.session && value.epoch === identity.epoch && value.revision === revision
            && runtime.jobs.isCurrent(context.job) && options.current() && session.doc === doc && doc.rev === revision && session.owner === owner;
        const check = () => { context.assertCurrent(); if (!current(identity) || session.isReadOnly || runtime.selection.getSnapshot() !== selection) throw new DOMException('Flatten target became stale', 'AbortError'); };
        let captured: FlattenCapture | undefined, geometry: { release(): void } | undefined, mediaLease: { release(): void } | undefined;
        try {
            check();
            geometry = await runtime.render.pinChangeGeometry(ids, context.signal, doc, () => current(identity)); check();
            captured = await options.capture(ids, excluded, context.signal); check();
            const bounds = captured.bounds, top = doc.nodes.get(captured.topmost);
            if (!rootSet.has(captured.topmost) || !top || !(captured.blob instanceof Blob) || !bounds
                || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
                || bounds.width <= 0 || bounds.height <= 0 || bounds.width > 1_000_000 || bounds.height > 1_000_000) throw new Error('Invalid flatten capture');
            const blob = new Blob([captured.blob], { type: 'image/png' });
            const info = await inspectMedia(blob, { memory: options.memory, identity, isCurrent: current, signal: context.signal }); check();
            if (info.mime !== 'image/png' || info.duration !== null || info.animated) throw new Error('Flatten capture is not a still PNG');
            const old = doc.media.get(info.id);
            if (old && (old.mime !== info.mime || old.bytes !== blob.size || old.w !== info.width || old.h !== info.height || old.animated !== info.animated)) throw new Error('Existing media metadata conflicts with flatten capture');
            const entry: MediaEntry = old ?? { id: info.id, mime: info.mime, bytes: blob.size, w: info.width, h: info.height,
                duration: null, animated: false, name: 'Flattened selection', file: null, ext: null };
            const file = await options.storeMedia(entry, blob, context.signal); check();
            // Flatten deletes the vector originals. A cache-only/missing asset
            // would survive until reload and then lose the user's actual drawing.
            if (file === null || !isSafeMediaFile(file)) throw new Error('The flattened image could not be stored');
            if (old && old.file !== file && (old.ext?.raw.size || old.ext?.fields.size || (doc.preservedMediaRefs.get(info.id) ?? 0) > 0)) throw new Error('Cannot remap preserved image metadata');
            mediaLease = runtime.media.retain(info.id, 'snapshot'); runtime.media.put(info.id, blob);
            const growth = doc.host.kind === 'notebook' ? notebookGrowthOp(doc, bounds.y + bounds.height) : undefined;
            const host = growth?.key === 'host.paper' && doc.host.kind === 'notebook' ? { ...doc.host, paper: growth.value } : doc.host;
            const stack = boardPageStack(host), parent = top.parent;
            let page = -1, x = bounds.x, y = bounds.y, rotation = 0;
            if (isSheetParent(doc, parent)) {
                if (stack) { page = pageAt(stack, bounds.y + bounds.height / 2); const origin = stack.rects[page];
                    if (!origin) throw new Error('Flatten destination page is unavailable'); x -= origin.x; y -= origin.y; }
            } else {
                const pose = worldPose(doc, parent), dx = x - pose.x, dy = y - pose.y, c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
                x = c * dx + s * dy; y = -s * dx + c * dy; rotation = normalizedRotation(-pose.rotation);
            }
            const id = newNodeId(doc), picture = createPicture({ id, parent, order: top.order, page, x, y, rotation, ext: null,
                w: bounds.width, h: bounds.height, media: info.id, crop: null, flipX: false, flipY: false,
                alt: '', inverted: false, url: null });
            check();
            return await session.enqueueAfterGesture(context.signal, () => {
                check(); session.history.open('Flatten to image');
                let builder: ReturnType<typeof session.begin> | undefined;
                try {
                    builder = session.begin('host', 'Flatten to image');
                    if (!old) builder.push({ t: 'media', op: 'add', entry: { ...entry, file } });
                    else if (old.file !== file) builder.push({ t: 'media', op: 'set-file', id: info.id, file });
                    if (growth) builder.push(growth);
                    planDelete(doc, builder, selection.sheet, ids, runtime.render.changeGeometry);
                    builder.push({ t: 'create', node: picture });
                    const applied = builder.commit(); builder = undefined;
                    try { runtime.media.setFile(info.id, file); runtime.selection.setScope(parent, [id]); }
                    finally { applied.release(); }
                    return id;
                } finally { builder?.abort(); session.history.close(); }
            });
        } finally { mediaLease?.release(); captured?.release(); geometry?.release(); }
    }, { signal: options.signal, deadlineMs: 120_000 });
}
