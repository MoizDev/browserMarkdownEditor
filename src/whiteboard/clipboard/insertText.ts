import { pageAt } from '../../platform/render/pageStack';
import { normalizedRotation, worldPose } from '../change/coordinates';
import { isLocked } from '../change/commands';
import { insertionBasis, landedNodes, measureInsertion, rebaseInsertion, selectLanded } from '../change/insertionLanding';
import type { Op } from '../change/ops';
import type { BoardGeometryScope } from '../commands/geometryScope';
import { notebookGrowthOp } from '../commands/pagesAndSheets';
import type { BoardRuntime } from '../host/runtime';
import { isSheetParent } from '../model/doc';
import { newNodeId } from '../model/ids';
import type { MediaId } from '../model/media';
import { createEmbed, createLinkcard, createText, type Node } from '../model/nodes';
import { embedCardSize, resolveEmbedCandidate, type EmbedManifest } from '../media/embed';
import type { UrlEnvironment } from '../security/urlPolicy';
import { createAddedBoardDoc } from '../model/overlayDoc';
import { keyBetween } from '../model/orderKey';
import { boardPageStack } from '../model/pages';
import { nodeRawValues, scanRawMediaIncremental } from '../model/rawMedia';
import { MAX_TEXT_BLOCKS, MAX_TEXT_LENGTH } from '../model/textLimits';
import { validRichText } from '../model/validate';
import { checkContentUrl } from '../security/urlPolicy';
import type { Block, RichFragment } from '../text/richText';
import { planBoardClipboardPlacement } from './placement';
import type { ClipboardIntent, ClipboardTarget } from './types';
import { yieldToHost } from '../../platform/yieldToHost';

/** Text pasted from the top edge of the view keeps this many screen pixels clear of it (catalogue c.8). */
const TEXT_TOP_CLEARANCE_PX = 40;
/** The nodes that carry a link address, the same set the Edit link command reaches. */
const LINKABLE_KINDS: ReadonlySet<string> = new Set(['figure', 'sticky', 'picture', 'linkcard', 'embed']);

// Provenance: external clipboard placement, text-layout and atomic change
// contracts; independent authoring path, no third-party source.
export type ExternalClipboardContent =
    | { readonly kind: 'plain'; readonly text: string }
    | { readonly kind: 'rich'; readonly fragment: RichFragment }
    | { readonly kind: 'url'; readonly url: string };
export interface InsertClipboardTextOptions {
    readonly runtime: BoardRuntime;
    readonly target: Readonly<ClipboardTarget>;
    /** Must check the captured target's session, vault epoch and generation. */
    current(target: Readonly<ClipboardTarget>): boolean;
    readonly receivingBoardId: string;
    readonly cameraZoom: number;
    readonly embedEnvironment?: UrlEnvironment;
    readonly embedManifest?: EmbedManifest;
    readonly intent: ClipboardIntent;
    readonly content: ExternalClipboardContent;
    /** A pasted address goes into the one selected link-carrying node instead of making a new card (paste, not drop or embed insertion). */
    readonly aimAtSelectedLink?: boolean;
    readonly signal?: AbortSignal;
    cooperate?(): Promise<void>;
}

/** Pasted text is sized to the view: one line may be as wide as 920 units (never narrower than 200, nor than 90% of the view), a
 * longer text wraps at 90% of the view. Wider text becomes fixed-width at that limit; narrower text stays auto-sized. */
export function pastedTextFit(width: number, lines: number, viewportWidth: number): { readonly autoSize: boolean; readonly w: number } {
    const limit = Math.max(1, lines > 1 ? 0.9 * viewportWidth : Math.min(920, Math.max(200, 0.9 * viewportWidth)));
    return width > limit ? { autoSize: false, w: limit } : { autoSize: true, w: width };
}

/** Empty text creates no object; whitespace and newline-only text are preserved literally. */
export async function insertClipboardText(options: InsertClipboardTextOptions): Promise<string | null> {
    const { runtime } = options, session = runtime.session, doc = session.doc, owner = session.owner, revision = doc.rev, basis = insertionBasis(doc);
    const target = Object.freeze({ ...options.target, viewport: Object.freeze({ ...options.target.viewport }),
        pointer: options.target.pointer ? Object.freeze({ ...options.target.pointer }) : null });
    const signal = options.signal ?? new AbortController().signal;
    const check = () => {
        signal.throwIfAborted();
        // No revision fence: what lands is carried over to the board as it is then (rebaseInsertion).
        if (!options.current(target) || runtime.session !== session || session.owner !== owner || session.doc !== doc
            || session.isReadOnly || runtime.selection.getSnapshot().sheet !== target.sheet) {
            throw new DOMException('Clipboard target became stale', 'AbortError');
        }
    };
    const cooperate = async () => { check(); await (options.cooperate?.() ?? yieldToHost()); check(); };
    const style = { ...doc.ui.next }, content = options.content;
    let scope: BoardGeometryScope | undefined;
    const measure = (node: Node, preserved: ReadonlyMap<MediaId, number>) =>
        measureInsertion(runtime, [node.id], () => createAddedBoardDoc(doc, landedNodes(doc, [node]), [], preserved), { signal, check, cooperate });
    try {
        check();
        if (options.intent === 'duplicate') throw new Error('External content cannot be duplicated');
        let text: RichFragment | undefined, url: string | undefined;
        if (content.kind === 'plain') {
            if (typeof content.text !== 'string' || content.text.length > MAX_TEXT_LENGTH) throw new RangeError('Clipboard text exceeds limits');
            if (!content.text.length) return null;
            const blocks: Block[] = [], value = content.text;
            let start = 0, work = 0;
            for (let i = 0; i < value.length; i++) {
                const c = value.charCodeAt(i);
                if (c === 10 || c === 13) {
                    blocks.push({ kind: 'p', level: 0, dir: 'auto', runs: [{ text: value.slice(start, i), marks: {} }] });
                    if (blocks.length >= MAX_TEXT_BLOCKS) throw new RangeError('Clipboard text exceeds block limit');
                    if (c === 13 && value.charCodeAt(i + 1) === 10) i++;
                    start = i + 1;
                }
                if ((++work & 4095) === 0) await cooperate();
            }
            blocks.push({ kind: 'p', level: 0, dir: 'auto', runs: [{ text: value.slice(start), marks: {} }] });
            text = { blocks };
        } else if (content.kind === 'rich') {
            if (!validRichText(content.fragment)) throw new TypeError('Clipboard rich text is invalid');
            const blocks: Block[] = []; let characters = content.fragment.blocks.length - 1, work = 0;
            for (const block of content.fragment.blocks) {
                const runs: Block['runs'][number][] = [];
                for (const run of block.runs) {
                    characters += run.text.length;
                    runs.push({ ...run, marks: { ...run.marks } });
                    if ((++work & 255) === 0) await cooperate();
                }
                blocks.push({ ...block, runs });
                if ((++work & 255) === 0) await cooperate();
            }
            if (!characters) return null;
            text = { blocks };
            if (!validRichText(text)) throw new TypeError('Clipboard rich text changed during capture');
        } else if (content.kind === 'url') {
            const raw = content.url.trim(), decision = checkContentUrl(raw, 'click', { appOrigin: '' });
            if (!decision.ok || !/^https?:/i.test(decision.url)) throw new TypeError('Clipboard URL must be an absolute HTTP(S) address');
            url = decision.url;
        } else throw new TypeError('Unsupported clipboard content');
        check();
        if (url !== undefined && options.aimAtSelectedLink) {
            const selection = runtime.selection.getSnapshot().selected, aimed = selection.length === 1 ? doc.nodes.get(selection[0]!) : undefined;
            if (aimed && LINKABLE_KINDS.has(aimed.kind) && !isLocked(doc, aimed)) {
                const value = url, linked = aimed.id;
                return session.enqueueAfterGesture(signal, () => {
                    check();
                    session.history.open('Paste link');
                    try {
                        const applied = session.apply({ origin: 'paste', label: 'Paste link', ops: rebaseInsertion(doc, basis, [{ t: 'set', id: linked, key: 'url', value } as Op]) });
                        applied.release();
                        return linked;
                    } finally { session.history.close(); }
                });
            }
        }
        const id = newNodeId(doc), initialSiblings = doc.children.get(target.sheet) ?? [];
        const initialOrder = keyBetween(initialSiblings.at(-1)?.order ?? null, null);
        const stack = boardPageStack(doc.host), first = stack?.rects[0];
        if (stack && !first) throw new Error('Clipboard target has no page');
        const base = { id, parent: target.sheet, order: initialOrder, page: stack ? 0 : -1, x: -(first?.x ?? 0), y: -(first?.y ?? 0), ext: null };
        // These are persisted card dimensions, not a placement estimate; the renderer
        // supplies the actual painted geometry used below and never fetches a preview.
        const embed = url !== undefined && options.embedEnvironment ? resolveEmbedCandidate(url, options.embedEnvironment, options.embedManifest) : null;
        let node: Node = url !== undefined ? embed ? createEmbed({ ...base, ...embedCardSize(embed.provider), url })
            : createLinkcard({ ...base, w: 320, h: 180, url, preview: null }) : createText({ ...base, text: text!, color: style.color, size: style.size, font: style.font,
                align: style.textAlign, autoSize: true, w: 1, scale: 1 });
        const preserved = new Map<MediaId, number>();
        for (const raw of nodeRawValues(node)) {
            if (raw === null) await cooperate();
            else { await scanRawMediaIncremental(raw, media => preserved.set(media, (preserved.get(media) ?? 0) + 1), cooperate); check(); }
        }
        scope = await measure(node, preserved);
        check();
        if (node.kind === 'text') {
            const prepared = runtime.render.text.prepareNow(node, { revision: `clipboard:${id}:${revision}` });
            if (!prepared) throw new Error('Clipboard text layout is unavailable');
            const width = Math.max(1, prepared.paint.box.w);
            if (!Number.isFinite(width)) throw new RangeError('Clipboard text is too wide');
            node = { ...node, ...pastedTextFit(width, node.text.blocks.length, target.viewport.w) };
            scope.release(); scope = undefined;
            scope = await measure(node, preserved);
            check();
        }
        const measured = scope.logicalBounds(id);
        const placement = planBoardClipboardPlacement({ receivingBoardId: options.receivingBoardId, target, doc, cameraZoom: options.cameraZoom,
            intent: options.intent, containsFrame: false, source: { from: null,
                bounds: { x: measured.x, y: measured.y, w: measured.width, h: measured.height } } });
        const parent = placement.parent, siblings = doc.children.get(parent) ?? [], order = keyBetween(siblings.at(-1)?.order ?? null, null);
        // Text is lifted, never moved down, so its top stays clear of the view's top edge.
        const floor = target.viewport.y + TEXT_TOP_CLEARANCE_PX / options.cameraZoom;
        const lift = node.kind === 'text' ? Math.max(0, floor - (measured.y + placement.delta.y)) : 0;
        const wx = placement.delta.x, wy = placement.delta.y + lift;
        if (isSheetParent(doc, parent)) node = { ...node, parent, order, x: wx - (first?.x ?? 0), y: wy - (first?.y ?? 0), page: stack ? 0 : -1 };
        else {
            const pose = worldPose(doc, parent), dx = wx - pose.x, dy = wy - pose.y, c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
            node = { ...node, parent, order, page: -1, x: c * dx + s * dy, y: -s * dx + c * dy, rotation: normalizedRotation(-pose.rotation) };
        }
        scope.release(); scope = undefined;
        scope = await measure(node, preserved);
        check();
        const bounds = scope.logicalBounds(id);
        const growth = doc.host.kind === 'notebook' ? notebookGrowthOp(doc, bounds.y + bounds.height) : undefined;
        const grownHost = growth?.key === 'host.paper' && doc.host.kind === 'notebook' ? { ...doc.host, paper: growth.value } : doc.host;
        const grown = boardPageStack(grownHost);
        if (isSheetParent(doc, parent) && grown && first) {
            const page = pageAt(grown, bounds.y + bounds.height / 2), origin = grown.rects[page];
            if (!origin) throw new Error('Clipboard destination page is unavailable');
            node = { ...node, page, x: node.x + first.x - origin.x, y: node.y + first.y - origin.y };
        }
        const ops: Op[] = [...(growth ? [growth] : []), { t: 'create', node }];
        check();
        return await session.enqueueAfterGesture(signal, () => {
            check();
            session.history.open('Paste');
            try {
                const applied = session.apply({ origin: 'paste', label: 'Paste', ops: rebaseInsertion(doc, basis, ops) });
                try { selectLanded(runtime.selection.getSnapshot(), target.selection, () => runtime.selection.setScope(parent, [id])); } finally { applied.release(); }
                return id;
            } finally { session.history.close(); }
        });
    } finally { scope?.release(); }
}
