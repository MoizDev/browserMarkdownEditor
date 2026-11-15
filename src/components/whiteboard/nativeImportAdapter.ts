import type { BoardToolServicesOptions } from '../../whiteboard/viewer/toolServices';
import type { ClipboardPoint } from '../../whiteboard/clipboard/types';
import type { NativeClipboardBinding } from './useNativeClipboard';
import type { BoardRuntime } from '../../whiteboard/host/runtime';

/** Uses the same document-owned clipboard/ingest controller as paste and drop. */
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
            // Every outcome of a chosen file is reported: a silent drop here is what made a picked image vanish.
            if (!currentOwner() || runtime.session.isReadOnly) {
                onError(new Error('The board is read-only, so the chosen media was not inserted.')); return;
            }
            // The rev and sheet decide whether the target still exists; the selection object changes on any tool's cleanup.
            if (runtime.session.doc.rev !== revision || runtime.selection.getSnapshot().sheet !== selection.sheet) {
                onError(new Error('The board changed while choosing media; choose the files again.')); return;
            }
            binding.controller.importFiles(files, point).catch(error => {
                onError(error instanceof DOMException && error.name === 'AbortError'
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
        cancelPending() { const pickerCancelled = closePicker(); return binding.controller.cancelPending() || pickerCancelled; },
        dispose() { if (!disposed) { disposed = true; closePicker(); } },
    };
    return { imports, open, dispose: imports.dispose };
}
