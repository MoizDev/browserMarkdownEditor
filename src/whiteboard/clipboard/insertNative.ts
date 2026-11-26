import { pageAt } from '../../platform/render/pageStack';
import type { Op } from '../change/ops';
import { normalizedRotation, worldPose } from '../change/coordinates';
import { isLocked } from '../change/commands';
import { insertionBasis, rebaseInsertion, selectLanded } from '../change/insertionLanding';
import { acquireBoardGeometryScope } from '../commands/geometryScope';
import { notebookGrowthOp } from '../commands/pagesAndSheets';
import type { BoardClipboardAcquisition } from '../host/clipboardAcquisition';
import type { BoardRuntime } from '../host/runtime';
import { SampleStore } from '../ink/samples';
import type { SampleLease, SampleRef } from '../model/samples';
import type { NodeId, ParentId } from '../model/ids';
import { newNodeId } from '../model/ids';
import { isSheetParent, sheetOf } from '../model/doc';
import { createAddedBoardDoc } from '../model/overlayDoc';
import { extRawValues, nodeRawValues, scanRawMediaIncremental } from '../model/rawMedia';
import type { MediaEntry, MediaId } from '../model/media';
import type { RawJson } from '../model/json';
import { createNode, type ConnectorNode, type Node } from '../model/nodes';
import { keysBetween } from '../model/orderKey';
import { boardPageStack } from '../model/pages';
import type { BoardClipboardPlacement } from './placement';
import type { PreparedClipboardMedia } from './prepareMedia';
import type { ClipboardTarget } from './types';
import { yieldToHost } from '../../platform/yieldToHost';

// Provenance: C5 clipboard source, staged geometry, page membership and atomic
// transaction contracts; independent paste composition, no third-party source.
export interface InsertNativeClipboardOptions {
    readonly runtime: BoardRuntime;
    readonly acquisition: BoardClipboardAcquisition;
    readonly media: PreparedClipboardMedia;
    readonly placement: BoardClipboardPlacement;
    readonly target: Readonly<ClipboardTarget>;
    readonly receivingBoardId: string;
    /** External conversions have no source-board identity. */
    readonly external: boolean;
    /** Checks this captured target's session, epoch and generation, not the active pane. */
    current(target: Readonly<ClipboardTarget>): boolean;
    readonly signal?: AbortSignal;
    cooperate?(): Promise<void>;
}
/** Consumes acquisition and media, releasing both on success or failure. Callers must not reuse them without separate ownership. */
export async function insertNativeClipboard(options: InsertNativeClipboardOptions): Promise<readonly NodeId[]> {
    const { runtime, acquisition, media, placement } = options, session = runtime.session, doc = session.doc;
    const source = acquisition.load.doc, samples = runtime.samples;
    const target = Object.freeze({ ...options.target, viewport: Object.freeze({ ...options.target.viewport }),
        pointer: options.target.pointer ? Object.freeze({ ...options.target.pointer }) : null });
    const basis = insertionBasis(doc), owner = session.owner, targetSheet = target.sheet;
    const signal = options.signal ?? new AbortController().signal, leases: SampleLease[] = [];
    const check = () => {
        signal.throwIfAborted();
        // No revision fence: what lands is carried over to the board as it is then (rebaseInsertion).
        if (!options.current(target) || runtime.session !== session || session.owner !== owner || session.doc !== doc || session.isReadOnly
            || media.stamp.runtime !== runtime || media.stamp.doc !== doc
            || media.stamp.owner.documentId !== owner.documentId || media.stamp.owner.session !== owner.session
            || !doc.sheets.has(targetSheet) || runtime.selection.getSnapshot().sheet !== targetSheet) throw new DOMException('Clipboard target became stale', 'AbortError');
    };
    const cooperate = async () => { check(); await (options.cooperate?.() ?? yieldToHost()); check(); };
    let geometry: Awaited<ReturnType<typeof acquireBoardGeometryScope>> | undefined;
    try {
        if (!(samples instanceof SampleStore) || session.samples !== samples || !(acquisition.samples instanceof SampleStore)) throw new TypeError('Clipboard insertion requires session-owned sample stores');
        check();
        const parent = placement.parent;
        if (!isSheetParent(doc, parent)) {
            const frame = doc.nodes.get(parent as NodeId);
            if (!frame || frame.kind !== 'frame' || sheetOf(doc, frame.id) !== targetSheet || isLocked(doc, frame)) throw new Error('Clipboard target frame is unavailable');
        } else if (parent !== targetSheet) throw new Error('Clipboard target sheet changed');
        const sourceSheet = acquisition.payload.from.sheet;
        const sourceRoots = source.children.get(sourceSheet) ?? [];
        if (!sourceRoots.length) throw new Error('Clipboard has no source roots');
        if (!isSheetParent(doc, parent) && sourceRoots.some(node => node.kind === 'frame')) throw new Error('Frames cannot be pasted inside a frame');
        const reserved = new Set<NodeId>(), ids = new Map<NodeId, NodeId>(), copiedSamples = new Map<SampleRef, SampleRef>();
        const tables = { nodes: { has: (id: NodeId) => doc.nodes.has(id) || reserved.has(id) }, sheets: doc.sheets };
        let count = 0;
        for (const node of source.nodes.values()) {
            const id = newNodeId(tables); reserved.add(id); ids.set(node.id, id);
            if ((++count & 127) === 0) await cooperate();
        }
        const rootIds = new Set(sourceRoots.map(node => node.id)), originalCount = source.nodes.size;
        const mayReuseSamples = !options.external && acquisition.payload.from.board === options.receivingBoardId;
        const mayKeepExternal = mayReuseSamples && acquisition.payload.from.sheet === targetSheet;
        const remapAttachment = (attachment: ConnectorNode['start']['attach']) => {
            if (!attachment) return null;
            const mapped = ids.get(attachment.target);
            if (mapped) return { ...attachment, target: mapped };
            const targetNode = mayKeepExternal ? doc.nodes.get(attachment.target) : undefined;
            if (targetNode && targetNode.kind !== 'connector' && targetNode.kind !== 'group' && targetNode.kind !== 'opaque'
                && sheetOf(doc, targetNode.id) === targetSheet) return attachment;
            return null;
        };
        if (ids.size !== originalCount || !originalCount) throw new Error('Clipboard source identities are invalid');
        const siblings = doc.children.get(parent) ?? [], orders = keysBetween(siblings.at(-1)?.order ?? null, null, sourceRoots.length);
        const rootOrders = new Map<NodeId, string>();
        for (let i = 0; i < sourceRoots.length; i++) rootOrders.set(sourceRoots[i].id, orders[i]);
        const framePose = isSheetParent(doc, parent) ? null : worldPose(doc, parent);
        const stack = boardPageStack(doc.host), first = stack?.rects[0];
        if (stack && !first) throw new Error('Clipboard target page stack is unavailable');
        const additions: Node[] = [];
        for (const original of source.nodes.values()) {
            check();
            if (original.kind === 'opaque') throw new Error('Clipboard opaque content cannot be inserted');
            if (original.kind === 'group' && (source.children.get(original.id)?.length ?? 0) < 2) throw new Error('Clipboard contains an unstable group');
            const root = rootIds.has(original.id), newParent: ParentId | undefined = root ? parent : ids.get(original.parent as NodeId);
            if (!newParent) throw new Error('Clipboard contains an external parent');
            if (root && original.page !== -1) throw new Error('Clipboard root is not in world coordinates');
            let x = original.x, y = original.y, rotation = original.rotation, page = -1;
            if (root) {
                const wx = x + placement.delta.x, wy = y + placement.delta.y;
                if (framePose) {
                    const dx = wx - framePose.x, dy = wy - framePose.y, c = Math.cos(framePose.rotation), s = Math.sin(framePose.rotation);
                    x = c * dx + s * dy; y = -s * dx + c * dy; rotation = normalizedRotation(rotation - framePose.rotation);
                } else if (stack && first) { x = wx - first.x; y = wy - first.y; page = 0; }
                else { x = wx; y = wy; }
            }
            let node: Node = createNode({ ...original, id: ids.get(original.id)!, parent: newParent,
                order: root ? rootOrders.get(original.id)! : original.order, x, y, rotation, page });
            if (node.kind === 'stroke') {
                let ref = copiedSamples.get(node.samples);
                if (ref === undefined) {
                    const cached = mayReuseSamples ? acquisition.cachedSamples?.get(original.id) : undefined;
                    const lease = cached !== undefined && samples.has(cached) ? samples.retain(cached) : samples.importImmutable(acquisition.samples, node.samples);
                    leases.push(lease); ref = lease.ref; copiedSamples.set(node.samples, ref);
                }
                node = { ...node, samples: ref };
            } else if (node.kind === 'connector') {
                const external = acquisition.externalBindings?.get(original.id);
                node = { ...node, start: { ...node.start, attach: remapAttachment(external?.start ?? node.start.attach) },
                    end: { ...node.end, attach: remapAttachment(external?.end ?? node.end.attach) } };
            } else if (node.kind === 'polyline') {
                // Endpoint attachments are remapped with their polyline, never detached by changing its geometry.
                const line = node as typeof node & { readonly startAttach?: ConnectorNode['start']['attach']; readonly endAttach?: ConnectorNode['end']['attach'] };
                const external = acquisition.externalBindings?.get(original.id);
                const start = external?.start ?? line.startAttach, end = external?.end ?? line.endAttach;
                node = { ...line, ...(start === undefined ? {} : { startAttach: remapAttachment(start) }),
                    ...(end === undefined ? {} : { endAttach: remapAttachment(end) }) };
            }
            additions.push(node);
            if ((++count & 127) === 0) await cooperate();
        }
        const roots = sourceRoots.map(node => ids.get(node.id)!);
        const mediaEntries = new Map<MediaId, MediaEntry>(), preserved = new Map<MediaId, number>();
        const rawDelta = async (raw: RawJson, change: number, own?: MediaId) => {
            await scanRawMediaIncremental(raw, id => { if (id !== own) preserved.set(id, (preserved.get(id) ?? 0) + change); }, cooperate);
            check();
        };
        for (const node of additions) for (const raw of nodeRawValues(node)) {
            if (raw === null) await cooperate(); else await rawDelta(raw, 1);
        }
        for (const op of media.mediaOps) {
            if (op.t !== 'media') throw new Error('Unexpected clipboard media operation');
            if (op.op === 'add') {
                if (doc.media.has(op.entry.id) || mediaEntries.has(op.entry.id)) throw new Error('Clipboard media already exists');
                mediaEntries.set(op.entry.id, op.entry);
                for (const raw of extRawValues(op.entry.ext)) await rawDelta(raw, 1, op.entry.id);
            } else if (op.op === 'set-file' && !('restoreExt' in op)) {
                const old = mediaEntries.get(op.id) ?? doc.media.get(op.id);
                if (!old) throw new Error('Clipboard media location has no entry');
                const rawFile = old.ext?.raw.get('file');
                if (rawFile !== undefined) await rawDelta(rawFile, -1, op.id);
                let ext = old.ext;
                if (ext && rawFile !== undefined) { const raw = new Map(ext.raw); raw.delete('file'); ext = { ...ext, raw }; }
                mediaEntries.set(op.id, { ...old, file: op.file, ext });
            } else throw new Error('Unexpected clipboard media operation');
        }
        const candidate = createAddedBoardDoc(doc, additions, [...mediaEntries.values()], preserved);
        geometry = await acquireBoardGeometryScope(runtime, roots, { doc: candidate, signal, current: () => { check(); return true; }, cooperate });
        check();
        let deepest = -Infinity;
        const worldBounds = new Map<NodeId, ReturnType<typeof geometry.logicalBounds>>();
        for (const id of roots) { const bounds = geometry.logicalBounds(id); worldBounds.set(id, bounds); deepest = Math.max(deepest, bounds.y + bounds.height); }
        const growth = doc.host.kind === 'notebook' ? notebookGrowthOp(doc, deepest) : undefined;
        const grownHost = growth?.key === 'host.paper' && doc.host.kind === 'notebook' ? { ...doc.host, paper: growth.value } : doc.host;
        const grownStack = boardPageStack(grownHost);
        const newRoots = new Set(roots);
        const finalNodes = additions.map(node => {
            if (!newRoots.has(node.id) || framePose || !grownStack) return node;
            const bounds = worldBounds.get(node.id)!;
            const page = pageAt(grownStack, bounds.y + bounds.height / 2), target = grownStack.rects[page];
            if (!target || !first) throw new Error('Clipboard destination page is unavailable');
            return { ...node, x: node.x + first.x - target.x, y: node.y + first.y - target.y, page };
        });
        const byId = new Map(finalNodes.map(node => [node.id, node]));
        const ordered: Node[] = [], pending = [...roots].reverse();
        while (pending.length) {
            const id = pending.pop()!, node = byId.get(id);
            if (!node) throw new Error('Clipboard hierarchy is incomplete');
            ordered.push(node);
            const children = candidate.children.get(id) ?? [];
            for (let i = children.length - 1; i >= 0; i--) pending.push(children[i].id);
            if ((++count & 127) === 0) await cooperate();
        }
        if (ordered.length !== finalNodes.length) throw new Error('Clipboard contains unreachable nodes');
        const ops: Op[] = [...media.mediaOps, ...(growth ? [growth] : []), ...ordered.map(node => ({ t: 'create' as const, node }))];
        check();
        const result = await session.enqueueAfterGesture(signal, () => {
            check();
            session.history.open('Paste');
            try {
                const applied = session.apply({ origin: 'paste', label: 'Paste', ops: rebaseInsertion(doc, basis, ops) });
                try {
                    for (const [id, file] of media.files) runtime.media.setFile(id, file);
                    media.committed();
                    selectLanded(runtime.selection.getSnapshot(), target.selection, () => runtime.selection.setScope(parent, roots));
                } finally { applied.release(); }
                return Object.freeze([...roots]);
            } finally { session.history.close(); }
        });
        return result;
    } finally {
        geometry?.release(); for (const lease of leases) lease.release(); media.release(); acquisition.dispose();
    }
}
