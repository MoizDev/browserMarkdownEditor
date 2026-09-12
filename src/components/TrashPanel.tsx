import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileText, FolderIcon, RotateCcw, Trash2 } from './icons';
import { dropTrashSubtree, formatDeletedAt, formatTrashSize } from '../utils/trash';
import { isCanvasFile, isImageFile } from '../utils/fileTypes';
import { isTextFile } from '../utils/vaultSearch';
import { ASSETS_DIR } from '../utils/assets';
import type { TrashItem, TrashRestoreResult } from '../types';

/**
 * What the right-hand pane is showing for the selected FILE. A folder never
 * reaches this: its row is a place to go into, and what it has to say (how much
 * is in it) is already in the item the crawl built, with nothing to read.
 */
type Preview =
    | { status: 'loading' }
    | { status: 'text'; text: string }
    | { status: 'image'; url: string }
    /** There is nothing to show, and `reason` is the line that says why. */
    | { status: 'none'; reason: string }
    | { status: 'error' };

/**
 * Text bigger than this is not previewed. The preview answers one question —
 * "is this the `notes.md` I meant, or the other one" — and the first screen
 * answers it; a 2MB file read and laid out as one <pre> buys nothing for the
 * pause it costs on a click that might have been a mis-click.
 */
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

/** Keyboard activation (Enter/Space) for the clickable rows. SearchPanel's, by
 *  copy: a `.tsx` may only export components (react-refresh), so sharing it
 *  would mean a module for four lines that neither panel would import twice.
 *
 *  With one line its rows do not need: these carry Put back and Delete BUTTONS
 *  inside the row, and Enter on a button bubbles up here — where preventDefault
 *  would cancel the button's own activation and select the row instead. */
function rowKeyHandler(activate: () => void) {
    return (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            activate();
        }
    };
}

/** The row with this `sourcePath` in the list as it is NOW, at any depth. The
 *  crawl's paths are unique across the vault, so a path IS the identity — which
 *  the captured objects held in `trail`/`selected` stop being the moment
 *  `dropTrashSubtree` rebuilds an ancestor around a row that has left. */
function findInTrash(items: TrashItem[], sourcePath: string): TrashItem | null {
    for (const item of items) {
        if (item.sourcePath === sourcePath) return item;
        if (item.children) {
            const hit = findInTrash(item.children, sourcePath);
            if (hit) return hit;
        }
    }
    return null;
}

/** Is `path` the subtree rooted at `root`, or inside it? The `path/` rule the
 *  tab handlers and `dropTrashSubtree` use, for the same reason: `notes` must
 *  not match `notesolder`. */
function isWithin(path: string, root: string): boolean {
    return path === root || path.startsWith(`${root}/`);
}

/** Where the row came from, and so where Put back will send it: the folder
 *  holding the `.Garbage` it was found in. A retired image goes back INSIDE
 *  that folder's `.Assets` rather than beside it — an embed resolves from
 *  nowhere else — so the row says so, through the one module that owns that
 *  name (utils/assets.ts) rather than spelling it a second time. */
function restoreLabel(item: TrashItem): string {
    if (item.origin === 'retired') {
        return item.restorePath ? `${item.restorePath}/${ASSETS_DIR}` : ASSETS_DIR;
    }
    return item.restorePath || 'the vault root';
}

interface TrashPanelProps {
    onClose: () => void;
    /** The crawl. Called once on mount; never re-run automatically. */
    onCrawl: () => Promise<TrashItem[]>;
    /** Put one item back. Already includes App's confirmations and its
     *  in-flight guard — the panel only reacts to the outcome. */
    onRestore: (item: TrashItem) => Promise<TrashRestoreResult>;
    /** Erase one item for good; false if nothing happened. */
    onDelete: (item: TrashItem) => Promise<boolean>;
    /** Erase every .Garbage in the vault; false if nothing happened. */
    onEmpty: (count: number) => Promise<boolean>;
    /** Read a trashed text file (CRLF-normalized) for the preview. */
    onReadText: (item: TrashItem) => Promise<string>;
    /** The bytes of a trashed picture, for the preview's object URL. A prop for
     *  the same reason `onReadText` is one: the File System Access API is not a
     *  component's to call (AGENTS.md's layering), and this is the only other
     *  thing in here that reads a file. */
    onReadFile: (item: TrashItem) => Promise<File>;
}

/**
 * TrashPanel — everything in every folder's `.Garbage`, in one modal: a flat
 * list on the left, a read-only preview on the right, and a put-back or a
 * permanent delete on each row.
 *
 * The list is FLAT on purpose. The vault's own shape is the file tree's job;
 * what the bin is for is "I deleted something, give it back", and that reads as
 * a single newest-first list no matter which folder the deletion happened in.
 * The one exception is a trashed folder, which stays one row you can go into —
 * it was deleted as a unit and is put back as one.
 *
 * Every question this panel raises is App's (it owns `ask`/`tell` and the app's
 * ConfirmDialog), so `onRestore`/`onDelete`/`onEmpty` have already asked by the
 * time they resolve. The panel draws no dialogs of its own.
 */
export default function TrashPanel({ onClose, onCrawl, onRestore, onDelete, onEmpty, onReadText, onReadFile }: TrashPanelProps) {
    const panelRef = useRef<HTMLDivElement | null>(null);
    /** null while the crawl is still walking the vault. */
    const [items, setItems] = useState<TrashItem[] | null>(null);
    /** The folders gone into, outermost first. Empty = the bin's root list. */
    const [trail, setTrail] = useState<TrashItem[]>([]);
    const [selected, setSelected] = useState<TrashItem | null>(null);
    const [preview, setPreview] = useState<Preview>({ status: 'none', reason: '' });
    const [busy, setBusy] = useState(false);

    // Whatever raised the panel — the sidebar's bin button. Read during the
    // first render, BEFORE the effect below moves focus into the panel, so it
    // is the opener and not the panel itself. ConfirmDialog's trick, for the
    // same reason: a keyboard user closing this must not be dropped at the top
    // of the document.
    const [opener] = useState<HTMLElement | null>(() => document.activeElement as HTMLElement | null);

    useEffect(() => {
        panelRef.current?.focus();
        return () => { if (opener?.isConnected) opener.focus(); };
    }, [opener]);

    // Take the keyboard back whenever it has fallen on the floor.
    //
    // Nearly everything in this panel UNMOUNTS the element that was clicked:
    // going into a folder replaces the row that was clicked to get there, a
    // breadcrumb step becomes plain text once it is the last one, and a put-back
    // or a delete removes the row whose button was pressed. Chromium answers each
    // of those by focusing <body> — and Escape is handled on the panel (see
    // handleKeyDown), so from that moment the panel could not be closed by
    // keyboard at all until something inside it was clicked again. Measured: open
    // the bin, click a trashed folder, press Escape — nothing happened.
    //
    // Runs after EVERY commit, because every one of those paths is a state change
    // and there is no single place to hook. Guarded on <body> exactly rather than
    // on "outside the panel": a ConfirmDialog this panel raised holds real focus
    // on its own button, and stealing that back would break the question's own
    // keyboard handling.
    useEffect(() => {
        const active = document.activeElement;
        if (!active || active === document.body) panelRef.current?.focus();
    });

    // Called once, and only the value it had at mount is ever used — the prop's
    // own contract.
    const onCrawlRef = useRef(onCrawl);
    const crawlRef = useRef<Promise<TrashItem[]> | null>(null);
    useEffect(() => {
        let live = true;
        // The crawl opens every folder in the vault looking for `.Garbage`, so
        // it is exactly the long vault walk AGENTS.md says must be serialized
        // rather than merely started: StrictMode's simulated remount would
        // otherwise lay a second full walk over the first. Held as the PROMISE
        // and not as its result — a panel that is closed and reopened is a new
        // component, and re-crawling on every open is the product decision (the
        // bin is never cached, because the disk is the truth).
        const crawl = crawlRef.current ?? (crawlRef.current = onCrawlRef.current());
        crawl.then(
            found => { if (live) setItems(found); },
            // App has already told the user. An empty list is still the honest
            // end state: leaving `items` null strands the panel on "Looking
            // through the vault…" with no way out except closing it.
            () => { if (live) setItems([]); },
        );
        return () => { live = false; };
    }, []);

    // Read through refs so a fresh closure from App cannot re-trigger the
    // effect below — that would re-read the file (or re-mint an object URL) on
    // a render that changed nothing about what is selected.
    const onReadTextRef = useRef(onReadText);
    const onReadFileRef = useRef(onReadFile);
    useEffect(() => {
        onReadTextRef.current = onReadText;
        onReadFileRef.current = onReadFile;
    });

    // A read is async and the pointer is not: a slow read of a big note must
    // not land on top of the picture clicked after it. The generation ref is
    // also what makes the object URL safe to revoke in the cleanup — a run that
    // has been superseded returns before it ever mints one.
    const previewSeqRef = useRef(0);
    useEffect(() => {
        const seq = ++previewSeqRef.current;
        const item = selected;
        if (!item || item.kind === 'directory') {
            setPreview({ status: 'none', reason: '' });
            return;
        }
        if (isImageFile(item.name)) {
            let url: string | null = null;
            setPreview({ status: 'loading' });
            void onReadFileRef.current(item).then(
                file => {
                    if (seq !== previewSeqRef.current) return;
                    url = URL.createObjectURL(file);
                    setPreview({ status: 'image', url });
                },
                () => { if (seq === previewSeqRef.current) setPreview({ status: 'error' }); },
            );
            // Nothing else releases these, and the bin is a panel people click
            // through dozens of rows in: without this, one decoded image stays
            // pinned in memory per click until the tab is closed.
            return () => { if (url) URL.revokeObjectURL(url); };
        }

        if (isTextFile(item.name) && !isCanvasFile(item.name)) {
            if (item.size > MAX_PREVIEW_BYTES) {
                setPreview({ status: 'none', reason: 'Too large to preview.' });
                return;
            }
            setPreview({ status: 'loading' });
            void onReadTextRef.current(item).then(
                text => { if (seq === previewSeqRef.current) setPreview({ status: 'text', text }); },
                () => { if (seq === previewSeqRef.current) setPreview({ status: 'error' }); },
            );
            return;
        }

        // PDFs, `.tldraw` and `.notebook` are the kinds it hurts most to say no
        // to — and they are the reason it says no. Drawing any of them needs
        // pdf.js or tldraw, and this panel is in the main bundle: one import
        // here would put ~450kB / ~1.7MB behind the sidebar's bin button for
        // every vault that has never held one (components/prefetchPanes.ts).
        setPreview({ status: 'none', reason: 'No preview for this kind of file.' });
    }, [selected]);

    /**
     * Take an item that has left the bin out of the list, along with everything
     * under it — and, for a put-back that replaced something, put the entry it
     * displaced at the top.
     *
     * Deliberately NOT a re-crawl. Walking every `.Garbage` in the vault again
     * to learn that one row has gone would cost what opening the panel cost,
     * and would reset the list under someone working through it row by row.
     * utils/trash.ts holds the rules the crawl builds its answers by precisely
     * so the list can be kept honest here without re-reading the disk.
     */
    const forget = useCallback((item: TrashItem, displaced?: TrashItem) => {
        setItems(prev => {
            if (!prev) return prev;
            const next = dropTrashSubtree(prev, item.sourcePath);
            // The displaced entry was a live file a moment ago: it is the
            // newest thing in the bin, and the only row here nobody asked to
            // delete — so it goes where it will actually be noticed.
            return displaced ? [displaced, ...next] : next;
        });
        // Standing inside a folder that has just been put back or erased: step
        // out to where it used to be rather than showing its ghost.
        setTrail(prev => {
            const gone = prev.findIndex(step => isWithin(step.sourcePath, item.sourcePath));
            return gone === -1 ? prev : prev.slice(0, gone);
        });
        setSelected(prev => (prev && isWithin(prev.sourcePath, item.sourcePath) ? null : prev));
    }, []);

    // One bin operation at a time, gated on the REF and not on `busy`: the
    // disabled attribute only lands on the next render, and these are slow
    // enough (a folder is copied entry by entry) for a second click to arrive
    // first. AGENTS.md's rule for every long vault write.
    const busyRef = useRef(false);
    const runExclusive = useCallback(async (work: () => Promise<void>) => {
        if (busyRef.current) return;
        busyRef.current = true;
        setBusy(true);
        try {
            await work();
        } catch {
            // App owns telling the user what went wrong; all the panel owes the
            // reader is not staying stuck in its busy state.
        } finally {
            busyRef.current = false;
            setBusy(false);
            // Focus recovery is the effect above, not here: `forget`'s setItems
            // has not been committed at this point, so the row whose button was
            // pressed is still mounted and still focused — a check here would
            // see nothing wrong and skip, and the row would unmount a moment
            // later taking the keyboard with it.
        }
    }, []);

    const putBack = useCallback((item: TrashItem) => void runExclusive(async () => {
        const result = await onRestore(item);
        // 'collision' is the user answering "cancel" to the three-way name
        // question, and 'error' is a failure App has said its piece about —
        // except one: App returns 'error' silently when its own trash in-flight
        // ref is held, which a reader can reach by closing this panel mid
        // put-back and reopening it. Both statuses mean the disk is untouched,
        // so the list must be too.
        if (result.status === 'ok') forget(item, result.displaced);
    }), [runExclusive, onRestore, forget]);

    const erase = useCallback((item: TrashItem) => void runExclusive(async () => {
        if (await onDelete(item)) forget(item);
    }), [runExclusive, onDelete, forget]);

    const emptyBin = useCallback(() => void runExclusive(async () => {
        if (!items?.length) return;
        if (!(await onEmpty(items.length))) return;
        setItems([]);
        setTrail([]);
        setSelected(null);
    }), [runExclusive, onEmpty, items]);

    const openItem = useCallback((item: TrashItem) => {
        setSelected(item);
        // In the SAME batch as the selection, so the commit that puts this
        // item's name in the preview's heading does not still be showing the
        // last one's body underneath it. The effect below cannot do it: it runs
        // after that commit has already had its chance to paint. Folders never
        // read `preview`, so this is invisible for them.
        if (item.kind === 'file') setPreview({ status: 'loading' });
        // A folder is a place rather than a document, so clicking it goes in.
        // It stays the selection as well, so the preview can say how much of
        // the vault that one row is holding.
        if (item.kind === 'directory') setTrail(prev => [...prev, item]);
    }, []);

    // `trail` and `selected` hold the items AS THEY WERE when they were
    // clicked. `dropTrashSubtree` rebuilds every ancestor of a row it removes
    // ({ ...item, children }), so a captured folder goes on serving a child
    // that has already left the bin — re-resolve both by path against the list
    // as it is now. A trail step that is gone entirely ends the trail.
    const trailNow = useMemo(() => {
        const live: TrashItem[] = [];
        for (const step of trail) {
            const found = items && findInTrash(items, step.sourcePath);
            if (!found) break;
            live.push(found);
        }
        return live;
    }, [items, trail]);
    const selectedNow = useMemo(
        () => (selected && items ? (findInTrash(items, selected.sourcePath) ?? selected) : selected),
        [items, selected],
    );

    const openFolder = trailNow.length ? trailNow[trailNow.length - 1] : null;
    const rows = openFolder ? (openFolder.children ?? []) : (items ?? []);

    // On the panel and NOT on `window`, which is the whole point: a window
    // listener added at mount would be registered BEFORE the one ConfirmDialog
    // adds when Delete permanently or Empty bin raises its question — and being
    // first, it would fire first and close the bin out from under the dialog
    // still asking about it. Here, an open ConfirmDialog's capture-phase
    // listener stops Escape before React ever dispatches it to this handler,
    // which is exactly the order the panel wants.
    const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        onClose();
    }, [onClose]);

    const renderRow = (item: TrashItem) => {
        const activate = () => openItem(item);
        const isSelected = selectedNow?.sourcePath === item.sourcePath;
        return (
            <div
                key={item.id}
                className={`tree-item trash-row${isSelected ? ' is-selected' : ''}`}
                role="button"
                tabIndex={0}
                title={item.sourcePath}
                onClick={activate}
                onKeyDown={rowKeyHandler(activate)}
            >
                <span className={`tree-item-icon ${item.kind === 'directory' ? 'folder-icon' : 'file-icon'}`}>
                    {item.kind === 'directory' ? <FolderIcon size={14} /> : <FileText size={14} />}
                </span>
                <span className="trash-row-name">{item.name}</span>
                <span className="trash-row-dir">{restoreLabel(item)}</span>
                <span className="trash-row-time">{formatDeletedAt(item.deletedAt)}</span>
                <span className="tree-item-actions">
                    <button
                        className="tree-action-btn"
                        title="Put back"
                        disabled={busy}
                        onClick={(e) => { e.stopPropagation(); putBack(item); }}
                    >
                        <RotateCcw size={13} />
                    </button>
                    <button
                        className="tree-action-btn trash-btn"
                        title="Delete permanently"
                        disabled={busy}
                        onClick={(e) => { e.stopPropagation(); erase(item); }}
                    >
                        <Trash2 size={13} />
                    </button>
                </span>
            </div>
        );
    };

    const renderPreview = () => {
        if (!selectedNow) {
            return <p className="trash-preview-empty">Pick something on the left to see what it was.</p>;
        }
        if (selectedNow.kind === 'directory') {
            const count = selectedNow.children?.length ?? 0;
            return (
                <>
                    <p className="trash-preview-title">{selectedNow.name}</p>
                    <p className="trash-preview-empty">
                        {count} item{count === 1 ? '' : 's'} inside · {formatTrashSize(selectedNow.size)}
                    </p>
                </>
            );
        }
        const when = formatDeletedAt(selectedNow.deletedAt);
        const size = formatTrashSize(selectedNow.size);
        return (
            <>
                <p className="trash-preview-title">{selectedNow.name}</p>
                {preview.status === 'loading' && <p className="trash-preview-empty">Reading…</p>}
                {preview.status === 'error' && <p className="trash-preview-empty">This one could not be read.</p>}
                {preview.status === 'image' && (
                    <img className="trash-preview-image" src={preview.url} alt={selectedNow.name} />
                )}
                {preview.status === 'text' && <pre className="trash-preview-text">{preview.text}</pre>}
                {preview.status === 'none' && (
                    <>
                        <p className="trash-preview-empty">{preview.reason}</p>
                        <p className="trash-preview-empty">{when ? `${size} · deleted ${when}` : size}</p>
                    </>
                )}
            </>
        );
    };

    return (
        <div className="trash-overlay" onMouseDown={onClose}>
            <div
                className="trash-panel"
                role="dialog"
                aria-modal="true"
                aria-label="Trash"
                tabIndex={-1}
                ref={panelRef}
                onMouseDown={(e) => e.stopPropagation()}
                onKeyDown={handleKeyDown}
            >
                <div className="trash-header">
                    <h3 className="trash-title">Trash</h3>
                    <button className="settings-close-btn" onClick={onClose} title="Close" aria-label="Close">×</button>
                </div>
                <div className="trash-body">
                    <div className="trash-list-pane">
                        {trailNow.length > 0 && (
                            <div className="trash-breadcrumb">
                                <button className="trash-crumb" onClick={() => setTrail([])}>All trash</button>
                                {trailNow.map((step, i) => (
                                    <React.Fragment key={step.id}>
                                        {' / '}
                                        {i === trailNow.length - 1 ? step.name : (
                                            <button
                                                className="trash-crumb"
                                                onClick={() => setTrail(trailNow.slice(0, i + 1))}
                                            >
                                                {step.name}
                                            </button>
                                        )}
                                    </React.Fragment>
                                ))}
                            </div>
                        )}
                        <div className="trash-list">
                            {items === null && <p className="trash-empty">Looking through the vault…</p>}
                            {items !== null && rows.length === 0 && (
                                <p className="trash-empty">
                                    {openFolder ? 'This folder was empty.' : 'Nothing has been deleted in this vault.'}
                                </p>
                            )}
                            {rows.map(renderRow)}
                        </div>
                    </div>
                    <div className="trash-preview-pane">{renderPreview()}</div>
                </div>
                <div className="trash-footer">
                    <button
                        className="trash-empty-btn"
                        disabled={busy || !items?.length}
                        onClick={emptyBin}
                    >
                        Empty bin
                    </button>
                </div>
            </div>
        </div>
    );
}
