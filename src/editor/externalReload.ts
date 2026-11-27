import { isolateHistory } from '@codemirror/commands';
import { Annotation, type EditorState, type TransactionSpec } from '@codemirror/state';

/**
 * Marks the transaction that reloads a document from disk. The pane's update
 * listener (baked into the EditorState, so it must not close over anything
 * per-pane) sees it and reports the text with `{ fromDisk: true }` — content
 * WITHOUT dirty and without scheduling a save. Unannotated, the reload would
 * look like typing and be written straight back to the file it came from.
 */
export const externalReload = Annotation.define<boolean>();

export function minimalChange(from: string, to: string): { from: number; to: number; insert: string } | null {
    if (from === to) return null;
    const max = Math.min(from.length, to.length);
    let head = 0;
    while (head < max && from.charCodeAt(head) === to.charCodeAt(head)) head++;
    let tail = 0;
    while (tail < max - head
        && from.charCodeAt(from.length - 1 - tail) === to.charCodeAt(to.length - 1 - tail)) tail++;
    // Never split a surrogate pair at either cut: CodeMirror would accept it,
    // but the change would no longer describe two whole texts.
    if (head > 0 && isHighSurrogate(from.charCodeAt(head - 1))) head--;
    if (tail > 0 && isLowSurrogate(from.charCodeAt(from.length - tail))) tail--;
    return { from: head, to: from.length - tail, insert: to.slice(head, to.length - tail) };
}

function isHighSurrogate(code: number): boolean { return code >= 0xd800 && code <= 0xdbff; }
function isLowSurrogate(code: number): boolean { return code >= 0xdc00 && code <= 0xdfff; }

export function reloadSpec(state: EditorState, text: string): TransactionSpec | null {
    const change = minimalChange(state.doc.toString(), text);
    if (!change) return null;
    return {
        changes: change,
        annotations: [externalReload.of(true), isolateHistory.of('full')],
    };
}
