import type { Op, TransactionOrigin } from '../change/ops';
import type { ParentId, NodeId } from '../model/ids';
import { newNodeId } from '../model/ids';
import type { MediaEntry, MediaId, MediaMime } from '../model/media';
import { createClip, createPicture, type Crop } from '../model/nodes';
import { keysBetween } from '../model/orderKey';
import type { BoardSession } from '../session/BoardSession';
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
    isCurrent(): boolean;
    select(ids: readonly NodeId[]): void;
}
export interface MediaSource { readonly blob: Blob; readonly name: string }
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

function safeLeaf(name: string | null): boolean {
    return name === null || (name.length > 0 && name.length <= 255 && name !== '.' && name !== '..'
        && !/[\\/\0]/.test(name));
}

function box(info: InspectedMedia): { w: number; h: number } {
    const scale = Math.min(1, 5000 / Math.max(info.width, info.height));
    return { w: info.width * scale, h: info.height * scale };
}

interface Staged { readonly info: InspectedMedia; readonly entry: MediaEntry; readonly blob: Blob; readonly file: string | null }
export interface MediaLocationWriter { setFile(id: MediaId, file: string | null): void }

export class MediaIngestor {
    constructor(private readonly session: BoardSession, private readonly host: MediaIngestHost,
        private readonly jobs: JobAuthority, private readonly locations: MediaLocationWriter) {}

    ingest(sources: readonly MediaSource[], options: MediaIngestOptions): Promise<readonly NodeId[]> {
        if (!sources.length || sources.length > SECURITY_LIMITS.mediaBatch) return Promise.reject(new RangeError('Select between 1 and 100 media files'));
        const bytes = sources.reduce((sum, source) => sum + source.blob.size, 0);
        const deadlineMs = Math.max(30000, Math.ceil(bytes / (100 * 1024 * 1024)) * 30000);
        return this.jobs.run(context => this.run(sources, options, context), { signal: options.signal, deadlineMs });
    }

    replace(id: NodeId, source: MediaSource, options: { readonly signal?: AbortSignal; readonly origin: TransactionOrigin }): Promise<void> {
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
        const entry: MediaEntry = priorEntry ?? {
            id: info.id, mime: info.mime, bytes: source.blob.size, w: info.width, h: info.height,
            duration: null, animated: info.animated, name: source.name, file: null, ext: null,
        };
        const file = await this.host.storeMedia(entry, source.blob, signal);
        current();
        if (!safeLeaf(file)) throw new Error('Invalid stored media name');
        const node = this.session.doc.nodes.get(id);
        if (!node || node.kind !== 'picture' || node.locked || node.media !== initial.media) throw new Error('Picture changed during replacement');
        const old = this.session.doc.media.get(initial.media);
        if (!old) throw new Error('Original picture is missing');
        const ops: Op[] = [];
        if (!this.session.doc.media.has(info.id)) ops.push({ t: 'media', op: 'add', entry: { ...entry, file } });
        ops.push({ t: 'set', id, key: 'media', value: info.id });
        ops.push({ t: 'set', id, key: 'crop', value: replacementCrop(node.crop, old, info) });
        if (initial.media !== info.id && this.session.doc.mediaRefs.get(initial.media)?.size === 1
            && !(this.session.doc.preservedMediaRefs.get(initial.media) ?? 0)) {
            ops.push({ t: 'media', op: 'drop', id: initial.media });
        }
        this.host.rememberMedia(info.id, source.blob);
        current();
        const applied = this.session.apply({ ops, origin: options.origin, label: 'Replace media' });
        this.locations.setFile(info.id, file);
        applied.release();
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
        {
            for (const source of sources) {
                current();
                if (source.name.length > 10000) throw new RangeError('Media name is too long');
                if (!checkMediaBytes(source.blob.size, 'raster').ok) throw new RangeError('Media files must be at most 10 MiB');
                const info = await this.host.inspectMedia(source.blob, { signal, identity, isCurrent });
                current();
                checkResult(info);
                if (info.mime === 'image/svg+xml' && !checkMediaBytes(source.blob.size, 'svg').ok) throw new RangeError('SVG files must be at most 5 MiB');
                const old = this.session.doc.media.get(info.id);
                const entry: MediaEntry = old ?? {
                    id: info.id, mime: info.mime, bytes: source.blob.size, w: info.width, h: info.height,
                    duration: info.duration, animated: info.animated, name: source.name, file: null, ext: null,
                };
                const file = await this.host.storeMedia(entry, source.blob, signal);
                current();
                if (!safeLeaf(file)) throw new Error('Invalid stored media name');
                staged.push({ info, entry: old ?? { ...entry, file }, blob: source.blob, file });
            }
            current();
            const { parent, page, x, y } = options.placement;
            if (!Number.isFinite(x) || !Number.isFinite(y)) throw new RangeError('Invalid placement');
            const sizes = staged.map(item => box(item.info));
            let left = x - sizes.reduce((sum, size) => sum + size.w, 0) / 2;
            const siblings = this.session.doc.children.get(parent) ?? [];
            const orders = keysBetween(siblings.at(-1)?.order ?? null, null, staged.length);
            const ids: NodeId[] = [];
            const ops: Op[] = [];
            const added = new Set<MediaId>();
            for (let i = 0; i < staged.length; i++) {
                const { info, entry, blob } = staged[i];
                const { w, h } = sizes[i];
                if (!this.session.doc.media.has(info.id) && !added.has(info.id)) {
                    ops.push({ t: 'media', op: 'add', entry });
                    added.add(info.id);
                }
                const id = newNodeId({ nodes: { has: candidate => this.session.doc.nodes.has(candidate) || ids.includes(candidate) }, sheets: this.session.doc.sheets });
                ids.push(id);
                const common = { id, parent, order: orders[i], page, x: left, y: y - h / 2, ext: null, w, h, media: info.id, alt: '' };
                const node = info.mime.startsWith('video/')
                    ? createClip({ ...common, time: 0, playing: true, autoplay: true })
                    : createPicture({ ...common, crop: null, flipX: false, flipY: false, inverted: false, playing: true, url: null });
                ops.push({ t: 'create', node });
                left += w;
                this.host.rememberMedia(info.id, blob);
            }
            current();
            const applied = this.session.apply({ ops, origin: options.origin, label: 'Insert media' });
            for (const item of staged) this.locations.setFile(item.info.id, item.file);
            applied.release();
            this.host.select(ids);
            return ids;
        }
    }
}
