import { createClipboardHtmlFrameHost } from '../../whiteboard/clipboard/htmlFrameHost';
import { captureTransfer } from '../../whiteboard/clipboard/transfer';
import { classifyClipboardJson } from '../../whiteboard/host/clipboardJsonKind';
import type { BoardRuntime } from '../../whiteboard/host/runtime';
import { createTextClipboardAdapter, type TextPasteIntent } from '../../whiteboard/text/clipboardAdapter';
import type { createBoardTextEditor } from '../../whiteboard/viewer/textEditor';
import type { BoardJobIdentity } from '../../whiteboard/workers/protocol';
import type { NativeCanvasHost, NativeCanvasIdentity } from '../../types/nativeCanvas';
import type { NativeClipboardBinding, NativeClipboardService } from './useNativeClipboard';

/** Inline text borrows the document's one ClipboardCopy, cache, allocator and paste controller. */
export function createNativeTextClipboard(options: {
    readonly surface: HTMLElement;
    readonly editor: ReturnType<typeof createBoardTextEditor>;
    readonly runtime: BoardRuntime;
    readonly host: NativeCanvasHost;
    readonly identity: NativeCanvasIdentity;
    readonly clipboard: NativeClipboardService;
    readonly binding: NativeClipboardBinding;
    onError(error: unknown): void;
}) {
    const { runtime, host, identity, binding, clipboard, editor } = options;
    let disposed = false, active = false, authority: (() => void) | undefined;
    let copyAdapter: ReturnType<typeof createTextClipboardAdapter> | undefined;
    const pasteAdapters = new Set<ReturnType<typeof createTextClipboardAdapter>>();
    const lifetime = new AbortController();
    const current = () => !disposed && host.isCurrent(identity) && runtime.session.owner.documentId === identity.documentId
        && runtime.session.owner.session === identity.session;
    const make = (pasteBoard: Parameters<typeof createTextClipboardAdapter>[0]['pasteBoard'], writable = false) => {
        const job: BoardJobIdentity = { session: `${identity.documentId}:${identity.session}`, epoch: identity.vaultActivation, revision: runtime.session.doc.rev };
        const isCurrent = (candidate: BoardJobIdentity) => current() && (!writable || host.canWrite(identity)) && candidate.session === job.session && candidate.epoch === job.epoch
            && candidate.revision === job.revision && runtime.session.doc.rev === job.revision;
        const html = createClipboardHtmlFrameHost({ memory: clipboard.memory, identity: job, isCurrent });
        return createTextClipboardAdapter({ editor, copy: binding.commands.clipboardCopy, memory: clipboard.memory, html,
            classifier: { appOrigin: location.origin, markers: html.markers,
                jsonKind: (text, signal) => classifyClipboardJson({ bytes: new Blob([text]), identity: job,
                    memory: clipboard.memory, isCurrent, signal }) },
            copyHost: () => ({ doc: runtime.session.doc, sheet: runtime.selection.getSnapshot().sheet,
                board: identity.documentId, encoder: runtime.encoder }), identity: () => job, isCurrent, pasteBoard });
    };
    const stopAuthority = () => { authority?.(); authority = undefined; copyAdapter?.dispose(); copyAdapter = undefined; };
    const setActive = (next: boolean) => {
        if (disposed || active === next) return;
        active = next;
        if (!next) { stopAuthority(); return; }
        authority = binding.commands.bindTextAuthority({
            isCurrent: snapshot => copyAdapter?.isCurrent(snapshot) ?? false,
            prepareCut(snapshot) {
                if (!copyAdapter) throw new Error('Text selection is unavailable');
                return copyAdapter.prepareCut(snapshot);
            },
        });
    };
    const report = (error: unknown) => { if (!(error instanceof DOMException && error.name === 'AbortError')) options.onError(error); };
    const inlineEvent = (event: ClipboardEvent) => event.target instanceof Element && !!event.target.closest('.wb-edit-host');
    const forwardBoard: Parameters<typeof createTextClipboardAdapter>[0]['pasteBoard'] = (input, intent, signal, cache) => {
        const forward = binding.controller.capturePasteTarget(intent, cache);
        return forward.run(input, signal).finally(forward.release);
    };
    const copy = (event: ClipboardEvent, cut: boolean) => {
        if (!inlineEvent(event) || (!active && !editor.manager.current)) return;
        event.preventDefault();
        if (!current() || (cut && !host.canWrite(identity))) return;
        try {
            setActive(true);
            copyAdapter?.dispose();
            copyAdapter = make(forwardBoard, cut);
            if (copyAdapter.prepareCopy()) binding.commands.clipboardCopy.copyEvent(event, cut);
        } catch (error) { report(error); }
    };
    const onCopy = (event: ClipboardEvent) => copy(event, false), onCut = (event: ClipboardEvent) => copy(event, true);
    const copyMenu = async (cut = false) => {
        if ((!active && !editor.manager.current) || !current() || (cut && !host.canWrite(identity))) return;
        try {
            setActive(true);
            copyAdapter?.dispose();
            copyAdapter = make(forwardBoard, cut);
            if (copyAdapter.prepareCopy()) await binding.commands.clipboardCopy.copyMenu(cut);
        } catch (error) { report(error); }
    };
    const paste = (input: ReturnType<typeof captureTransfer>, intent: TextPasteIntent) => {
        if (!active || !current() || !host.canWrite(identity)) return;
        const forward = binding.controller.capturePaste(input, intent);
        let adapter: ReturnType<typeof createTextClipboardAdapter>;
        try { adapter = make((_input, _intent, signal, cache) => {
            if (cache !== forward.cachePin) return Promise.reject(new Error('Clipboard pin changed'));
            return forward.run(signal);
        }, true); }
        catch (error) { forward.release(); throw error; }
        pasteAdapters.add(adapter);
        void adapter.paste(input, intent, lifetime.signal, forward.cachePin).catch(report).finally(() => { forward.release(); pasteAdapters.delete(adapter); adapter.dispose(); });
    };
    const pasteSystem = async (intent: TextPasteIntent) => {
        if ((!active && !editor.manager.current) || !current() || !host.canWrite(identity)) return;
        try {
            setActive(true);
            const before = editor.clipboardContext();
            if (!before) return;
            const forward = binding.controller.capturePasteTarget(intent);
            try {
                const input = await binding.controller.readClipboard(), after = editor.clipboardContext();
                if (!active || !current() || !host.canWrite(identity) || !after || after.node.id !== before.node.id || after.revision !== before.revision ||
                    after.selection.anchor !== before.selection.anchor || after.selection.focus !== before.selection.focus) {
                    throw new DOMException('Text selection changed', 'AbortError');
                }
                const adapter = make((boardInput, _intent, signal, cache) => {
                    if (cache !== forward.cachePin) return Promise.reject(new Error('Clipboard pin changed'));
                    return forward.run(boardInput, signal);
                }, true);
                pasteAdapters.add(adapter);
                try { await adapter.paste(input, intent, lifetime.signal, forward.cachePin); }
                finally { pasteAdapters.delete(adapter); adapter.dispose(); }
            } finally { forward.release(); }
        } catch (error) { report(error); }
    };
    const onPaste = (event: ClipboardEvent) => {
        if (!inlineEvent(event) || (!active && !editor.manager.current)) return;
        event.preventDefault();
        if (!current() || !event.clipboardData) return;
        try { setActive(true); paste(captureTransfer(event.clipboardData), 'paste'); } catch (error) { report(error); }
    };
    options.surface.addEventListener('copy', onCopy); options.surface.addEventListener('cut', onCut); options.surface.addEventListener('paste', onPaste);
    return {
        setActive,
        copyMenu,
        paste,
        pasteSystem,
        dispose() {
            if (disposed) return;
            disposed = true; active = false; lifetime.abort(); stopAuthority();
            for (const adapter of pasteAdapters) adapter.dispose(); pasteAdapters.clear();
            options.surface.removeEventListener('copy', onCopy); options.surface.removeEventListener('cut', onCut);
            options.surface.removeEventListener('paste', onPaste);
        },
    };
}
