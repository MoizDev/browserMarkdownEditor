import { memo, useState } from 'react';
import type { DiskAction, PdfRebuildNotice } from '../types';

interface DiskBarProps {
    readOnly?: boolean;
    /** The document's file name, as the bar names it. */
    name: string;
    state: 'conflict' | 'deleted' | 'foreign' | 'kept';
    pdfRebuild?: PdfRebuildNotice;
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
function DiskBar({ name, state, path, onAction, readOnly, pdfRebuild }: DiskBarProps) {
    const [busy, setBusy] = useState(false);
    const run = async (action: DiskAction) => {
        if (busy) return;
        setBusy(true);
        try { await onAction(path, action); } finally { setBusy(false); }
    };
    const copy = conflictName(name);

    return (
        <div className={`disk-bar is-${state}`} role="status" onKeyDown={event => {
            if (state === 'foreign' && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); void run('keep-pdf'); }
        }}>
            <span className="disk-bar-message">
                {state === 'foreign'
                    ? <><strong>{name}</strong> {pdfRebuild?.reason === 'mismatch'
                        ? 'was changed by another program after this app saved it.'
                        : 'has a write mark this version cannot verify.'} Rebuilding from your last editable version would drop those changes. The file is read-only unless you choose to rebuild; a copy is kept in Trash first.</>
                    : state === 'kept'
                    ? pdfRebuild?.copyName
                        ? <>A copy of <strong>{name}</strong> was kept in Trash as “{pdfRebuild.copyName}”.</>
                        : <>Before the first save, a copy of this file is kept in Trash.</>
                    : state === 'conflict'
                    ? <><strong>{name}</strong> changed on disk{readOnly ? '.' : ' while you had unsaved edits.'}</>
                    : <><strong>{name}</strong> was deleted on disk.</>}
                {pdfRebuild?.error && <> {pdfRebuild.error} Nothing was rebuilt or saved. Try again when the copy can be kept.</>}
            </span>
            <span className="disk-bar-actions">
                {state === 'foreign' ? <>
                    <button type="button" className="disk-bar-btn" disabled={busy} onClick={() => void run('keep-pdf')}>Keep the file as it is</button>
                    <button type="button" className="disk-bar-btn" disabled={busy} onClick={() => void run('rebuild-pdf')}>Annotate from my last version</button>
                </> : state === 'kept' ? pdfRebuild?.error && <button type="button" className="disk-bar-btn" disabled={busy} onClick={() => void run('rebuild-pdf')}>Retry</button> : readOnly ? (<><button type="button" className="disk-bar-btn" disabled={busy} onClick={()=>void run('retry')}>Retry</button><button type="button" className="disk-bar-btn" disabled={busy} onClick={()=>void run('close')}>Close</button></>) : state === 'conflict' ? (
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
