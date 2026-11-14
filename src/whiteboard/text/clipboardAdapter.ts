import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { ClipboardCopy } from '../clipboard/copy';
import type { ClipboardClassifierHost } from '../clipboard/classify';
import type { ClipboardHtmlFrameHost } from '../clipboard/htmlFrameHost';
import type { CopySnapshot, CopySnapshotHost } from '../clipboard/snapshot';
import type { ClipboardInput } from '../clipboard/types';
import type { BoardJobIdentity } from '../workers/protocol';
import type { createBoardTextEditor } from '../viewer/textEditor';
import { classifyTextPaste } from './clipboardPaste';
import { readPrivateClipboardText } from './clipboardPrivate';
import { snapshotCopiedTextRange } from './clipboardSnapshot';

export type TextPasteIntent = 'paste' | 'paste-inverted' | 'paste-plain' | 'paste-plain-inverted';
export interface TextClipboardAdapterOptions {
    readonly editor: ReturnType<typeof createBoardTextEditor>;
    readonly copy: ClipboardCopy;
    readonly classifier: ClipboardClassifierHost;
    readonly html: ClipboardHtmlFrameHost;
    readonly memory: MemoryAllocator;
    /** Captures the real source sheet, encoder and resource holders at the gesture. */
    copyHost(): CopySnapshotHost;
    identity(): BoardJobIdentity;
    isCurrent(identity: BoardJobIdentity): boolean;
    /** Core owns the OS event and forwards non-text content after editing has ended. */
    pasteBoard(input: ClipboardInput, intent: TextPasteIntent, signal: AbortSignal): Promise<void>;
}

/** Semantic text clipboard endpoint for Core's one DOM/OS clipboard controller. */
export function createTextClipboardAdapter(options: TextClipboardAdapterOptions) {
    let disposed = false, serial = 0, pending: AbortController | null = null;
    const cancel = () => { serial++; pending?.abort(); pending = null; };
    const current = (snapshot: CopySnapshot): boolean => {
        const expected = snapshot.textSelection, actual = options.editor.clipboardContext();
        return !disposed && !!expected && !!actual && actual.revision === snapshot.revision && actual.node.id === expected.node
            && actual.selection.anchor === expected.anchor && actual.selection.focus === expected.focus;
    };
    return {
        /** Prime h2's real clipboard cache; Core then calls its copyEvent/copyMenu. */
        prepareCopy(): CopySnapshot | null {
            if (disposed) return null;
            const range = options.editor.clipboardSelection();
            if (!range) { options.copy.setSelection(null); return null; }
            const snapshot = snapshotCopiedTextRange(options.copyHost(), range.node, range.selection, range.fragment, range.bounds);
            if (!current(snapshot)) { for (const lease of snapshot.leases) lease.release(); return null; }
            options.copy.setSelection(snapshot);
            return snapshot;
        },
        isCurrent: current,
        /** Use as ClipboardCopy.prepareCut for a snapshot with textSelection. */
        prepareCut(snapshot: CopySnapshot): () => void {
            if (!current(snapshot) || !snapshot.textSelection) throw new Error('Text selection changed; cut again');
            const selection = { ...snapshot.textSelection }, revision = snapshot.revision;
            return () => {
                if (!current(snapshot) || !options.editor.cutText(selection.node, revision, { anchor: selection.anchor, focus: selection.focus }))
                    throw new Error('Text selection changed; nothing was cut');
            };
        },
        /** ClipboardInput is sampled by Core during the event, before DataTransfer expires. */
        async paste(input: ClipboardInput, intent: TextPasteIntent, signal: AbortSignal): Promise<boolean> {
            if (disposed) return false;
            cancel();
            const before = options.editor.clipboardContext();
            if (!before) return false;
            const owner = { node: before.node.id, revision: before.revision, selection: { ...before.selection } };
            const identity = { ...options.identity() }, controller = new AbortController(), generation = serial;
            pending = controller;
            const combined = AbortSignal.any([signal, controller.signal]);
            try {
                const plain = intent === 'paste-plain' || intent === 'paste-plain-inverted';
                const content = await classifyTextPaste(input, plain, { classifier: options.classifier, html: options.html,
                    privateText: (encoded, text, requestSignal) => readPrivateClipboardText(encoded, text, requestSignal,
                        { identity, memory: options.memory, cache: options.copy, isCurrent: options.isCurrent }) }, combined);
                combined.throwIfAborted();
                const after = options.editor.clipboardContext();
                if (disposed || generation !== serial || !options.isCurrent(identity) || !after || after.node.id !== owner.node
                    || after.revision !== owner.revision || after.selection.anchor !== owner.selection.anchor || after.selection.focus !== owner.selection.focus) return false;
                if (content.kind === 'empty') return false;
                if (content.kind === 'text') return options.editor.pasteText(content.fragment);
                options.editor.manager.close();
                await options.pasteBoard(input, intent, combined);
                combined.throwIfAborted();
                return true;
            } finally { if (pending === controller) pending = null; }
        },
        cancel,
        dispose() { if (!disposed) { disposed = true; cancel(); } },
    };
}
