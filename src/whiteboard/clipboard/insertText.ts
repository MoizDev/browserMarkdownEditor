import { pageAt } from '../../platform/render/pageStack';
import { normalizedRotation, worldPose } from '../change/coordinates';
import type { Op } from '../change/ops';
import { acquireBoardGeometryScope } from '../commands/geometryScope';
import { notebookGrowthOp } from '../commands/pagesAndSheets';
import type { BoardRuntime } from '../host/runtime';
import { isSheetParent } from '../model/doc';
import { newNodeId } from '../model/ids';
import type { MediaId } from '../model/media';
import { createLinkcard, createText, type Node } from '../model/nodes';
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
    readonly intent: ClipboardIntent;
    readonly content: ExternalClipboardContent;
    readonly signal?: AbortSignal;
    cooperate?(): Promise<void>;
}

/** Empty text creates no object; whitespace and newline-only text are preserved literally. */
export async function insertClipboardText(options: InsertClipboardTextOptions): Promise<string | null> {
    const { runtime } = options, session = runtime.session, doc = session.doc, owner = session.owner, revision = doc.rev;
    const target = Object.freeze({ ...options.target, viewport: Object.freeze({ ...options.target.viewport }),
        pointer: options.target.pointer ? Object.freeze({ ...options.target.pointer }) : null });
    const signal = options.signal ?? new AbortController().signal;
    const check = () => {
        signal.throwIfAborted();
        if (!options.current(target) || runtime.session !== session || session.owner !== owner || session.doc !== doc
            || doc.rev !== revision || session.isReadOnly || runtime.selection.getSnapshot().sheet !== target.sheet) {
            throw new DOMException('Clipboard target became stale', 'AbortError');
        }
    };
    const cooperate = async () => { check(); await (options.cooperate?.() ?? new Promise<void>(resolve => setTimeout(resolve, 0))); check(); };
    const style = { ...doc.ui.next }, content = options.content;
    let scope: Awaited<ReturnType<typeof acquireBoardGeometryScope>> | undefined;
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
        const id = newNodeId(doc), initialSiblings = doc.children.get(target.sheet) ?? [];
        const initialOrder = keyBetween(initialSiblings.at(-1)?.order ?? null, null);
        const stack = boardPageStack(doc.host), first = stack?.rects[0];
        if (stack && !first) throw new Error('Clipboard target has no page');
        const base = { id, parent: target.sheet, order: initialOrder, page: stack ? 0 : -1, x: -(first?.x ?? 0), y: -(first?.y ?? 0), ext: null };
        // These are persisted card dimensions, not a placement estimate; the renderer
        // supplies the actual painted geometry used below and never fetches a preview.
        let node: Node = url !== undefined ? createLinkcard({ ...base, w: 320, h: 180, url, preview: null })
            : createText({ ...base, text: text!, color: style.color, size: style.size, font: style.font,
                align: style.textAlign, autoSize: true, w: 1, scale: 1 });
        const preserved = new Map<MediaId, number>();
        for (const raw of nodeRawValues(node)) {
            if (raw === null) await cooperate();
            else { await scanRawMediaIncremental(raw, media => preserved.set(media, (preserved.get(media) ?? 0) + 1), cooperate); check(); }
        }
        let candidate = createAddedBoardDoc(doc, [node], [], preserved);
        scope = await acquireBoardGeometryScope(runtime, [id], { doc: candidate, signal, current: () => { check(); return true; }, cooperate });
        check();
        if (node.kind === 'text') {
            const prepared = runtime.render.text.prepareNow(node, { revision: `clipboard:${id}:${revision}` });
            if (!prepared) throw new Error('Clipboard text layout is unavailable');
            const width = Math.max(1, prepared.paint.box.w);
            if (!Number.isFinite(width)) throw new RangeError('Clipboard text is too wide');
            node = width > 1200 ? { ...node, autoSize: false, w: 600 } : { ...node, w: width };
            scope.release(); scope = undefined;
            candidate = createAddedBoardDoc(doc, [node], [], preserved);
            scope = await acquireBoardGeometryScope(runtime, [id], { doc: candidate, signal, current: () => { check(); return true; }, cooperate });
            check();
        }
        const measured = scope.logicalBounds(id);
        const placement = planBoardClipboardPlacement({ receivingBoardId: options.receivingBoardId, target, doc, cameraZoom: options.cameraZoom,
            intent: options.intent, containsFrame: false, source: { from: null,
                bounds: { x: measured.x, y: measured.y, w: measured.width, h: measured.height } } });
        const parent = placement.parent, siblings = doc.children.get(parent) ?? [], order = keyBetween(siblings.at(-1)?.order ?? null, null);
        const wx = placement.delta.x, wy = placement.delta.y;
        if (isSheetParent(doc, parent)) node = { ...node, parent, order, x: wx - (first?.x ?? 0), y: wy - (first?.y ?? 0), page: stack ? 0 : -1 };
        else {
            const pose = worldPose(doc, parent), dx = wx - pose.x, dy = wy - pose.y, c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
            node = { ...node, parent, order, page: -1, x: c * dx + s * dy, y: -s * dx + c * dy, rotation: normalizedRotation(-pose.rotation) };
        }
        scope.release(); scope = undefined;
        candidate = createAddedBoardDoc(doc, [node], [], preserved);
        scope = await acquireBoardGeometryScope(runtime, [id], { doc: candidate, signal, current: () => { check(); return true; }, cooperate });
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
                const applied = session.apply({ origin: 'paste', label: 'Paste', ops });
                try { runtime.selection.setScope(parent, [id]); } finally { applied.release(); }
                return id;
            } finally { session.history.close(); }
        });
    } finally { scope?.release(); }
}
