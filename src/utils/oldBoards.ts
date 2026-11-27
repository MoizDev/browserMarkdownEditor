import { sniffCanvas, type CanvasSniff } from './canvasFormat';
import { isCanvasFile, isNativeDrawingFile } from './fileTypes';
import type { FileTreeNode } from '../types';

export type OldBoardKind = 'drawing' | 'notebook';

export function isOldBoardSniff(sniff: CanvasSniff | undefined): boolean {
    return sniff?.format === 'legacy-drawing' || sniff?.format === 'legacy-notebook' || sniff?.format === 'notebook-blank';
}

export function startsAsOldBoard(start: string, name: string): boolean {
    return isCanvasFile(name) && !isNativeDrawingFile(name) && start.trimStart().startsWith('{') && sniffCanvas(start, name).format !== 'native';
}

export function hasOldBoardName(name: string): boolean {
    return /\.(tldraw|tldr)$/i.test(name);
}

export function oldBoardReadOnlyReason(kind: OldBoardKind): string {
    return `This ${kind} is from an older version of the app. It opens read-only, exactly as it was, and is never changed; `
        + 'to work on it, the user makes an editable copy (the “Make an editable copy” button on its pane, or the file’s '
        + 'right-click menu), and the copy is changed instead.';
}

export function* editableCopyNames(name: string, kind: OldBoardKind): Generator<string> {
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = kind === 'notebook' ? '.notebook' : '.drawing';
    if (kind === 'drawing' && hasOldBoardName(name)) yield `${stem}${ext}`;
    yield `${stem} copy${ext}`;
    for (let n = 2; ; n++) yield `${stem} copy ${n}${ext}`;
}

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
const outcomes = new Map<string, { readonly promise: Promise<string | null>; readonly resolve: (path: string | null) => void }>();
export function editableCopyOutcome(documentId: string): Promise<string | null> | undefined { return outcomes.get(documentId)?.promise; }
export function settleEditableCopy(documentId: string, path: string | null, originalPath?: string): void {
    if (path !== null && originalPath !== undefined) swapped.set(originalPath, { path, at: Date.now() });
    const outcome = outcomes.get(documentId);
    if (!outcome) return;
    outcomes.delete(documentId);
    outcome.resolve(path);
}
const swapped = new Map<string, { readonly path: string; readonly at: number }>();
const SWAPPED_MEMORY_MS = 60_000;
export function recentEditableCopy(originalPath: string): string | undefined {
    const entry = swapped.get(originalPath);
    if (entry && Date.now() - entry.at > SWAPPED_MEMORY_MS) swapped.delete(originalPath);
    return entry && Date.now() - entry.at <= SWAPPED_MEMORY_MS ? entry.path : undefined;
}
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

let openForCopy: ((node: FileTreeNode) => void) | undefined;
export function registerEditableCopyOpener(open: (node: FileTreeNode) => void): () => void {
    openForCopy = open;
    return () => { if (openForCopy === open) openForCopy = undefined; };
}
export function makeEditableCopyOf(node: FileTreeNode): void { openForCopy?.(node); }

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

const copyNotices = new Map<string, string>();
export function handOffCopyNotice(documentId: string, text: string): void { copyNotices.set(documentId, text); }
export function takeCopyNotice(documentId: string): string | null {
    const text = copyNotices.get(documentId) ?? null;
    copyNotices.delete(documentId);
    return text;
}
