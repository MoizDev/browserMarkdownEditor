// Drawings and notebooks written by the old app (tldraw JSON in a `.tldraw`, `.notebook` or `.tldr` file) are never
// written again: they open read-only, exactly as they were, and are worked on through an editable copy in this app's
// own format, made beside them. The owner's rule: the original is not converted, not backed up, not hidden and not
// changed — the person keeps both files and decides what to do with the old one.
//
// Which files are old is decided from the bytes each load actually read (canvasFormat.ts `sniffCanvas` for a text
// buffer, the engine's own admission for the pane), never from a name or a remembered flag: a path can hold a native
// board today and an old one tomorrow (the old app re-created it), and the reverse.
//
// No engine or React import: App, the tree and the board panes all read this.
import { sniffCanvas, type CanvasSniff } from './canvasFormat';
import { isCanvasFile, isNativeDrawingFile } from './fileTypes';
import type { FileTreeNode } from '../types';

export type OldBoardKind = 'drawing' | 'notebook';

/** A text buffer's sniff says it holds a board from the old app. 'notebook-blank' is one too: `{"paper":…,"ui":…}` is
 *  what the old app wrote for a notebook nobody had written in yet, and this app has only ever created native ones. */
export function isOldBoardSniff(sniff: CanvasSniff | undefined): boolean {
    return sniff?.format === 'legacy-drawing' || sniff?.format === 'legacy-notebook' || sniff?.format === 'notebook-blank';
}

/** Whether a drawing or notebook file whose first bytes are `start` (at least 256 characters of it, when it has them) is
 *  an old board, for a question that need not read it all (a menu row, a recovery offer). A native board names its format
 *  in its first line; anything else that is a JSON object under a board's name came from the old app. */
export function startsAsOldBoard(start: string, name: string): boolean {
    return isCanvasFile(name) && !isNativeDrawingFile(name) && start.trimStart().startsWith('{') && sniffCanvas(start, name).format !== 'native';
}

/** Names that are old boards unless their bytes say otherwise: `.tldraw` (the old app's drawings) and tldraw's own `.tldr`. */
export function hasOldBoardName(name: string): boolean {
    return /\.(tldraw|tldr)$/i.test(name);
}

/** What the pane, the agent and every write seam say about an old board. Written for both readers: it names the
 * gesture a person uses, so an agent refused with it can tell them what to do. */
export function oldBoardReadOnlyReason(kind: OldBoardKind): string {
    return `This ${kind} is from an older version of the app. It opens read-only, exactly as it was, and is never changed; `
        + 'to work on it, the user makes an editable copy (the “Make an editable copy” button on its pane, or the file’s '
        + 'right-click menu), and the copy is changed instead.';
}

/**
 * The names an editable copy of `name` tries, in order, in the original's folder. An old drawing becomes a `.drawing`
 * of the same name first, since the extension already tells the two apart; a notebook keeps its extension, so its copy
 * is named as one. Numbered as the app numbers a named copy (`(conflict)`, `(conflict 2)`): the first unnumbered, then
 * from 2. The caller proves each name free of files AND folders before it takes one.
 */
export function* editableCopyNames(name: string, kind: OldBoardKind): Generator<string> {
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = kind === 'notebook' ? '.notebook' : '.drawing';
    if (kind === 'drawing' && hasOldBoardName(name)) yield `${stem}${ext}`;
    yield `${stem} copy${ext}`;
    for (let n = 2; ; n++) yield `${stem} copy ${n}${ext}`;
}

/* ── "Make an editable copy" requests ─────────────────────────────────────────
 * The copy is written from the board the pane already holds in memory (never a second read and import of the file),
 * so a request — from the open dialog, the pane's bar or a tree row — is handed to the document's pane, which runs it
 * once its board is ready. Keyed by document id, never reused in a page load. */
const requested = new Set<string>();
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };

export function requestEditableCopy(documentId: string): void {
    if (requested.has(documentId)) return;
    if (!outcomes.has(documentId)) {
        let resolve!: (path: string | null) => void;
        const promise = new Promise<string | null>(done => { resolve = done; });
        outcomes.set(documentId, { promise, resolve });
    }
    requested.add(documentId);
    emit();
}
/* A copy from its request until it has taken the original's tab, resolved with the copy's path, or will not (null).
 * Export to PDF pressed meanwhile waits for it and exports the copy: it exported nothing, silently, when pressed in the
 * tenth of a second the swap takes (measured), as its tab was gone by the time the export finished. */
const outcomes = new Map<string, { readonly promise: Promise<string | null>; readonly resolve: (path: string | null) => void }>();
/** The copy being made of this document, if one is: its path once it has taken the tab, or null when it was not made. */
export function editableCopyOutcome(documentId: string): Promise<string | null> | undefined { return outcomes.get(documentId)?.promise; }
/** Said once per copy, by whichever learns its end first (App's swap with the paths; the pane's failure or abandonment). */
export function settleEditableCopy(documentId: string, path: string | null, originalPath?: string): void {
    if (path !== null && originalPath !== undefined) swapped.set(originalPath, { path, at: Date.now() });
    const outcome = outcomes.get(documentId);
    if (!outcome) return;
    outcomes.delete(documentId);
    outcome.resolve(path);
}
/* An original whose tab a copy took a moment ago, by its path: a menu opened on the original and chosen after the swap
 * still names it. Kept only briefly, and only ever read beside a check that the copy's tab is open. */
const swapped = new Map<string, { readonly path: string; readonly at: number }>();
const SWAPPED_MEMORY_MS = 60_000;
export function recentEditableCopy(originalPath: string): string | undefined {
    const entry = swapped.get(originalPath);
    if (entry && Date.now() - entry.at > SWAPPED_MEMORY_MS) swapped.delete(originalPath);
    return entry && Date.now() - entry.at <= SWAPPED_MEMORY_MS ? entry.path : undefined;
}
/** The pane takes the request when it starts the copy; a second press meanwhile is the same copy, not another. */
export function takeEditableCopyRequest(documentId: string): boolean {
    if (!requested.delete(documentId)) return false;
    emit();
    return true;
}
export function isEditableCopyRequested(documentId: string): boolean { return requested.has(documentId); }
export function subscribeEditableCopyRequests(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/* The tree row's "Make an editable copy" for a file that may not be open yet: App registers how (open it, then request),
 * so the memoized tree keeps no callback prop. Same pattern as conversionRestore.ts. */
let openForCopy: ((node: FileTreeNode) => void) | undefined;
export function registerEditableCopyOpener(open: (node: FileTreeNode) => void): () => void {
    openForCopy = open;
    return () => { if (openForCopy === open) openForCopy = undefined; };
}
export function makeEditableCopyOf(node: FileTreeNode): void { openForCopy?.(node); }

/* What a tree row's drawing or notebook is, for its menu: an old board (Make an editable copy), a board made from one
 * (Restore the copy from before conversion, utils/conversionRestore.ts), or neither. App answers from an open document's
 * own bytes, or from the first bytes of a closed file (a native board says so in its first line). The menu waits for
 * that at most this long, then goes by the name: a slow disk must not hold a right-click. */
export type BoardRowOrigin = 'old' | 'converted' | 'other';
const PEEK_WAIT_MS = 150;
let peek: ((node: FileTreeNode) => Promise<BoardRowOrigin>) | undefined;
export function registerBoardRowPeek(next: (node: FileTreeNode) => Promise<BoardRowOrigin>): () => void {
    peek = next;
    return () => { if (peek === next) peek = undefined; };
}
export function boardRowOrigin(node: FileTreeNode): Promise<BoardRowOrigin> {
    const byName: BoardRowOrigin = hasOldBoardName(node.name) ? 'old' : 'other';
    if (!peek) return Promise.resolve(byName);
    return Promise.race([peek(node).catch(() => byName), new Promise<BoardRowOrigin>(resolve => setTimeout(() => resolve(byName), PEEK_WAIT_MS))]);
}

/* What the importer left out is said once, in the COPY's notice (its file keeps those items as preserved records). The
 * pane that made the copy hands the sentence to the copy's document id; the copy's acquisition takes it. */
const copyNotices = new Map<string, string>();
export function handOffCopyNotice(documentId: string, text: string): void { copyNotices.set(documentId, text); }
export function takeCopyNotice(documentId: string): string | null {
    const text = copyNotices.get(documentId) ?? null;
    copyNotices.delete(documentId);
    return text;
}
