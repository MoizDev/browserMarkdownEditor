import type { BoardToolServicesOptions } from '../../whiteboard/viewer/toolServices';
import type { ClipboardPoint } from '../../whiteboard/clipboard/types';
import type { NativeClipboardBinding } from './useNativeClipboard';
import type { BoardRuntime } from '../../whiteboard/host/runtime';
import { isCancellation } from '../../platform/workers/envelope';

export function createNativeImportAdapter(binding: NativeClipboardBinding, runtime: BoardRuntime, currentOwner: () => boolean,
    onError: (error: unknown) => void) {
    let picker: HTMLInputElement | null = null, disposed = false;
    const closePicker = () => {
        const current = picker; picker = null;
        if (current) { current.onchange = null; current.oncancel = null; current.remove(); }
        return !!current;
    };
    const open = (point: ClipboardPoint) => {
        if (disposed) return;
        closePicker();
        if (!currentOwner() || runtime.session.isReadOnly) return;
        const revision = runtime.session.doc.rev, selection = runtime.selection.getSnapshot();
        const current = document.createElement('input');
        current.type = 'file'; current.accept = 'image/*,video/*'; current.multiple = true; current.hidden = true;
        picker = current; document.body.append(current);
        current.oncancel = () => { if (picker === current) closePicker(); };
        current.onchange = () => {
            if (picker !== current || disposed) return;
            const files = Array.from(current.files ?? []); closePicker();
            if (!files.length) return;
            if (!currentOwner() || runtime.session.isReadOnly) {
                onError(new Error('The board is read-only, so the chosen media was not inserted.')); return;
            }
            if (runtime.session.doc.rev !== revision || runtime.selection.getSnapshot().sheet !== selection.sheet) {
                onError(new Error('The board changed while choosing media; choose the files again.')); return;
            }
            binding.controller.importFiles(files, point).catch(error => {
                onError(isCancellation(error)
                    ? new Error('The chosen media was not inserted: the import was interrupted. Choose the files again.') : error);
            });
        };
        try { current.click(); } catch (error) { closePicker(); onError(error); }
    };
    const imports: BoardToolServicesOptions['imports'] = {
        media(sample) {
            return { tool: { id: 'media-import', begin(first) {
                let point = { x: sample.x, y: sample.y };
                return { kind: 'node-edit', pointerIds: new Set([first.pointerId]),
                    update(samples) { const last = samples.at(-1); if (last) point = { x: last.x, y: last.y }; },
                    finish(reason) { if (reason === 'up') open(point); }, cancel: closePicker };
            } }, context: undefined };
        },
        paste(event) { binding.focus(); binding.controller.pasteEvent(event); },
        drop(event) { binding.focus(); binding.controller.drop(event); },
        // A paste, drop or duplicate on its way is not a pending gesture: what the person asked for lands, after any gesture begun
        // meanwhile (nativeClipboardController.ts). Cancelled here, every press, wheel turn, tool key, Escape or undo within the
        // paste's preparation lost it (measured: a box, click, stroke or drag within 100 ms of ⌘V, every time).
        cancelPending() { return closePicker(); },
        landing: () => binding.landing(),
        dispose() { if (!disposed) { disposed = true; closePicker(); } },
    };
    return { imports, open, dispose: imports.dispose };
}
