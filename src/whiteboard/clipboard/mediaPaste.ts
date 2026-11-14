import { pageAt } from '../../platform/render/pageStack';
import { isLocked } from '../change/commands';
import { normalizedRotation, worldPose } from '../change/coordinates';
import type { BoardRuntime } from '../host/runtime';
import { isSheetParent, sheetOf, type BoardDoc } from '../model/doc';
import type { NodeId, ParentId } from '../model/ids';
import { boardPageStack } from '../model/pages';
import type { MediaIngestor, MediaPlacement, MediaSource } from '../media/ingest';
import type { JobContext } from '../security/admission';
import { SECURITY_LIMITS } from '../security/limits';
import { privatePngDensity } from './pngDensity';
import type { ClipboardFile, ClipboardIntent, ClipboardTarget } from './types';

// Provenance: clipboard external placement, page stack, and session media
// ingestion contracts; independent host composition, no upstream engine source.
export function externalMediaPlacement(doc: BoardDoc, target: Readonly<ClipboardTarget>, intent: ClipboardIntent): MediaPlacement {
    if (intent === 'duplicate') throw new Error('External content cannot be duplicated');
    if (!doc.sheets.has(target.sheet)) throw new Error('Clipboard target sheet is unavailable');
    const cursor = target.pasteAtCursor !== (intent === 'paste-inverted' || intent === 'paste-plain-inverted');
    if (intent === 'drop' && !target.pointer) throw new Error('Drop has no captured point');
    const candidate = intent === 'drop' ? target.pointer! : cursor && target.pointer ? target.pointer
        : { x: target.viewport.x + target.viewport.w / 2, y: target.viewport.y + target.viewport.h / 2 };
    if (!Number.isFinite(candidate.x) || !Number.isFinite(candidate.y)) throw new RangeError('Invalid media placement point');
    let x = candidate.x, y = candidate.y, page = -1;
    const stack = boardPageStack(doc.host);
    if (stack) {
        page = pageAt(stack, y); const rect = stack.rects[page];
        if (!rect) throw new Error('Media placement page is unavailable');
        x = Math.max(rect.x, Math.min(rect.x + rect.width, x)); y = Math.max(rect.y, Math.min(rect.y + rect.height, y));
    }
    let parent: ParentId = target.sheet;
    if (target.selectedFrame !== null) {
        const frame = doc.nodes.get(target.selectedFrame);
        if (!frame || frame.kind !== 'frame' || sheetOf(doc, frame.id) !== target.sheet) throw new Error('Clipboard target frame is stale');
        if (!isLocked(doc, frame)) parent = frame.id;
    }
    if (!isSheetParent(doc, parent)) {
        const pose = worldPose(doc, parent), dx = x - pose.x, dy = y - pose.y, c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
        return { parent, page: -1, x: c * dx + s * dy, y: -s * dx + c * dy, rotation: normalizedRotation(-pose.rotation) };
    }
    const origin = stack ? stack.rects[page] : undefined;
    return { parent, page, x: x - (origin?.x ?? 0), y: y - (origin?.y ?? 0) };
}
export interface ClipboardMediaPasteOptions {
    readonly runtime: BoardRuntime;
    readonly ingestor: MediaIngestor;
    readonly target: Readonly<ClipboardTarget>;
    readonly intent: ClipboardIntent;
    readonly files: readonly ClipboardFile[];
    readonly privatePng?: Blob | null;
    current(target: Readonly<ClipboardTarget>): boolean;
    noticeRefused(items: readonly { readonly name: string; readonly reason: string }[]): void;
}
export async function pasteClipboardMediaInJob(options: ClipboardMediaPasteOptions, context: JobContext): Promise<readonly NodeId[]> {
    const { runtime } = options, session = runtime.session, doc = session.doc, revision = doc.rev;
    const target = Object.freeze({ ...options.target, viewport: Object.freeze({ ...options.target.viewport }),
        pointer: options.target.pointer ? Object.freeze({ ...options.target.pointer }) : null });
    const check = () => {
        runtime.jobs.assertContext(context); context.assertCurrent();
        if (runtime.session !== session || session.doc !== doc || doc.rev !== revision || session.isReadOnly || !options.current(target)) {
            throw new DOMException('Media paste became stale', 'AbortError');
        }
    };
    check();
    if (!options.privatePng && options.files.length > SECURITY_LIMITS.mediaBatch) throw new RangeError('Too many clipboard files');
    const sources: MediaSource[] = [], refused: { name: string; reason: string }[] = [];
    if (options.privatePng) {
        if (!(options.privatePng instanceof Blob)) throw new TypeError('Invalid private PNG');
        const blob = new Blob([options.privatePng], { type: options.privatePng.type });
        const density = await privatePngDensity(blob, context.signal); check();
        sources.push({ blob, name: 'clipboard.png', ...(density === undefined ? {} : { pixelsPerWorldUnit: density }) });
    } else for (const item of options.files) {
        if (item.directory) { refused.push({ name: item.name, reason: 'Folders cannot be pasted onto a board' }); continue; }
        if (!(item.blob instanceof Blob) || typeof item.name !== 'string') throw new TypeError('Invalid clipboard file');
        sources.push({ blob: new Blob([item.blob], { type: item.blob.type }), name: item.name });
    }
    if (refused.length) options.noticeRefused(refused);
    if (!sources.length) return [];
    const placement = externalMediaPlacement(doc, target, options.intent);
    check();
    return options.ingestor.ingestInJob(sources, { origin: 'paste', placement, signal: context.signal }, context);
}
export function pasteClipboardMedia(options: ClipboardMediaPasteOptions, signal?: AbortSignal): Promise<readonly NodeId[]> {
    return options.runtime.jobs.run(context => pasteClipboardMediaInJob(options, context), { signal, deadlineMs: 120_000 });
}
