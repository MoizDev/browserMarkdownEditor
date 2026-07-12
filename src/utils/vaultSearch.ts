// Vault-wide search (VSCode-style): matches file names and file contents
// across the whole vault. The pure matching logic lives here so the sidebar
// SearchPanel stays a thin view; contents are served from an in-memory cache
// validated by (lastModified, size) so repeat searches never re-read
// unchanged files.

import type { FileTreeFileNode, TextRange } from '../types';

/** Files the app treats as non-text: opened externally instead of as an
 *  editable tab (see App.handleFileClick) and never content-indexed. Their
 *  names still match in search. */
const NON_TEXT_RE = /\.(pdf|jpe?g|png|gif|webp|bmp|ico|avif|heic|mp[34]|m4[av]|wav|ogg|flac|mov|mkv|webm|zip|gz|tgz|bz2|7z|rar|tar|exe|dmg|iso|docx?|xlsx?|pptx?|odt|epub|woff2?|ttf|otf|eot)$/i;
export function isTextFile(name: string): boolean {
    return !NON_TEXT_RE.test(name);
}

/** Content-indexing limits: skip any single file larger than 4MB and stop
 *  caching once 128MB of text is held (a stray log dump shouldn't balloon
 *  memory); skipped files remain searchable by name. */
const MAX_INDEXED_FILE_SIZE = 4 * 1024 * 1024;
const MAX_INDEXED_TOTAL_SIZE = 128 * 1024 * 1024;

/** Result caps, VSCode-style: bound per-keystroke work and DOM size. */
const MAX_MATCHES_PER_FILE = 100;
const MAX_TOTAL_MATCHES = 500;
const MAX_RESULT_FILES = 200;

/** Snippet context kept around a content match (chars before / after). */
const CONTEXT_BEFORE = 24;
const CONTEXT_AFTER = 160;

/** One content match, with a single-line display snippet split around the
 *  matched text (`before` already carries a leading ellipsis when clipped). */
export interface ContentMatch extends TextRange {
    before: string;
    text: string;
    after: string;
}

/** All of one file's hits: a name hit, content hits, or both. */
export interface FileSearchResult {
    file: FileTreeFileNode;
    /** Range of the first query occurrence in file.name, for highlighting. */
    nameMatch: TextRange | null;
    matches: ContentMatch[];
    /** True when this file had more matches than MAX_MATCHES_PER_FILE. */
    clipped: boolean;
}

export interface VaultSearchResults {
    files: FileSearchResult[];
    /** Total content matches across all files (name-only hits add 0). */
    matchCount: number;
    /** True when any cap was hit, i.e. more matches may exist than shown. */
    clipped: boolean;
}

const EMPTY_RESULTS: VaultSearchResults = { files: [], matchCount: 0, clipped: false };

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Case-insensitive literal matcher. Regex (not lowercased indexOf) so match
 *  offsets always index the ORIGINAL text — lowercasing can change string
 *  length for some characters (e.g. İ), which would shift every offset. */
function queryRegex(query: string): RegExp {
    return new RegExp(escapeRegExp(query), 'gi');
}

/** Build the one-line display snippet around a match. */
function makeMatch(text: string, from: number, to: number): ContentMatch {
    const lineStart = text.lastIndexOf('\n', from - 1) + 1;
    let lineEnd = text.indexOf('\n', to);
    if (lineEnd === -1) lineEnd = text.length;

    const beforeStart = Math.max(lineStart, from - CONTEXT_BEFORE);
    const before = beforeStart > lineStart
        ? '…' + text.slice(beforeStart, from)
        : text.slice(lineStart, from).trimStart();
    const after = text.slice(to, Math.min(lineEnd, to + CONTEXT_AFTER));

    return { from, to, before, text: text.slice(from, to), after };
}

/**
 * Search every vault file's name and (available) content for a literal,
 * case-insensitive query. Purely synchronous — contents come from `getText`
 * (the pre-loaded index, overlaid with open-tab buffers by the caller).
 * Files whose NAME matches are listed first; within each group files keep
 * vault tree order and matches keep document order.
 */
export function searchVault(
    files: FileTreeFileNode[],
    query: string,
    getText: (path: string) => string | undefined,
): VaultSearchResults {
    if (!query) return EMPTY_RESULTS;

    const re = queryRegex(query);
    const nameMatched: FileSearchResult[] = [];
    const contentOnly: FileSearchResult[] = [];
    let matchCount = 0;
    let clipped = false;

    for (const file of files) {
        if (nameMatched.length + contentOnly.length >= MAX_RESULT_FILES) {
            // Enough result rows — a broader query would render thousands of
            // DOM nodes per keystroke for no benefit.
            clipped = true;
            break;
        }

        re.lastIndex = 0;
        const nameHit = re.exec(file.name);
        const nameMatch: TextRange | null = nameHit
            ? { from: nameHit.index, to: nameHit.index + nameHit[0].length }
            : null;

        const matches: ContentMatch[] = [];
        let fileClipped = false;
        let text: string | undefined;
        if (matchCount >= MAX_TOTAL_MATCHES) {
            // Out of match budget — remaining files may have unseen matches.
            clipped = true;
        } else {
            text = getText(file.path);
        }
        if (text !== undefined) {
            re.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = re.exec(text)) !== null) {
                if (matches.length >= MAX_MATCHES_PER_FILE || matchCount >= MAX_TOTAL_MATCHES) {
                    fileClipped = true;
                    clipped = true;
                    break;
                }
                matches.push(makeMatch(text, m.index, m.index + m[0].length));
                matchCount++;
            }
        }

        if (nameMatch || matches.length > 0) {
            const result: FileSearchResult = { file, nameMatch, matches, clipped: fileClipped };
            if (nameMatch) nameMatched.push(result);
            else contentOnly.push(result);
        }
    }

    return { files: [...nameMatched, ...contentOnly], matchCount, clipped };
}

/* ─────────────────────────────────────────────────────────────────────────
 * VAULT TEXT CACHE
 * Keeps every text file's content in memory so each keystroke searches
 * synchronously. sync() re-validates against the current tree: unchanged
 * files (same lastModified + size) are never re-read, removed/renamed paths
 * are dropped. Text is line-ending-normalized to \n so match offsets always
 * agree with the CodeMirror document (which normalizes the same way).
 * ───────────────────────────────────────────────────────────────────────── */

interface CacheEntry {
    mtime: number;
    size: number;
    text: string;
}

export interface VaultTextCache {
    /** Load/refresh contents for `files`; returns a path → text snapshot. */
    sync(files: FileTreeFileNode[]): Promise<Map<string, string>>;
    /** Forget everything (e.g. when a different vault is opened). */
    clear(): void;
}

export function createVaultTextCache(): VaultTextCache {
    let entries = new Map<string, CacheEntry>();
    // Bumped by clear() so an in-flight sync from the previous vault can't
    // repopulate the cache after it was wiped.
    let generation = 0;

    return {
        async sync(files: FileTreeFileNode[]): Promise<Map<string, string>> {
            const startedGeneration = generation;
            const next = new Map<string, CacheEntry>();
            let totalSize = 0;
            await Promise.all(files.map(async (node) => {
                try {
                    const file = await node.handle.getFile();
                    if (file.size > MAX_INDEXED_FILE_SIZE) return;
                    // Synchronous check-then-add, so parallel tasks can't
                    // blow the budget between the two statements.
                    if (totalSize + file.size > MAX_INDEXED_TOTAL_SIZE) return;
                    totalSize += file.size;
                    const prev = entries.get(node.path);
                    const entry = prev && prev.mtime === file.lastModified && prev.size === file.size
                        ? prev
                        : {
                            mtime: file.lastModified,
                            size: file.size,
                            text: (await file.text()).replace(/\r\n?/g, '\n'),
                        };
                    next.set(node.path, entry);
                } catch {
                    // Unreadable (moved/locked) — its name remains searchable.
                }
            }));
            if (generation === startedGeneration) entries = next;

            const snapshot = new Map<string, string>();
            for (const [path, entry] of next) snapshot.set(path, entry.text);
            return snapshot;
        },
        clear() {
            generation++;
            entries = new Map();
        },
    };
}
