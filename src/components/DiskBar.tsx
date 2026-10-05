import { memo, useState } from 'react';
import type { DiskAction } from '../types';

interface DiskBarProps {
    /** The document's file name, as the bar names it. */
    name: string;
    state: 'conflict' | 'deleted';
    path: string;
    /** App's resolution for this document (stable). Resolves once it is done,
     *  whichever way it went; App reports failures itself. */
    onAction: (path: string, action: DiskAction) => Promise<void>;
}

/** `notes (conflict).md` — what the copy is called, for the tooltips. The real
 *  name may come out as `(conflict 2)` when that one is taken; App says which. */
function conflictName(name: string): string {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? `${name.slice(0, dot)} (conflict)${name.slice(dot)}` : `${name} (conflict)`;
}

/**
 * The strip over a document whose file parted ways with it on disk — changed
 * while the tab held unsaved edits, or deleted. A bar rather than a dialog: the
 * reader may want to read on, copy something out, or look at the other version
 * first, and nothing autosaves the tab while it is up (App.flushTab).
 *
 * Neither version is ever dropped: whichever the reader does not pick is kept
 * beside the file as a `(conflict)` copy (AGENTS.md: nothing the user made is
 * destroyed outright).
 */
function DiskBar({ name, state, path, onAction }: DiskBarProps) {
    const [busy, setBusy] = useState(false);
    const run = async (action: DiskAction) => {
        if (busy) return;
        setBusy(true);
        try { await onAction(path, action); } finally { setBusy(false); }
    };
    const copy = conflictName(name);

    return (
        <div className={`disk-bar is-${state}`} role="status">
            <span className="disk-bar-message">
                {state === 'conflict'
                    ? <><strong>{name}</strong> changed on disk while you had unsaved edits.</>
                    : <><strong>{name}</strong> was deleted on disk.</>}
            </span>
            <span className="disk-bar-actions">
                {state === 'conflict' ? (
                    <>
                        <button
                            type="button"
                            className="disk-bar-btn"
                            disabled={busy}
                            data-tooltip={`Show the version on disk. Yours is kept beside it as “${copy}”.`}
                            data-tooltip-position="bottom"
                            onClick={() => void run('reload')}
                        >
                            Reload
                        </button>
                        <button
                            type="button"
                            className="disk-bar-btn is-primary"
                            disabled={busy}
                            data-tooltip={`Save your version. The one on disk is kept beside it as “${copy}”.`}
                            data-tooltip-position="bottom"
                            onClick={() => void run('keep')}
                        >
                            Keep mine
                        </button>
                    </>
                ) : (
                    <>
                        <button
                            type="button"
                            className="disk-bar-btn"
                            disabled={busy}
                            data-tooltip="Close this tab"
                            data-tooltip-position="bottom"
                            onClick={() => void run('close')}
                        >
                            Close
                        </button>
                        <button
                            type="button"
                            className="disk-bar-btn is-primary"
                            disabled={busy}
                            data-tooltip="Write this document back to disk where it was"
                            data-tooltip-position="bottom"
                            onClick={() => void run('save')}
                        >
                            Save again
                        </button>
                    </>
                )}
            </span>
        </div>
    );
}

export default memo(DiskBar);
