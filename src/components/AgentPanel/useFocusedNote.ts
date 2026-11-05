// What the new-chat screen says about what is open (EmptyState.tsx): the
// focused document's name and whether text is selected in it.

import { useEffect, useState, useSyncExternalStore } from 'react';
import { getActiveFilePath, subscribeActiveFile } from '../../utils/activeFile';
import { noteDisplayName } from '../../utils/fileTypes';
import { getView } from '../../utils/viewRegistry';

export interface FocusedNote {
    /** "Ideas" for Notes/Ideas.md; null with nothing open. */
    name: string | null;
    /** The note has a non-empty selection (markdown only). */
    hasSelection: boolean;
}

/**
 * The focused document and whether text is selected in it, for the context
 * line and the chips. The path is App's active-file store; the selection is
 * asked of the pane's own reporter (utils/viewRegistry.ts), since no store
 * holds it — only while `watching` (AgentPanel: the new-chat screen is up),
 * at most once a frame, and not while the keyboard is in the panel (the
 * note's selection cannot move then, and the composer's own caret fires
 * `selectionchange` on every key).
 */
export function useFocusedNote(watching: boolean): FocusedNote {
    const path = useSyncExternalStore(subscribeActiveFile, getActiveFilePath);
    const [hasSelection, setHasSelection] = useState(false);
    useEffect(() => {
        if (!watching) return;
        let live = true;
        let frame = 0;
        const check = () => {
            frame = 0;
            const reporter = path ? getView(path) : undefined;
            if (!reporter || reporter.kind !== 'markdown') { setHasSelection(false); return; }
            void Promise.resolve(reporter.describe()).then(
                info => { if (live) setHasSelection(info.kind === 'markdown' && info.selections.length > 0); },
                () => {},
            );
        };
        const onSelection = () => {
            if (frame || document.activeElement?.closest('[data-agent-panel]')) return;
            frame = requestAnimationFrame(check);
        };
        check();
        document.addEventListener('selectionchange', onSelection);
        return () => {
            live = false;
            cancelAnimationFrame(frame);
            document.removeEventListener('selectionchange', onSelection);
        };
    }, [path, watching]);
    const name = path ? noteDisplayName(path.slice(path.lastIndexOf('/') + 1)) : null;
    return { name, hasSelection };
}
