import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import { isLocked } from '../change/commands';
import type { NodeSetOp, Op } from '../change/ops';
import { acquireBoardGeometryScope } from '../commands/geometryScope';
import { notebookGrowthOp } from '../commands/pagesAndSheets';
import type { BoardRuntime } from '../host/runtime';
import type { NodeId } from '../model/ids';
import { isSafeMediaFile, type MediaEntry } from '../model/media';
import { projectBoardGeometrySets } from '../model/overlayDoc';
import type { BoardJobIdentity } from '../workers/protocol';
import { inspectMedia } from './inspect';

// Provenance: media MD-1, replace-picture centre/long-side rule and C4/C5
// session authority; independent transaction composition, no upstream source.
export function replacePicture(options: {
    readonly runtime: BoardRuntime; readonly memory: MemoryAllocator; readonly id: NodeId;
    readonly bytes: Blob; readonly name: string; readonly signal?: AbortSignal;
    current(): boolean;
    storeMedia(entry: MediaEntry, blob: Blob, signal: AbortSignal): Promise<string | null>;
}): Promise<void> {
    if (!(options.bytes instanceof Blob) || typeof options.name !== 'string' || options.name.length > 10_000) return Promise.reject(new TypeError('Invalid replacement image'));
    const bytes = new Blob([options.bytes], { type: options.bytes.type }), { runtime } = options, session = runtime.session, doc = session.doc, owner = session.owner;
    return runtime.jobs.run(async context => {
        const revision = doc.rev, node = doc.nodes.get(options.id);
        if (!node || node.kind !== 'picture') throw new Error('Picture no longer exists');
        const identity: BoardJobIdentity = Object.freeze({ session: context.job.session, epoch: context.job.vaultEpoch, revision });
        const current = (value: BoardJobIdentity) => value.session === identity.session && value.epoch === identity.epoch && value.revision === revision
            && runtime.jobs.isCurrent(context.job) && options.current() && runtime.session === session && session.owner === owner
            && session.doc === doc && doc.rev === revision && doc.nodes.get(options.id) === node && !session.isReadOnly && !isLocked(doc, node);
        const check = () => { context.assertCurrent(); if (!current(identity)) throw new DOMException('Replacement target became stale', 'AbortError'); };
        let lease: { release(): void } | undefined, scope: Awaited<ReturnType<typeof acquireBoardGeometryScope>> | undefined;
        try {
            check();
            const info = await inspectMedia(bytes, { memory: options.memory, identity, isCurrent: current, signal: context.signal }); check();
            if (!info.mime.startsWith('image/') || info.duration !== null) throw new Error('Replacement is not a supported image');
            const existing = doc.media.get(info.id);
            if (existing && (existing.mime !== info.mime || existing.bytes !== bytes.size || existing.w !== info.width || existing.h !== info.height
                || existing.duration !== null || existing.animated !== info.animated)) throw new Error('Existing image metadata conflicts with verified bytes');
            const entry: MediaEntry = existing ?? { id: info.id, mime: info.mime, bytes: bytes.size, w: info.width, h: info.height,
                duration: null, animated: info.animated, name: options.name, file: null, ext: null };
            const location = existing ? runtime.media.currentFile(info.id) : undefined;
            const oldFile = existing ? location === undefined ? existing.file : location : null;
            const file = await options.storeMedia({ ...entry, file: oldFile }, bytes, context.signal); check();
            if (!isSafeMediaFile(file)) throw new Error('Invalid stored image name');
            if (existing && file !== existing.file && (existing.ext?.raw.size || existing.ext?.fields.size || (doc.preservedMediaRefs.get(info.id) ?? 0) > 0)) {
                throw new Error('Cannot remap preserved image metadata');
            }
            lease = runtime.media.retain(info.id, 'snapshot'); runtime.media.put(info.id, bytes);
            const longest = Math.max(node.w, node.h), scale = longest / Math.max(info.width, info.height);
            const w = info.width * scale, h = info.height * scale, dx = (node.w - w) / 2, dy = (node.h - h) / 2;
            const c = Math.cos(node.rotation), s = Math.sin(node.rotation), x = node.x + c * dx - s * dy, y = node.y + s * dx + c * dy;
            if (![x, y, w, h].every(Number.isFinite) || w < 1 || h < 1) throw new RangeError('Replacement image geometry is invalid');
            const geometry: NodeSetOp[] = [
                { t: 'set', id: node.id, key: 'x', value: x }, { t: 'set', id: node.id, key: 'y', value: y },
                { t: 'set', id: node.id, key: 'w', value: w }, { t: 'set', id: node.id, key: 'h', value: h },
            ];
            const candidate = await projectBoardGeometrySets(doc, geometry, { signal: context.signal, current: () => current(identity) }); check();
            scope = await acquireBoardGeometryScope(runtime, [node.id], { doc: candidate, signal: context.signal, current: () => current(identity) }); check();
            const bounds = scope.logicalBounds(node.id), growth = doc.host.kind === 'notebook' ? notebookGrowthOp(doc, bounds.y + bounds.height) : undefined;
            const ops: Op[] = [];
            if (!existing) ops.push({ t: 'media', op: 'add', entry: { ...entry, file } });
            else if (existing.file !== file) ops.push({ t: 'media', op: 'set-file', id: info.id, file });
            if (growth) ops.push(growth);
            ops.push({ t: 'set', id: node.id, key: 'media', value: info.id }, ...geometry);
            await session.enqueueAfterGesture(context.signal, () => {
                check(); session.history.open('Replace picture');
                try {
                    const applied = session.apply({ origin: 'host', label: 'Replace picture', ops });
                    try { runtime.media.setFile(info.id, file); } finally { applied.release(); }
                } finally { session.history.close(); }
            });
        } finally { scope?.release(); lease?.release(); }
    }, { signal: options.signal, deadlineMs: 120_000 });
}
