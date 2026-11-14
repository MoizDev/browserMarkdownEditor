import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { ClipboardCachePin, ClipboardCopy } from '../clipboard/copy';
import type { ClipboardClassifierHost } from '../clipboard/classify';
import type { ClipboardHtmlFrameHost } from '../clipboard/htmlFrameHost';
import type { CopySnapshot } from '../clipboard/snapshot';
import type { ClipboardInput } from '../clipboard/types';
import type { BoardJobIdentity } from '../workers/protocol';
import type { createBoardTextEditor } from '../viewer/textEditor';
import { classifyTextPaste } from './clipboardPaste';
import { readPrivateClipboardText } from './clipboardPrivate';
import { snapshotCopiedTextRange, type TextCopySnapshotHost } from './clipboardSnapshot';

export type TextPasteIntent = 'paste' | 'paste-inverted' | 'paste-plain' | 'paste-plain-inverted';
export interface TextClipboardAdapterOptions {
    readonly editor: ReturnType<typeof createBoardTextEditor>;
    readonly copy: ClipboardCopy;
    readonly classifier: ClipboardClassifierHost;
    readonly html: ClipboardHtmlFrameHost;
    readonly memory: MemoryAllocator;
    /** Captures the real source sheet, encoder and resource holders at the gesture. */
    copyHost(): TextCopySnapshotHost;
    identity(): BoardJobIdentity;
    isCurrent(identity: BoardJobIdentity): boolean;
    /** Core owns the OS event and forwards non-text content after editing has ended. */
    /** The pin is borrowed until the returned board paste settles; Core must not reacquire the window cache. */
    pasteBoard(input: ClipboardInput, intent: TextPasteIntent, signal: AbortSignal, cache: ClipboardCachePin | null): Promise<void>;
}

/** Semantic text clipboard endpoint for Core's one DOM/OS clipboard controller. */
export function createTextClipboardAdapter(options: TextClipboardAdapterOptions) {
    let disposed = false, serial = 0, pending: AbortController | null = null;
    const lifetime = new AbortController();
    const owners = new WeakMap<CopySnapshot, BoardJobIdentity>();
    const cancel = () => { serial++; pending?.abort(); pending = null; };
    const current = (snapshot: CopySnapshot): boolean => {
        const owner = owners.get(snapshot), expected = snapshot.textSelection, actual = options.editor.clipboardContext();
        return !disposed && !!owner && options.isCurrent(owner) && !!expected && !!actual && actual.revision === snapshot.revision && actual.node.id === expected.node
            && actual.selection.anchor === expected.anchor && actual.selection.focus === expected.focus;
    };
    return {
        signal: lifetime.signal,
        /** Prime h2's real clipboard cache; Core then calls its copyEvent/copyMenu. */
        prepareCopy(): CopySnapshot | null {
            if (disposed) return null;
            // A failed capture must not leave the previous range available to an OS event.
            options.copy.setSelection(null);
            const range = options.editor.clipboardSelection();
            if (!range) return null;
            const identity = { ...options.identity() }, host = options.copyHost();
            if (host.doc.rev !== range.revision || !options.isCurrent(identity)) return null;
            const snapshot = snapshotCopiedTextRange(host, range.node, range.selection, range.fragment, range.bounds);
            owners.set(snapshot, identity);
            if (!current(snapshot)) { for (const lease of snapshot.leases) lease.release(); return null; }
            options.copy.setSelection(snapshot);
            return snapshot;
        },
        isCurrent: current,
        /** Use as ClipboardCopy.prepareCut for a snapshot with textSelection. */
        prepareCut(snapshot: CopySnapshot): { commit(): void; release(): void } {
            if (!current(snapshot) || !snapshot.textSelection) throw new Error('Text selection changed; cut again');
            const selection = { ...snapshot.textSelection }, revision = snapshot.revision;
            const proof = options.editor.prepareTextCut(selection.node, revision, { anchor: selection.anchor, focus: selection.focus });
            try { if (!current(snapshot)) throw new Error('Text selection changed; cut again'); }
            catch (error) { proof.release(); throw error; }
            let released = false, committed = false;
            return {
                commit() {
                    if (released || committed || !current(snapshot)) throw new Error('Text selection changed; nothing was cut');
                    proof.commit(); committed = true;
                },
                release() { if (!released) { released = true; proof.release(); } },
            };
        },
        /** ClipboardInput is sampled by Core during the event, before DataTransfer expires. */
        /** Call at the OS gesture; the caller owns and releases this pin after the whole paste. */
        capturePaste(): ClipboardCachePin | null { return options.copy.pin(); },
        /** The caller lends the gesture-captured pin, including an explicit null, for this operation. */
        async paste(input: ClipboardInput, intent: TextPasteIntent, signal: AbortSignal, cache: ClipboardCachePin | null): Promise<boolean> {
            let controller: AbortController | undefined;
            try {
                if (disposed) return false;
                cancel();
                const before = options.editor.clipboardContext();
                if (!before) return false;
                const owner = { node: before.node.id, revision: before.revision, selection: { ...before.selection } };
                const identity = { ...options.identity() }, generation = serial;
                controller = new AbortController(); pending = controller;
                const combined = AbortSignal.any([signal, controller.signal, lifetime.signal]);
                const plain = intent === 'paste-plain' || intent === 'paste-plain-inverted';
                const content = await classifyTextPaste(input, plain, { classifier: options.classifier, html: options.html,
                    privateText: (encoded, text, requestSignal) => readPrivateClipboardText(encoded, text, requestSignal,
                        { identity, memory: options.memory, cache, isCurrent: options.isCurrent }) }, combined);
                combined.throwIfAborted();
                const after = options.editor.clipboardContext();
                if (disposed || generation !== serial || !options.isCurrent(identity) || !after || after.node.id !== owner.node
                    || after.revision !== owner.revision || after.selection.anchor !== owner.selection.anchor || after.selection.focus !== owner.selection.focus) return false;
                if (content.kind === 'empty') return false;
                if (content.kind === 'text') return options.editor.pasteText(content.fragment);
                // The board paste takes ownership before ending this editor; closing it may dispose this adapter.
                if (pending === controller) pending = null;
                const boardSignal = AbortSignal.any([signal, controller.signal]);
                options.editor.manager.close();
                await options.pasteBoard(input, intent, boardSignal, cache);
                boardSignal.throwIfAborted();
                return true;
            } finally {
                if (pending === controller) pending = null;
            }
        },
        cancel,
        dispose() { if (!disposed) { disposed = true; lifetime.abort(); cancel(); } },
    };
}

/** Pin before an asynchronous OS read and retain sole ownership until the paste has settled. */
export function pasteWithCapturedClipboard(
    adapter: Pick<ReturnType<typeof createTextClipboardAdapter>, 'capturePaste' | 'paste' | 'signal'>,
    acquire: (signal: AbortSignal) => Promise<ClipboardInput>, intent: TextPasteIntent, signal: AbortSignal,
): Promise<boolean> {
    const captured = adapter.capturePaste(), active = AbortSignal.any([signal, adapter.signal]);
    return (async () => {
        try {
            active.throwIfAborted();
            const work = acquire(active);
            const input = await new Promise<ClipboardInput>((resolve, reject) => {
                const abort = () => { active.removeEventListener('abort', abort); reject(active.reason ?? new DOMException('Paste cancelled', 'AbortError')); };
                active.addEventListener('abort', abort, { once: true });
                work.then(value => { active.removeEventListener('abort', abort); resolve(value); },
                    error => { active.removeEventListener('abort', abort); reject(error); });
                if (active.aborted) abort();
            });
            active.throwIfAborted();
            return await adapter.paste(input, intent, signal, captured);
        } finally { captured?.release(); }
    })();
}

export interface TextClipboardDocumentOwner {
    readonly clipboardCopy: ClipboardCopy;
    bindTextAuthority(authority: {
        isCurrent(snapshot: CopySnapshot): boolean;
        prepareCut(snapshot: CopySnapshot): { commit(): void; release(): void };
    }): () => void;
}

/** Borrow the document owner's one C2 instance and return its text authority with one lifetime. */
export function bindTextClipboardAdapter(owner: TextClipboardDocumentOwner, options: Omit<TextClipboardAdapterOptions, 'copy'>) {
    const adapter = createTextClipboardAdapter({ ...options, copy: owner.clipboardCopy });
    let unbind: () => void;
    try { unbind = owner.bindTextAuthority(adapter); }
    catch (error) { adapter.dispose(); throw error; }
    let disposed = false;
    return {
        ...adapter,
        dispose() {
            if (disposed) return;
            disposed = true;
            try { adapter.dispose(); } finally { unbind(); }
        },
    };
}
