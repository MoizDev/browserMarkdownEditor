import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import { createClipboardHtmlFrameHost } from '../clipboard/htmlFrameHost';
import { isLocked } from '../change/commands';
import type { BoardRuntime } from '../host/runtime';
import { newNodeId, type NodeId } from '../model/ids';
import { createEmbed, createLinkcard } from '../model/nodes';
import type { BoardJobIdentity } from '../workers/protocol';
import type { UrlEnvironment } from '../security/urlPolicy';
import { fetchLinkPreview } from './preview';
import { attachPreviewMedia, previewAddress, PREVIEW_ICON_BYTES, PREVIEW_IMAGE_BYTES, type PreviewRole } from './previewMedia';
import type { StoreMedia } from './storage.types';
import { EMBED_CARD_SIZES, embedCardSize, resolveEmbedCandidate, type EmbedManifest } from './embed';
import { isCancellation } from '../../platform/workers/envelope';

// Provenance: media §10a/§11 card conversion and explicit preview consent;
// independent transaction composition, no upstream engine source.
export function convertMediaCard(options: {
    readonly runtime: BoardRuntime; readonly id: NodeId; current(): boolean;
    readonly environment: UrlEnvironment; readonly manifest: EmbedManifest;
}): NodeId {
    const { runtime } = options, session = runtime.session, doc = session.doc, node = doc.nodes.get(options.id);
    if (!options.current() || session.isReadOnly || session.isGestureActive || !node || isLocked(doc, node)
        || node.kind !== 'linkcard' && node.kind !== 'embed') throw new Error('Card conversion is unavailable');
    const candidate = node.kind === 'linkcard' ? resolveEmbedCandidate(node.url, options.environment, options.manifest) : null;
    if (node.kind === 'linkcard' && !candidate) throw new Error('This URL has no supported embed provider');
    // A card or embed keeps the size the person gave it; only a node still at a size the app gives its kind takes the target default.
    const target = candidate ? embedCardSize(candidate.provider) : { w: 300, h: 320 };
    const kindDefaults = node.kind === 'linkcard' ? [{ w: 300, h: 320 }, { w: 320, h: 180 }] : EMBED_CARD_SIZES;
    const resized = !kindDefaults.some(size => size.w === node.w && size.h === node.h);
    const id = newNodeId(doc), w = resized ? node.w : target.w, h = resized ? node.h : target.h;
    const dx = (node.w - w) / 2, dy = (node.h - h) / 2, c = Math.cos(node.rotation), s = Math.sin(node.rotation);
    const common = { id, parent: node.parent, order: node.order, page: node.page, x: node.x + c * dx - s * dy,
        y: node.y + s * dx + c * dy, rotation: node.rotation, opacity: node.opacity, locked: node.locked, ext: node.ext, w, h, url: node.url };
    const replacement = node.kind === 'linkcard' ? createEmbed(common) : createLinkcard({ ...common, preview: null });
    if (!options.current() || session.doc !== doc) throw new DOMException('Card conversion became stale', 'AbortError');
    session.history.open('Convert card');
    try {
        const applied = session.apply({ origin: 'host', label: 'Convert card', ops: [{ t: 'delete', id: node.id }, { t: 'create', node: replacement }] });
        try { runtime.selection.clear(); } finally { applied.release(); }
    } finally { session.history.close(); }
    return id;
}

/** A preview is requested only by explicit gesture and becomes inert text on commit. */
export function fetchCardPreview(options: {
    readonly runtime: BoardRuntime; readonly id: NodeId; readonly memory: MemoryAllocator;
    readonly environment: UrlEnvironment; readonly signal?: AbortSignal; current(): boolean;
    /** The document's storage port for preview pictures; without it the card keeps its text and stores no picture. */
    readonly storeMedia?: StoreMedia;
}): Promise<void> {
    const { runtime } = options, session = runtime.session, doc = session.doc, revision = doc.rev, owner = session.owner;
    const node = doc.nodes.get(options.id);
    if (!node || node.kind !== 'linkcard' || isLocked(doc, node) || session.isReadOnly) return Promise.reject(new Error('Link preview is unavailable'));
    const url = node.url;
    return runtime.jobs.run(async context => {
        const check = () => {
            context.assertCurrent();
            const current = doc.nodes.get(options.id);
            if (!options.current() || runtime.session !== session || session.doc !== doc || doc.rev !== revision || session.owner !== owner
                || session.isReadOnly || !current || current.kind !== 'linkcard' || current.url !== url || isLocked(doc, current)) {
                throw new DOMException('Link preview became stale', 'AbortError');
            }
        };
        check();
        // The HTML frame belongs to this job: its identity is the job's, so a stale job cannot parse for a newer one.
        const live = () => { try { check(); return true; } catch { return false; } };
        const identity: BoardJobIdentity = { session: context.job.session, epoch: context.job.vaultEpoch, revision };
        const frame = createClipboardHtmlFrameHost({ memory: options.memory, identity,
            isCurrent: job => job.session === identity.session && job.epoch === identity.epoch && job.revision === identity.revision && live() });
        const metadata = await fetchLinkPreview({ url, environment: options.environment, memory: options.memory, frame,
            signal: context.signal, current: live });
        check();
        await session.enqueueAfterGesture(context.signal, () => {
            check();
            // History-silent by policy (DERIVED_TEXT): a completed fetch is not a step, so it cannot clear the redo branch.
            const applied = session.apply({ origin: 'host', label: 'Fetch preview', ops: [{ t: 'set', id: options.id, key: 'preview',
                value: { title: metadata.title ?? node.preview?.title ?? null, description: metadata.description ?? node.preview?.description ?? null,
                    image: node.preview?.image ?? null, favicon: node.preview?.favicon ?? null } }] });
            applied.release();
        });
        // The picture requests this explicit job may make: the declared preview image, then the icon (declared, else the
        // site's /favicon.ico). Each is its own commit, so a failure keeps the title, description and whatever succeeded.
        // Source: t21 ruling (A), which amends security.md §8.2 step 4 and E-SEC-6; only this explicit Fetch preview makes them.
        const storage = options.storeMedia;
        if (!storage) return;
        const failures: string[] = [];
        const picture = async (role: PreviewRole, address: string | null, limit: number) => {
            if (!address) return;
            try { await attachPreviewMedia({ runtime, memory: options.memory, storeMedia: storage, context, id: options.id, url: address, role, limit, current: options.current }); }
            catch (error) {
                if (isCancellation(error)) throw error;
                failures.push(`${role === 'image' ? 'The preview picture' : 'The icon'} was not saved: ${error instanceof Error ? error.message : 'unavailable'}.`);
            }
        };
        const image = previewAddress(metadata.image, metadata.page, options.environment);
        const icon = previewAddress(metadata.icon, metadata.page, options.environment, '/favicon.ico');
        await picture('image', image, PREVIEW_IMAGE_BYTES);
        await picture('favicon', icon, PREVIEW_ICON_BYTES);
        if (failures.length) throw new Error(`Preview kept. ${failures.join(' ')}`);
    }, { signal: options.signal, deadlineMs: 5000 });
}
