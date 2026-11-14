import type { Op, TransactionOrigin } from '../change/ops';
import type { ParentId, NodeId } from '../model/ids';
import { newNodeId } from '../model/ids';
import { isSafeMediaFile, type MediaEntry, type MediaId, type MediaMime } from '../model/media';
import { createClip, createPicture, type Crop } from '../model/nodes';
import { keysBetween } from '../model/orderKey';
import type { BoardSession } from '../session/BoardSession';
import { pageAt } from '../../platform/render/pageStack';
import { worldPose } from '../change/coordinates';
import { notebookGrowthOp } from '../commands/pagesAndSheets';
import { isSheetParent } from '../model/doc';
import { boardPageStack, pageOrigin } from '../model/pages';
import { checkMediaBytes, checkMediaDimensions, SECURITY_LIMITS } from '../security/limits';
import type { JobAuthority, JobContext } from '../security/admission';
import type { BoardJobIdentity } from '../workers/protocol';

export interface InspectedMedia {
    readonly id: MediaId;
    readonly mime: MediaMime;
    readonly width: number;
    readonly height: number;
    readonly duration: number | null;
    readonly animated: boolean;
}

// The inspector is the bounded worker/isolated-profile admission boundary. The host
// store is the sole authority that can write an asset or stage a PDF attachment.
export interface MediaIngestHost {
    inspectMedia(blob: Blob, options: { signal: AbortSignal; identity: BoardJobIdentity; isCurrent: (identity: BoardJobIdentity) => boolean }): Promise<InspectedMedia>;
    storeMedia(entry: MediaEntry, blob: Blob, signal: AbortSignal): Promise<string | null>;
    rememberMedia(id: MediaId, blob: Blob): void;
    /** Commit the active gesture before capturing the paste target. */
    finishGesture(): void;
    isCurrent(): boolean;
    select(ids: readonly NodeId[]): void;
    noticeRefused(files: readonly { readonly name: string; readonly reason: string }[]): void;
}
export interface MediaSource {
    readonly blob: Blob;
    readonly name: string;
    /** Accepted only for our private PNG clipboard type, after its pHYs is checked. */
    readonly pixelsPerWorldUnit?: number;
}
export interface MediaPlacement {
    readonly parent: ParentId;
    readonly page: number;
    readonly x: number;
    readonly y: number;
}
export interface MediaIngestOptions {
    readonly origin: TransactionOrigin;
    readonly signal?: AbortSignal;
    readonly placement: MediaPlacement;
}

const EXTENSIONS: Record<MediaMime, string> = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
    'image/avif': 'avif', 'image/svg+xml': 'svg', 'video/mp4': 'mp4',
    'video/webm': 'webm', 'video/quicktime': 'mov',
};

export function mediaExtension(mime: MediaMime): string { return EXTENSIONS[mime]; }

function replacementCrop(crop: Crop | null, old: MediaEntry, next: InspectedMedia): Crop | null {
    const window = crop ?? { x0: 0, y0: 0, x1: 1, y1: 1, circle: false };
    const dx = window.x1 - window.x0, dy = window.y1 - window.y0;
    const ratio = (old.w / old.h) / (next.width / next.height);
    const cx = (window.x0 + window.x1) / 2, cy = (window.y0 + window.y1) / 2;
    const newX = dx * Math.min(1, ratio), newY = dy * Math.min(1, 1 / ratio);
    if (!crop && newX === 1 && newY === 1) return null;
    return { x0: cx - newX / 2, x1: cx + newX / 2, y0: cy - newY / 2, y1: cy + newY / 2, circle: window.circle };
}

function checkResult(info: InspectedMedia): void {
    if (!/^sha256:[0-9a-f]{64}$/.test(info.id) || !Object.hasOwn(EXTENSIONS, info.mime)
        || !checkMediaDimensions(info.width, info.height).ok || info.width > 1_000_000 || info.height > 1_000_000
        || typeof info.animated !== 'boolean'
        || (info.duration !== null && (!Number.isFinite(info.duration) || info.duration < 0))
        || (info.mime.startsWith('video/') !== (info.duration !== null))) {
        throw new Error('Invalid media admission result');
    }
}

function box(info: InspectedMedia, pixelsPerWorldUnit?: number): { w: number; h: number } {
    if (pixelsPerWorldUnit !== undefined && (info.mime !== 'image/png' || !Number.isFinite(pixelsPerWorldUnit) || pixelsPerWorldUnit <= 0)) throw new RangeError('Invalid private PNG density');
    const density = pixelsPerWorldUnit ?? 1, width = info.width / density, height = info.height / density;
    const scale = Math.min(1, 5000 / Math.max(width, height));
    return { w: width * scale, h: height * scale };
}

interface Staged { readonly info: InspectedMedia; readonly entry: MediaEntry; readonly blob: Blob; readonly file: string | null; readonly pixelsPerWorldUnit?: number }
export interface MediaLocationWriter { setFile(id: MediaId, file: string | null): void }

function setMediaFile(id: MediaId, file: string | null): Op {
    return { t: 'media', op: 'set-file', id, file };
}

// Call synchronously inside the session's save/gesture queue after storing bytes.
export function updateMediaFile(session: BoardSession, locations: MediaLocationWriter, id: MediaId, file: string | null): void {
    if (!isSafeMediaFile(file)) throw new Error('Invalid stored media name');
    const existing = session.doc.media.get(id);
    if (!existing) throw new Error('Media no longer belongs to this board');
    if (existing.file !== file) {
        const applied = session.apply({ ops: [setMediaFile(id, file)], origin: 'host', label: 'Restore media' });
        applied.release();
    }
    locations.setFile(id, file);
}

export class MediaIngestor {
    constructor(private readonly session: BoardSession, private readonly host: MediaIngestHost,
        private readonly jobs: JobAuthority, private readonly locations: MediaLocationWriter) {}

    ingest(sources: readonly MediaSource[], options: MediaIngestOptions): Promise<readonly NodeId[]> {
        if (!sources.length || sources.length > SECURITY_LIMITS.mediaBatch) return Promise.reject(new RangeError('Select between 1 and 100 media files'));
        this.host.finishGesture();
        const bytes = sources.reduce((sum, source) => sum + source.blob.size, 0);
        const deadlineMs = Math.max(30000, Math.ceil(bytes / (100 * 1024 * 1024)) * 30000);
        return this.jobs.run(context => this.run(sources, options, context), { signal: options.signal, deadlineMs });
    }

    /** The caller already owns this session's serial job; enqueueing again would deadlock. */
    ingestInJob(sources: readonly MediaSource[], options: MediaIngestOptions, context: JobContext): Promise<readonly NodeId[]> {
        this.jobs.assertContext(context);
        if (options.signal && options.signal !== context.signal) throw new TypeError('In-job media must use its owning context signal');
        if (!sources.length || sources.length > SECURITY_LIMITS.mediaBatch) return Promise.reject(new RangeError('Select between 1 and 100 media files'));
        this.host.finishGesture();
        return this.run(sources, { ...options, signal: context.signal }, context);
    }

    replaceInJob(id: NodeId, source: MediaSource, options: { readonly signal?: AbortSignal; readonly origin: TransactionOrigin }, context: JobContext): Promise<void> {
        this.jobs.assertContext(context);
        if (options.signal && options.signal !== context.signal) throw new TypeError('In-job media must use its owning context signal');
        this.host.finishGesture();
        return this.runReplace(id, source, { ...options, signal: context.signal }, context);
    }

    replace(id: NodeId, source: MediaSource, options: { readonly signal?: AbortSignal; readonly origin: TransactionOrigin }): Promise<void> {
        this.host.finishGesture();
        return this.jobs.run(context => this.runReplace(id, source, options, context), { signal: options.signal, deadlineMs: 30000 });
    }

    private async runReplace(id: NodeId, source: MediaSource, options: { readonly signal?: AbortSignal; readonly origin: TransactionOrigin }, context: JobContext): Promise<void> {
        const signal = context.signal;
        const identity: BoardJobIdentity = { session: context.job.session, epoch: context.job.vaultEpoch, revision: this.session.doc.rev };
        const isCurrent = (): boolean => this.jobs.isCurrent(context.job) && this.host.isCurrent() && this.session.doc.rev === identity.revision;
        const current = (): void => {
            context.assertCurrent();
            if (!isCurrent()) throw new DOMException('Board session ended or changed', 'AbortError');
        };
        current();
        const initial = this.session.doc.nodes.get(id);
        if (!initial || initial.kind !== 'picture' || initial.locked || !initial.media) throw new Error('Picture cannot be replaced');
        if (source.name.length > 10000) throw new RangeError('Media name is too long');
        if (!checkMediaBytes(source.blob.size, 'raster').ok) throw new RangeError('Media files must be at most 10 MiB');
        const info = await this.host.inspectMedia(source.blob, { signal, identity, isCurrent });
        current();
        checkResult(info);
        if (!info.mime.startsWith('image/')) throw new Error('Replacement must be a picture');
        if (info.mime === 'image/svg+xml' && !checkMediaBytes(source.blob.size, 'svg').ok) throw new RangeError('SVG files must be at most 5 MiB');
        const priorEntry = this.session.doc.media.get(info.id);
        if (priorEntry && (priorEntry.mime !== info.mime || priorEntry.bytes !== source.blob.size || priorEntry.w !== info.width || priorEntry.h !== info.height
            || priorEntry.duration !== info.duration || priorEntry.animated !== info.animated)) throw new Error('Existing media metadata conflicts with verified bytes');
        const entry: MediaEntry = priorEntry ?? {
            id: info.id, mime: info.mime, bytes: source.blob.size, w: info.width, h: info.height,
            duration: null, animated: info.animated, name: source.name, file: null, ext: null,
        };
        const file = await this.host.storeMedia(entry, source.blob, signal);
        current();
        if (!isSafeMediaFile(file)) throw new Error('Invalid stored media name');
        const node = this.session.doc.nodes.get(id);
        if (!node || node.kind !== 'picture' || node.locked || node.media !== initial.media) throw new Error('Picture changed during replacement');
        const old = this.session.doc.media.get(initial.media);
        if (!old) throw new Error('Original picture is missing');
        const ops: Op[] = [];
        if (!this.session.doc.media.has(info.id)) ops.push({ t: 'media', op: 'add', entry: { ...entry, file } });
        else if (entry.file !== file) ops.push(setMediaFile(info.id, file));
        ops.push({ t: 'set', id, key: 'media', value: info.id });
        ops.push({ t: 'set', id, key: 'crop', value: replacementCrop(node.crop, old, info) });
        if (initial.media !== info.id && this.session.doc.mediaRefs.get(initial.media)?.size === 1
            && !(this.session.doc.preservedMediaRefs.get(initial.media) ?? 0)) {
            ops.push({ t: 'media', op: 'drop', id: initial.media });
        }
        this.host.rememberMedia(info.id, source.blob);
        current();
        await this.session.enqueueAfterGesture(signal, () => {
            current();
            this.session.history.open('Replace media');
            try {
                const applied = this.session.apply({ ops, origin: options.origin, label: 'Replace media' });
                this.locations.setFile(info.id, file);
                applied.release();
            } finally { this.session.history.close(); }
        });
    }

    private async run(sources: readonly MediaSource[], options: MediaIngestOptions, context: JobContext): Promise<readonly NodeId[]> {
        const signal = context.signal;
        const identity: BoardJobIdentity = { session: context.job.session, epoch: context.job.vaultEpoch, revision: this.session.doc.rev };
        const isCurrent = (): boolean => this.jobs.isCurrent(context.job) && this.host.isCurrent() && this.session.doc.rev === identity.revision;
        const current = (): void => {
            context.assertCurrent();
            if (!isCurrent()) throw new DOMException('Board session ended or changed', 'AbortError');
        };
        const staged: Staged[] = [];
        const refused: { name: string; reason: string }[] = [];
        {
            for (const source of sources) {
                current();
                try {
                    if (source.name.length > 10000) throw new RangeError('Media name is too long');
                    if (!checkMediaBytes(source.blob.size, 'raster').ok) throw new RangeError('Media files must be at most 10 MiB');
                    const info = await this.host.inspectMedia(source.blob, { signal, identity, isCurrent });
                    current();
                    checkResult(info);
                    if (info.mime === 'image/svg+xml' && !checkMediaBytes(source.blob.size, 'svg').ok) throw new RangeError('SVG files must be at most 5 MiB');
                    const old = this.session.doc.media.get(info.id);
                    if (old && (old.mime !== info.mime || old.bytes !== source.blob.size || old.w !== info.width || old.h !== info.height
                        || old.duration !== info.duration || old.animated !== info.animated)) throw new Error('Existing media metadata conflicts with verified bytes');
                    box(info, source.pixelsPerWorldUnit);
                    const entry: MediaEntry = old ?? {
                        id: info.id, mime: info.mime, bytes: source.blob.size, w: info.width, h: info.height,
                        duration: info.duration, animated: info.animated, name: source.name, file: null, ext: null,
                    };
                    const file = await this.host.storeMedia(entry, source.blob, signal);
                    current();
                    if (!isSafeMediaFile(file)) throw new Error('Invalid stored media name');
                    staged.push({ info, entry: old ?? { ...entry, file }, blob: source.blob, file,
                        ...(source.pixelsPerWorldUnit === undefined ? {} : { pixelsPerWorldUnit: source.pixelsPerWorldUnit }) });
                } catch (error) {
                    current();
                    refused.push({ name: source.name, reason: error instanceof Error ? error.message : 'Media could not be read' });
                }
            }
            current();
            if (refused.length) this.host.noticeRefused(refused);
            if (!staged.length) return [];
            const { parent, page, x, y } = options.placement;
            if (!Number.isFinite(x) || !Number.isFinite(y)) throw new RangeError('Invalid placement');
            const doc = this.session.doc, sizes = staged.map(item => box(item.info, item.pixelsPerWorldUnit));
            let left = x - sizes.reduce((sum, size) => sum + size.w, 0) / 2;
            const originalLeft = left, root = isSheetParent(doc, parent), stack = boardPageStack(doc.host);
            const origin = root && stack ? pageOrigin(stack, page) : undefined;
            if (root && stack && !origin) throw new Error('Media placement page is unavailable');
            const pose = root ? null : worldPose(doc, parent);
            let deepest = -Infinity, cursor = originalLeft;
            for (const size of sizes) {
                const top = y - size.h / 2;
                if (pose) {
                    const sin = Math.sin(pose.rotation), cos = Math.cos(pose.rotation);
                    for (const px of [cursor, cursor + size.w]) for (const py of [top, top + size.h]) deepest = Math.max(deepest, pose.y + sin * px + cos * py);
                } else deepest = Math.max(deepest, (origin?.y ?? 0) + top + size.h);
                cursor += size.w;
            }
            const growth = doc.host.kind === 'notebook' ? notebookGrowthOp(doc, deepest) : undefined;
            const grownHost = growth?.key === 'host.paper' && doc.host.kind === 'notebook' ? { ...doc.host, paper: growth.value } : doc.host;
            const grownStack = boardPageStack(grownHost);
            const siblings = doc.children.get(parent) ?? [];
            const orders = keysBetween(siblings.at(-1)?.order ?? null, null, staged.length);
            const ids: NodeId[] = [], reserved = new Set<NodeId>();
            const ops: Op[] = growth ? [growth] : [];
            const added = new Set<MediaId>();
            const files = new Map<MediaId, string | null>();
            for (let i = 0; i < staged.length; i++) {
                const { info, entry, blob, file } = staged[i];
                const { w, h } = sizes[i];
                if (files.has(info.id) && files.get(info.id) !== file) throw new Error('Media location changed during insertion');
                if (!files.has(info.id)) {
                    files.set(info.id, file);
                    const existing = this.session.doc.media.get(info.id);
                    if (existing && existing.file !== file) ops.push(setMediaFile(info.id, file));
                }
                if (!this.session.doc.media.has(info.id) && !added.has(info.id)) {
                    ops.push({ t: 'media', op: 'add', entry });
                    added.add(info.id);
                }
                const id = newNodeId({ nodes: { has: candidate => doc.nodes.has(candidate) || reserved.has(candidate) }, sheets: doc.sheets });
                ids.push(id); reserved.add(id);
                let targetPage = page, px = left, py = y - h / 2;
                if (root && grownStack && origin) {
                    targetPage = pageAt(grownStack, origin.y + y);
                    const target = grownStack.rects[targetPage];
                    if (!target) throw new Error('Media destination page is unavailable');
                    px += origin.x - target.x; py += origin.y - target.y;
                } else if (!root) targetPage = -1;
                const common = { id, parent, order: orders[i], page: targetPage, x: px, y: py, ext: null, w, h, media: info.id, alt: '' };
                const node = info.mime.startsWith('video/')
                    ? createClip({ ...common, time: 0, playing: true, autoplay: true })
                    : createPicture({ ...common, crop: null, flipX: false, flipY: false, inverted: false, playing: true, url: null });
                ops.push({ t: 'create', node });
                left += w;
                this.host.rememberMedia(info.id, blob);
            }
            current();
            return await this.session.enqueueAfterGesture(signal, () => {
                current();
                this.session.history.open('Insert media');
                try {
                    const applied = this.session.apply({ ops, origin: options.origin, label: 'Insert media' });
                    try { for (const item of staged) this.locations.setFile(item.info.id, item.file); }
                    finally { applied.release(); }
                    this.host.select(ids);
                    return ids;
                } finally { this.session.history.close(); }
            });
        }
    }
}
