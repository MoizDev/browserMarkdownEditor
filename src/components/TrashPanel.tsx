import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileText, FolderIcon, PenTool, RotateCcw, Trash2 } from './icons';
import { dropTrashSubtree, formatDeletedAt, formatTrashSize } from '../utils/trash';
import { isCanvasFile, isDrawingFile, isNativeDrawingFile, isImageFile } from '../utils/fileTypes';
import { isTextFile } from '../utils/vaultSearch';
import { ASSETS_DIR } from '../utils/assets';
import type { TrashItem, TrashRestoreResult } from '../types';

type Preview =
    | { status: 'loading' }
    | { status: 'text'; text: string }
    | { status: 'image'; url: string }
    | { status: 'none'; reason: string }
    | { status: 'error' };

const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

function rowKeyHandler(activate: () => void) {
    return (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            activate();
        }
    };
}

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

function isWithin(path: string, root: string): boolean {
    return path === root || path.startsWith(`${root}/`);
}

function restoreLabel(item: TrashItem): string {
    if (item.origin === 'retired') {
        return item.restorePath ? `${item.restorePath}/${ASSETS_DIR}` : ASSETS_DIR;
    }
    return item.restorePath || 'the vault root';
}

interface TrashPanelProps {
    onClose: () => void;
    onCrawl: () => Promise<TrashItem[]>;
    onRestore: (item: TrashItem) => Promise<TrashRestoreResult>;
    onCopy: (item: TrashItem) => Promise<void>;
    onDelete: (item: TrashItem) => Promise<boolean>;
    onEmpty: (count: number) => Promise<boolean>;
    onReadText: (item: TrashItem) => Promise<string>;
    onReadFile: (item: TrashItem) => Promise<File>;
}

export default function TrashPanel({ onClose, onCrawl, onRestore, onCopy, onDelete, onEmpty, onReadText, onReadFile }: TrashPanelProps) {
    const panelRef = useRef<HTMLDivElement | null>(null);
    const [items, setItems] = useState<TrashItem[] | null>(null);
    const [trail, setTrail] = useState<TrashItem[]>([]);
    const [selected, setSelected] = useState<TrashItem | null>(null);
    const [preview, setPreview] = useState<Preview>({ status: 'none', reason: '' });
    const [busy, setBusy] = useState(false);

    const [opener] = useState<HTMLElement | null>(() => document.activeElement as HTMLElement | null);

    useEffect(() => {
        panelRef.current?.focus();
        return () => { if (opener?.isConnected) opener.focus(); };
    }, [opener]);

    useEffect(() => {
        const active = document.activeElement;
        if (!active || active === document.body) panelRef.current?.focus();
    });

    const onCrawlRef = useRef(onCrawl);
    const crawlRef = useRef<Promise<TrashItem[]> | null>(null);
    useEffect(() => {
        let live = true;
        const crawl = crawlRef.current ?? (crawlRef.current = onCrawlRef.current());
        crawl.then(
            found => { if (live) setItems(found); },
            () => { if (live) setItems([]); },
        );
        return () => { live = false; };
    }, []);

    const onReadTextRef = useRef(onReadText);
    const onReadFileRef = useRef(onReadFile);
    useEffect(() => {
        onReadTextRef.current = onReadText;
        onReadFileRef.current = onReadFile;
    });

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

        setPreview({ status: 'none', reason: 'No preview for this kind of file.' });
    }, [selected]);

    const forget = useCallback((item: TrashItem, displaced?: TrashItem) => {
        setItems(prev => {
            if (!prev) return prev;
            const next = dropTrashSubtree(prev, item.sourcePath);
            return displaced ? [displaced, ...next] : next;
        });
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
        }
    }, []);

    const putBack = useCallback((item: TrashItem) => void runExclusive(async () => {
        const result = await onRestore(item);
        if (result.status === 'ok') forget(item, result.displaced);
    }), [runExclusive, onRestore, forget]);

    const copy = useCallback((item: TrashItem) => void runExclusive(() => onCopy(item)), [runExclusive, onCopy]);

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
        if (item.kind === 'file') setPreview({ status: 'loading' });
        if (item.kind === 'directory') setTrail(prev => [...prev, item]);
    }, []);

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
                data-tooltip={item.sourcePath}
                onClick={activate}
                onKeyDown={rowKeyHandler(activate)}
            >
                <span className={`tree-item-icon ${item.kind === 'directory' ? 'folder-icon' : 'file-icon'}`}>
                    {item.kind === 'directory' ? <FolderIcon size={14} />
                        : isDrawingFile(item.name) || isNativeDrawingFile(item.name) ? <PenTool size={14} />
                            : <FileText size={14} />}
                </span>
                <span className="trash-row-name">{item.name}</span>
                <span className="trash-row-dir">{restoreLabel(item)}</span>
                <span className="trash-row-time">{formatDeletedAt(item.deletedAt)}</span>
                <span className="tree-item-actions">
                    {item.kind === 'file' && item.origin === 'trashed' && <button
                        className="tree-action-btn"
                        data-tooltip="Restore a copy without removing this backup"
                        aria-label="Restore a copy"
                        disabled={busy}
                        onClick={(e) => { e.stopPropagation(); copy(item); }}
                    ><FileText size={13} /></button>}
                    <button
                        className="tree-action-btn"
                        data-tooltip="Put back"
                        aria-label="Put back"
                        disabled={busy}
                        onClick={(e) => { e.stopPropagation(); putBack(item); }}
                    >
                        <RotateCcw size={13} />
                    </button>
                    <button
                        className="tree-action-btn trash-btn"
                        data-tooltip="Delete permanently"
                        aria-label="Delete permanently"
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
                    <button className="settings-close-btn" onClick={onClose} data-tooltip="Close" aria-label="Close">×</button>
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
