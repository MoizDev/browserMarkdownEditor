import type { FileTreeFileNode, TextRange } from '../types';

const NON_TEXT_RE = /\.(pdf|jpe?g|png|gif|webp|bmp|ico|avif|heic|mp[34]|m4[av]|wav|ogg|flac|mov|mkv|webm|zip|gz|tgz|bz2|7z|rar|tar|exe|dmg|iso|docx?|xlsx?|pptx?|odt|epub|woff2?|ttf|otf|eot)$/i;
export function isTextFile(name: string): boolean {
    return !NON_TEXT_RE.test(name);
}

const MAX_MATCHES_PER_FILE = 100;
const MAX_TOTAL_MATCHES = 500;
const MAX_RESULT_FILES = 200;

const CONTEXT_BEFORE = 24;
const CONTEXT_AFTER = 160;

export interface ContentMatch extends TextRange {
    before: string;
    text: string;
    after: string;
}

export interface FileSearchResult {
    file: FileTreeFileNode;
    nameMatch: TextRange | null;
    matches: ContentMatch[];
    clipped: boolean;
}

export interface VaultSearchResults {
    files: FileSearchResult[];
    matchCount: number;
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

