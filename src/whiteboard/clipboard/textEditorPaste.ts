import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { BoardRuntime } from '../host/runtime';
import { acquireBoardClipboard } from '../host/clipboardAcquisition';
import { decodeBoardClipboard } from '../host/clipboardDecode';
import { MAX_TEXT_BLOCKS, MAX_TEXT_LENGTH } from '../model/textLimits';
import type { JobContext } from '../security/admission';
import { SECURITY_LIMITS } from '../security/limits';
import type { Block, RichFragment } from '../text/richText';
import type { BoardJobIdentity } from '../workers/protocol';
import { classifyClipboard, type ClipboardClassifierHost } from './classify';
import type { ClipboardCachePin, ClipboardCopy } from './copy';
import type { ClipboardHtmlFrameHost } from './htmlFrameHost';
import type { ClipboardInput, ClipboardIntent, ClipboardTextEditor } from './types';

// Provenance: clipboard §4.4, text editor splice and C5 private-content
// contracts; independent orchestration, no upstream engine source.
export interface TextEditorPasteOptions {
    readonly runtime: BoardRuntime; readonly memory: MemoryAllocator;
    readonly input: ClipboardInput; readonly intent: ClipboardIntent;
    readonly classifier: ClipboardClassifierHost; readonly html: Pick<ClipboardHtmlFrameHost, 'projectHTML'>;
    readonly editor: ClipboardTextEditor; readonly cache?: ClipboardCopy | ClipboardCachePin;
    noticeRefused(items: readonly { readonly name: string; readonly reason: string }[]): void;
    /** Ends editing, then invokes the real board ingest in this same job. */
    pasteBoard(context: JobContext, cache?: Pick<ClipboardCopy, 'match'>): Promise<void>;
    /** Checks the captured editor, selection, pane and session after every await. */
    current(): boolean;
    cooperate?(): Promise<void>;
}
export type TextEditorPasteResult = 'handled' | 'board';
function captureInput(input: ClipboardInput): ClipboardInput {
    if (!input || !Array.isArray(input.files) || input.files.length > SECURITY_LIMITS.mediaBatch
        || input.files.some(file => !file || !(file.blob instanceof Blob) || typeof file.name !== 'string' || typeof file.directory !== 'boolean')
        || input.privatePng !== null && !(input.privatePng instanceof Blob)) throw new TypeError('Invalid clipboard input');
    return Object.freeze({ ...input, files: Object.freeze(input.files.map(file => Object.freeze({ ...file }))) });
}
async function plainFragment(value: string, cooperate: () => Promise<void>): Promise<RichFragment> {
    if (value.length > MAX_TEXT_LENGTH) throw new RangeError('Clipboard text exceeds limits');
    const blocks: Block[] = []; let from = 0;
    for (let i = 0; i < value.length; i++) {
        if (value.charCodeAt(i) === 10) {
            if (blocks.length >= MAX_TEXT_BLOCKS - 1) throw new RangeError('Clipboard text exceeds block limit');
            blocks.push({ kind: 'p', level: 0, dir: 'auto', runs: [{ text: value.slice(from, i), marks: {} }] }); from = i + 1;
        }
        if ((i & 4095) === 4095) await cooperate();
    }
    blocks.push({ kind: 'p', level: 0, dir: 'auto', runs: [{ text: value.slice(from), marks: {} }] });
    return { blocks };
}
/** Non-text returns 'board'; the host ends editing before the normal board ingest. */
export async function pasteIntoTextEditorInJob(options: TextEditorPasteOptions, context: JobContext): Promise<TextEditorPasteResult> {
    const { runtime } = options, session = runtime.session, doc = session.doc, revision = doc.rev, owner = session.owner;
    const input = captureInput(options.input);
    const identity: BoardJobIdentity = Object.freeze({ session: context.job.session, epoch: context.job.vaultEpoch, revision });
    const check = () => {
        runtime.jobs.assertContext(context); context.assertCurrent();
        if (!options.current() || runtime.session !== session || session.doc !== doc || session.owner !== owner || doc.rev !== revision || session.isReadOnly) {
            throw new DOMException('Text paste became stale', 'AbortError');
        }
    };
    const current = (value: BoardJobIdentity) => value.session === identity.session && value.epoch === identity.epoch && value.revision === revision
        && runtime.jobs.isCurrent(context.job) && options.current() && session.doc === doc && doc.rev === revision;
    const cooperate = async () => { check(); await (options.cooperate?.() ?? new Promise<void>(resolve => setTimeout(resolve, 0))); check(); };
    const board = async (): Promise<TextEditorPasteResult> => { check(); await options.pasteBoard(context, options.cache); context.assertCurrent(); return 'board'; };
    check();
    const classification = await classifyClipboard(input, options.intent, options.classifier, context.signal);
    try {
    check();
    if (classification.kind === 'empty') return 'handled';
    if (classification.kind === 'text' || classification.kind === 'url') {
        const value = classification.kind === 'text' ? classification.text : input.text ?? classification.url;
        if (!value.length) return 'handled';
        const fragment = await plainFragment(value.replace(/\r\n?/g, '\n'), cooperate); check();
        options.editor.replaceSelection(fragment); return 'handled';
    }
    if (classification.kind === 'html') {
        const projection = await options.html.projectHTML(classification.html, context.signal);
        try {
            check();
            if (projection.dataImages.length) { projection.release(); return await board(); }
            if (projection.refusedImages.length) options.noticeRefused(projection.refusedImages);
            const nonempty = projection.rich.blocks.some(block => block.runs.some(run => run.text.length > 0)) || projection.rich.blocks.length > 1;
            if (nonempty) { check(); options.editor.replaceSelection(projection.rich); }
            return 'handled';
        } finally { projection.release(); }
    }
    if (classification.kind === 'private') {
        const decoded = await decodeBoardClipboard({ encoded: new Blob([classification.encoded], { type: 'text/plain' }),
            identity, memory: options.memory, signal: context.signal, isCurrent: current });
        let acquisition: Awaited<ReturnType<typeof acquireBoardClipboard>> | undefined;
        try {
            check();
            const match = options.cache?.match(classification.encoded, input.text ?? '');
            acquisition = await acquireBoardClipboard({ decoded, identity, signal: context.signal, isCurrent: current,
                ...(match ? { cache: { match, encoded: classification.encoded, plain: input.text ?? '' } } : {}), cooperate: options.cooperate });
            check();
            const source = acquisition.load.doc, roots = source.children.get(acquisition.payload.from.sheet) ?? [];
            if (source.nodes.size !== 1 || roots.length !== 1 || roots[0].kind !== 'text') {
                acquisition.dispose(); acquisition = undefined; decoded.release(); classification.release?.(); return await board();
            }
            options.editor.replaceSelection(roots[0].text); return 'handled';
        } finally { acquisition?.dispose(); decoded.release(); }
    }
    return board();
    } finally { if ('release' in classification) classification.release?.(); }
}
export function pasteIntoTextEditor(options: TextEditorPasteOptions, signal?: AbortSignal): Promise<TextEditorPasteResult> {
    const input = captureInput(options.input), cache = options.cache;
    const pin = cache && 'pin' in cache && typeof cache.pin === 'function' ? cache.pin() : null;
    const capturedCache = cache && 'pin' in cache ? pin ?? undefined : cache;
    const bytes = input.files.reduce((sum, file) => sum + (file.directory ? 0 : Math.min(file.blob.size, SECURITY_LIMITS.mediaBytes)), 0)
        + (input.privatePng ? Math.min(input.privatePng.size, SECURITY_LIMITS.mediaBytes) : 0);
    const deadlineMs = Math.min(600_000, Math.max(120_000, Math.ceil(bytes / (100 * 1024 * 1024)) * 30_000));
    return options.runtime.jobs.run(context => pasteIntoTextEditorInJob({ ...options, input, cache: capturedCache }, context),
        { signal, deadlineMs }).finally(() => pin?.release());
}
