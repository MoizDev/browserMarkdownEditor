import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import type { EditorMode } from '../types';

export function modeExtensions(mode: EditorMode): Extension {
    const reading = mode === 'read';
    return [EditorView.editable.of(!reading), EditorState.readOnly.of(reading)];
}

export function canWrite(state: EditorState): boolean {
    return !state.readOnly && state.facet(EditorView.editable);
}
