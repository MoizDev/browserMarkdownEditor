import React, { useState, useEffect, useMemo, useDeferredValue, useRef, useSyncExternalStore } from 'react';
import { FileText, X } from './icons';
import { collectFiles } from '../utils/tree';
import type { FileSearchResult, VaultSearchResults } from '../utils/vaultSearch';
import type { SearchController, SearchRow } from '../utils/searchController';
import type { FileTreeNode, FileTreeFileNode, TextRange } from '../types';
import { getIndexProgress, getIndexUnavailable, subscribeIndexProgress } from '../utils/indexProgress';
import { consumeSearchRequest, getSearchRequest, subscribeSearchRequest } from '../utils/searchRequest';

interface SearchPanelProps {
    fileTree: FileTreeNode[];
    search: SearchController;
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
export default function SearchPanel({ fileTree, search, onOpenResult, onClose }: SearchPanelProps) {
    const progress = useSyncExternalStore(subscribeIndexProgress, getIndexProgress);
    const unavailable = useSyncExternalStore(subscribeIndexProgress, getIndexUnavailable);
    const [query, setQuery] = useState('');
    const requested = useSyncExternalStore(subscribeSearchRequest, getSearchRequest);
    useEffect(() => {
        if (!requested) return;
        setQuery(requested.query);
        consumeSearchRequest(requested.id);
    }, [requested]);
    const deferredQuery = useDeferredValue(query);
    const [ready, setReady] = useState(false);
    const [failed, setFailed] = useState(false);
    const [searchProgress, setSearchProgress] = useState<{ done: number; total: number } | null>(null);
    const [epoch, setEpoch] = useState(0);
    const [results, setResults] = useState<VaultSearchResults>({ files: [], matchCount: 0, clipped: false });
    const inputRef = useRef<HTMLInputElement | null>(null);
    const files = useMemo(() => collectFiles(fileTree), [fileTree]);

    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const unsubscribe = search.subscribe(() => {
            if (!query) return;
            clearTimeout(timer);
            timer = setTimeout(() => setEpoch(value => value + 1), 500);
        });
        return () => { unsubscribe(); clearTimeout(timer); };
    }, [query, search]);

    useEffect(() => {
        const abort = new AbortController();
        setResults({ files: [], matchCount: 0, clipped: false });
        setFailed(false);
        setSearchProgress(null);
        setReady(!deferredQuery);
        if (!deferredQuery) return () => abort.abort();
        const byPath = new Map(files.map(file => [file.path, file]));
        const rows: SearchRow[] = [];
        void search.search(deferredQuery, batch => {
            if (abort.signal.aborted) return;
            if (batch.reset) rows.length = 0;
            if (batch.scanned !== undefined && batch.total !== undefined) setSearchProgress({ done: batch.scanned, total: batch.total });
            rows.push(...batch.batch);
            const found = rows.flatMap(row => {
                const file = byPath.get(row.path);
                return file ? [{ file, nameMatch: row.nameMatch, matches: row.matches, clipped: row.clipped }] : [];
            });
            setResults({ files: [...found.filter(row => row.nameMatch), ...found.filter(row => !row.nameMatch)],
                matchCount: batch.matchCount, clipped: batch.clipped });
            if (batch.done) setReady(true);
        }, abort.signal).catch(() => { if (!abort.signal.aborted) { setFailed(true); setReady(true); } });
        return () => abort.abort();
    }, [deferredQuery, epoch, files, search]);

    /** Open a file group's best target: its first match, or just the file. */
    const openResult = (result: FileSearchResult) => {
        onOpenResult(result.file, result.matches[0] ?? null);
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.nativeEvent.isComposing) return; // IME candidate confirmation
        if (e.key === 'Escape') {
            // Handled: `dismissOnEscape` surfaces skip a prevented Escape, so
            // one press closes only this (#36).
            e.preventDefault();
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
                />
                {query && (
                    <button
                        className="search-clear-btn"
                        data-tooltip="Clear search"
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
                {!unavailable && (progress?.phase === 'sweeping' ? <p className="search-hint" role="status" data-tooltip="Checking vault files for the index">Indexing — {progress.done} of {progress.total}</p>
                    : query && !ready && searchProgress && <p className="search-hint" role="status" data-tooltip="Loading searchable text from the vault">Indexing — {searchProgress.done} of {searchProgress.total}</p>)}
                {!query && (
                    <p className="search-hint">Search file names and contents across the vault.</p>
                )}
                {query && !ready && (
                    <p className="search-hint">Searching vault…</p>
                )}
                {(unavailable || (query && failed)) && (
                    <p className="search-hint" role="status">{unavailable ? 'Search index unavailable — ' : 'Search unavailable. '}<button onClick={() => { search.retry(); setEpoch(value => value + 1); }}>Retry</button></p>
                )}
                {query && deferredQuery && ready && !failed && !unavailable && fileCount === 0 && (
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
                                data-tooltip={file.path}
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
