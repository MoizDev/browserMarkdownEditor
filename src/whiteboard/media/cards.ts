import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { ClipboardHtmlFrameHost } from '../clipboard/htmlFrameHost';
import { isLocked } from '../change/commands';
import type { BoardRuntime } from '../host/runtime';
import { newNodeId, type NodeId } from '../model/ids';
import { createEmbed, createLinkcard } from '../model/nodes';
import type { UrlEnvironment } from '../security/urlPolicy';
import { fetchLinkPreview } from './preview';

// Provenance: media §10a/§11 card conversion and explicit preview consent;
// independent transaction composition, no upstream engine source.
export function convertMediaCard(options: {
    readonly runtime: BoardRuntime; readonly id: NodeId; current(): boolean;
    /** The registry is the only authority for a permitted embed endpoint. */
    canEmbed(url: string): boolean;
}): NodeId {
    const { runtime } = options, session = runtime.session, doc = session.doc, node = doc.nodes.get(options.id);
    if (!options.current() || session.isReadOnly || session.isGestureActive || !node || isLocked(doc, node)
        || node.kind !== 'linkcard' && node.kind !== 'embed') throw new Error('Card conversion is unavailable');
    if (node.kind === 'linkcard' && !options.canEmbed(node.url)) throw new Error('This URL has no supported embed provider');
    const id = newNodeId(doc), w = node.kind === 'linkcard' ? 800 : 300, h = node.kind === 'linkcard' ? 450 : 320;
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
    readonly frame: Pick<ClipboardHtmlFrameHost, 'metadata'>; readonly environment: UrlEnvironment;
    readonly signal?: AbortSignal; current(): boolean;
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
        const metadata = await fetchLinkPreview({ url, environment: options.environment, memory: options.memory, frame: options.frame,
            signal: context.signal, current: () => { try { check(); return true; } catch { return false; } } });
        check();
        await session.enqueueAfterGesture(context.signal, () => {
            check(); session.history.open('Fetch preview');
            try {
                const applied = session.apply({ origin: 'host', label: 'Fetch preview', ops: [{ t: 'set', id: options.id, key: 'preview',
                    value: { title: metadata.title ?? node.preview?.title ?? null, description: metadata.description ?? node.preview?.description ?? null,
                        image: node.preview?.image ?? null, favicon: node.preview?.favicon ?? null } }] });
                applied.release();
            } finally { session.history.close(); }
        });
    }, { signal: options.signal, deadlineMs: 5000 });
}
