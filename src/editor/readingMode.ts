import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import type { EditorMode } from '../types';

/* ── What Reading mode IS, said once ──────────────────────────────────────
   BOTH facets, and each does a different job.

   `EditorView.editable: false` is the half the reader sees: `.cm-content`
   becomes contenteditable="false" with no tabindex, so nothing can be typed
   and a click does not even focus it — which is why the search keys need
   editor/noteSearch.ts to reach a note being read.

   `EditorState.readOnly: true` is the half CodeMirror's own editing paths
   check — the search panel's Replace row and replaceNext/replaceAll, drop,
   paste, cut and the editing commands. Until issue #17 it was never set, so a
   search panel carried into Reading mode by ⌘E kept a working Replace: it
   rewrote the note and autosaved it, even inside a collapsed section nobody
   could see.

   NEITHER blocks a programmatic `view.dispatch`. So a write the app dispatches
   itself, from a gesture a note being read can receive, asks `canWrite` first
   — the context menu's rows, the table editor, list Tab, image delete, and the
   pane's `.md` drop, which replaced a note being read outright until #17's
   fix. (A pasted image does not: a paste lands only in a focused editor,
   which a note being read never is.) */

/** The extensions that make `mode` what it is. Lives in DocumentPane's
 *  readOnlyCompartment, so ⌘E flips both facets in one reconfigure. */
export function modeExtensions(mode: EditorMode): Extension {
    const reading = mode === 'read';
    return [EditorView.editable.of(!reading), EditorState.readOnly.of(reading)];
}

/** May the app write into this document right now? The ONE copy of the
 *  predicate: import it rather than re-deriving it from either facet. (Asking
 *  "is this Reading mode" is a different question — headingFold's isReading.) */
export function canWrite(state: EditorState): boolean {
    return !state.readOnly && state.facet(EditorView.editable);
}
