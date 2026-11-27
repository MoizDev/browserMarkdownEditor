import { memo, useState } from 'react';
import type { DiskAction, PdfRebuildNotice } from '../types';

interface DiskBarProps {
    readOnly?: boolean;
    name: string;
    state: 'conflict' | 'deleted' | 'foreign' | 'kept';
    unsaved?: boolean;
    mineLost?: boolean;
    pdfRebuild?: PdfRebuildNotice;
    path: string;
    onAction: (path: string, action: DiskAction) => Promise<void>;
}

function conflictName(name: string): string {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? `${name.slice(0, dot)} (conflict)${name.slice(dot)}` : `${name} (conflict)`;
}

function DiskBar({ name, state, path, onAction, readOnly, pdfRebuild, unsaved, mineLost }: DiskBarProps) {
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
                    ? <><strong>{name}</strong> changed on disk{readOnly ? '.'
                        : mineLost ? '. This app no longer holds the version it showed, so only the one on disk can be shown.'
                        : unsaved ? ' while you had unsaved edits.'
                        : '. This tab still shows the version from before, with nothing unsaved.'}</>
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
                            data-tooltip={mineLost ? 'Show the version on disk' : `Show the version on disk. Yours is kept beside it as “${copy}”.`}
                            data-tooltip-position="bottom"
                            onClick={() => void run('reload')}
                        >
                            Reload
                        </button>
                        {!mineLost && <button
                            type="button"
                            className="disk-bar-btn is-primary"
                            disabled={busy}
                            data-tooltip={`Save your version. The one on disk is kept beside it as “${copy}”.`}
                            data-tooltip-position="bottom"
                            onClick={() => void run('keep')}
                        >
                            Keep mine
                        </button>}
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
