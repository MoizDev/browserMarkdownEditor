import React, { useState, useEffect, useMemo, useCallback, useDeferredValue, useRef } from 'react';
import { FileText, X } from './icons';
import { collectFiles } from '../utils/tree';
import { searchVault, isTextFile } from '../utils/vaultSearch';
import { isDrawingFile } from '../utils/fileTypes';
import type { VaultTextCache, FileSearchResult } from '../utils/vaultSearch';
import type { FileTreeNode, FileTreeFileNode, TextRange } from '../types';

interface SearchPanelProps {
    fileTree: FileTreeNode[];
    /** Owned by FileExplorer so indexed text survives closing the panel. */
    cache: VaultTextCache;
    /** Latest in-memory content of an open tab (may be newer than disk). */
    getOpenTabContent: (path: string) => string | null;
    /** Bumped after each completed save-flush → re-validate the disk index. */
    saveEpoch: number;
    onOpenResult: (node: FileTreeFileNode, range: TextRange | null) => void;
    onClose: () => void;
}

/** Wrap the matched slice of `text` in a highlight span. */
function Highlighted({ text, range }: { text: string; range: TextRange | null }) {
    if (!range) return <>{text}</>;
    return (
        <>
            {text.slice(0, range.from)}
            <span className="search-highlight">{text.slice(range.from, range.to)}</span>
            {text.slice(range.to)}
        </>
    );
}

/** Keyboard activation (Enter/Space) for the clickable result rows. */
function rowKeyHandler(activate: () => void) {
    return (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            activate();
        }
    };
}

/**
 * SearchPanel — the vault-wide search view that temporarily replaces the file
 * tree in the sidebar. Matches file names and file contents (VSCode-style),
 * grouped per file; clicking a row opens the file (and jumps to the match).
 */
export default function SearchPanel({ fileTree, cache, getOpenTabContent, saveEpoch, onOpenResult, onClose }: SearchPanelProps) {
    const [query, setQuery] = useState('');
    // Results are computed from the deferred value so typing stays instant
    // even while a large vault is being scanned.
    const deferredQuery = useDeferredValue(query);
    const [index, setIndex] = useState<Map<string, string> | null>(null);
    const inputRef = useRef<HTMLInputElement | null>(null);
    // Monotonic sync id: a slow, older sync must never overwrite the snapshot
    // of a newer one.
    const syncSeqRef = useRef(0);

    const files = useMemo(() => collectFiles(fileTree), [fileTree]);
    // Drawings are JSON on disk: indexing them would surface raw snapshot text
    // as match snippets. They stay searchable by NAME (they're still in `files`).
    const textFiles = useMemo(
        () => files.filter(f => isTextFile(f.name) && !isDrawingFile(f.name)),
        [files]
    );

    // (Re-)validate the disk index. The cache skips files whose (mtime, size)
    // are unchanged, so calls after the first are a cheap stat pass.
    const refreshIndex = useCallback(() => {
        const seq = ++syncSeqRef.current;
        cache.sync(textFiles).then(snapshot => {
            if (seq === syncSeqRef.current) setIndex(snapshot);
        });
    }, [cache, textFiles]);

    // Sync on mount, on tree changes, and after each save-flush lands (a file
    // edited then CLOSED would otherwise keep serving its pre-edit disk text).
    useEffect(() => {
        void saveEpoch; // dependency only — the trigger, not an input
        refreshIndex();
    }, [refreshIndex, saveEpoch]);

    // Open-tab buffers are read through a ref-backed accessor on purpose: it
    // keeps the memoized sidebar from re-rendering on editor keystrokes, at
    // the cost of results not live-updating while you type elsewhere. Any
    // query change, tree change, save, or refocus recomputes.
    const results = useMemo(
        () => searchVault(files, deferredQuery, path =>
            // An OPEN drawing would otherwise leak its live JSON buffer in here,
            // bypassing the index filter above.
            isDrawingFile(path) ? undefined : (getOpenTabContent(path) ?? index?.get(path))),
        [files, deferredQuery, index, getOpenTabContent]
    );

    /** Open a file group's best target: its first match, or just the file. */
    const openResult = (result: FileSearchResult) => {
        onOpenResult(result.file, result.matches[0] ?? null);
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.nativeEvent.isComposing) return; // IME candidate confirmation
        if (e.key === 'Escape') {
            onClose();
        } else if (e.key === 'Enter' && results.files.length > 0) {
            openResult(results.files[0]);
        }
    };

    const fileCount = results.files.length;
    const contentFileCount = results.files.filter(f => f.matches.length > 0).length;
    const summary = results.matchCount > 0
        ? `${results.matchCount} match${results.matchCount === 1 ? '' : 'es'} in ${contentFileCount} file${contentFileCount === 1 ? '' : 's'}`
        : `${fileCount} matching file${fileCount === 1 ? '' : 's'}`;
    const clippedNote = results.clipped
        ? (results.matchCount > 0 ? ` · first ${results.matchCount} shown` : ' · not all shown')
        : '';

    return (
        <div className="search-panel">
            <div className="search-input-row">
                <input
                    ref={inputRef}
                    className="search-input"
                    type="text"
                    placeholder="Search vault…"
                    aria-label="Search vault"
                    value={query}
                    autoFocus
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={handleKeyDown}
                    onFocus={refreshIndex}
                />
                {query && (
                    <button
                        className="search-clear-btn"
                        title="Clear search"
                        aria-label="Clear search"
                        onClick={() => { setQuery(''); inputRef.current?.focus(); }}
                    >
                        <X size={12} />
                    </button>
                )}
            </div>

            {query && fileCount > 0 && (
                <div className="search-summary">
                    {summary}
                    {clippedNote}
                </div>
            )}

            <div className="search-results">
                {!query && (
                    <p className="search-hint">Search file names and contents across the vault.</p>
                )}
                {query && index === null && (
                    <p className="search-hint">Indexing vault…</p>
                )}
                {query && deferredQuery && index !== null && fileCount === 0 && (
                    <p className="search-hint">No results for “{deferredQuery}”.</p>
                )}
                {query && results.files.map(result => {
                    const { file, nameMatch, matches } = result;
                    const dir = file.path.length > file.name.length
                        ? file.path.slice(0, file.path.length - file.name.length - 1)
                        : '';
                    return (
                        <div className="search-file-group" key={file.path}>
                            <div
                                className="tree-item search-file-header"
                                role="button"
                                tabIndex={0}
                                title={file.path}
                                onClick={() => openResult(result)}
                                onKeyDown={rowKeyHandler(() => openResult(result))}
                            >
                                <span className="tree-item-icon file-icon"><FileText size={14} /></span>
                                <span className="search-file-name">
                                    <Highlighted text={file.name} range={nameMatch} />
                                </span>
                                {dir && <span className="search-file-dir">{dir}</span>}
                                {matches.length > 0 && (
                                    <span className="search-file-count">
                                        {matches.length}{result.clipped ? '+' : ''}
                                    </span>
                                )}
                            </div>
                            {matches.map(match => (
                                <div
                                    className="search-match"
                                    role="button"
                                    tabIndex={0}
                                    key={match.from}
                                    onClick={() => onOpenResult(file, match)}
                                    onKeyDown={rowKeyHandler(() => onOpenResult(file, match))}
                                >
                                    {match.before}
                                    <span className="search-highlight">{match.text}</span>
                                    {match.after}
                                </div>
                            ))}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
