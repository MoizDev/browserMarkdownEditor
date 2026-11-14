import { bindPdfSelectAll } from '../../utils/pdfTextLayerSelection';
import { lineRange, pointForCharacter } from '../text/selection';
import type { TextPoint } from '../text/selection';
import type { PdfSelectionReply } from '../text/selectionCache';
import type { PdfSelectionState } from '../text/selectionState';
import { OUTSIDE } from '../text/types';

export interface PdfTextKeyboardHost {
    selection: PdfSelectionState;
    pageCount(): number;
    isFocused(): boolean;
    /** Visible pane request, priority 0. */
    page(page: number, signal: AbortSignal): Promise<PdfSelectionReply>;
    findOpen(): boolean;
    /** Cancel an asynchronous clipboard gather before clearing selection. */
    cancelCopy?(): boolean;
    /** The find owner closes the bar and retains its current hit as selection. */
    closeFindPreservingHit(): void;
}
export interface PdfTextKeyboardBinding { setVisible(visible: boolean): void; dispose(): void }
type Movement = { kind: 'grapheme' | 'word' | 'line' | 'edge'; direction: -1 | 1 };

function lineAt(page: PdfSelectionReply, offset: number): number {
    const { lines, charU16 } = page.sel;
    for (let i = 0; i * 2 + 1 < lines.length; i++) {
        if (offset >= charU16[lines[i * 2]] && offset <= charU16[lines[i * 2 + 1]]) return i;
    }
    return -1;
}
function characterAt(page: PdfSelectionReply, offset: number): number {
    const map = page.sel.charU16;
    let lo = 0, hi = Math.max(0, map.length - 1);
    while (lo < hi) { const mid = (lo + hi + 1) >>> 1; if (map[mid] <= offset) lo = mid; else hi = mid - 1; }
    return Math.min(Math.max(0, map.length - 2), lo);
}
function segmentBoundary(text: string, offset: number, direction: -1 | 1, kind: 'word' | 'grapheme'): number {
    const at = Math.max(0, Math.min(text.length, offset));
    try {
        const segments = new Intl.Segmenter(undefined, { granularity: kind }).segment(text);
        let previous = 0;
        for (const segment of segments) {
            if (kind === 'word' && !segment.isWordLike) continue;
            if (direction > 0 && segment.index + segment.segment.length > at) return segment.index + segment.segment.length;
            if (direction < 0 && segment.index >= at) return previous;
            previous = segment.index;
        }
        return direction > 0 ? text.length : previous;
    } catch {
        if (direction > 0 && at < text.length) return at + (text.codePointAt(at)! > 0xffff ? 2 : 1);
        if (direction < 0 && at > 0) return at - (at > 1 && /[\uDC00-\uDFFF]/u.test(text[at - 1]) && /[\uD800-\uDBFF]/u.test(text[at - 2]) ? 2 : 1);
        return at;
    }
}
function closestOnLine(page: PdfSelectionReply, line: number, x: number): TextPoint | null {
    const { lines, loose, flags, charU16 } = page.sel;
    const first = lines[line * 2], end = lines[line * 2 + 1];
    let best = -1, bestDistance = Infinity;
    for (let i = first; i < end; i++) {
        const p = i * 4;
        if ((flags[i] & OUTSIDE) || !(loose[p + 2] > loose[p]) || !(loose[p + 3] > loose[p + 1])) continue;
        const center = (loose[p] + loose[p + 2]) / 2, distance = Math.abs(center - x);
        if (distance < bestDistance) { best = i; bestDistance = distance; }
    }
    if (best < 0) return null;
    const center = (loose[best * 4] + loose[best * 4 + 2]) / 2;
    const rtl = !!page.sel.lineBidi[line];
    return pointForCharacter(page.page, charU16, best, (x >= center) !== rtl ? 'after' : 'before', page.text);
}
function pointX(page: PdfSelectionReply, point: TextPoint): number {
    const i = characterAt(page, point.offset), box = page.sel.loose;
    return (box[i * 4] + box[i * 4 + 2]) / 2;
}
async function move(host: PdfTextKeyboardHost, point: TextPoint, movement: Movement, signal: AbortSignal,
    preferredX: number | undefined): Promise<{ point: TextPoint; x?: number }> {
    const current = await host.page(point.page, signal);
    signal.throwIfAborted();
    point = { ...point, offset: Math.max(0, Math.min(current.text.length, point.offset)) };
    if (movement.kind === 'edge') {
        const line = lineAt(current, point.offset), range = line >= 0 ? lineRange(current.sel.charU16, current.sel.lines, line) : undefined;
        return { point: { ...point, offset: range ? movement.direction < 0 ? range.from : range.to : point.offset,
            affinity: movement.direction < 0 ? 'before' : 'after' } };
    }
    if (movement.kind === 'grapheme' || movement.kind === 'word') {
        const offset = segmentBoundary(current.text, point.offset, movement.direction, movement.kind);
        if (offset !== point.offset) return { point: { ...point, offset, affinity: movement.direction < 0 ? 'before' : 'after' } };
        const page = point.page + movement.direction;
        if (page >= 0 && page < host.pageCount()) {
            const next = await host.page(page, signal);
            signal.throwIfAborted();
            return { point: { page, offset: movement.direction < 0 ? next.text.length : 0,
                affinity: movement.direction < 0 ? 'before' : 'after' } };
        }
        return { point };
    }
    const x = Number.isFinite(preferredX) ? preferredX! : pointX(current, point);
    if (!Number.isFinite(x)) return { point };
    const line = lineAt(current, point.offset);
    let page = current, nextLine = line + movement.direction;
    for (;;) {
        const count = page.sel.lines.length / 2;
        if (nextLine >= 0 && nextLine < count) {
            const result = closestOnLine(page, nextLine, x);
            if (result) return { point: result, x };
            nextLine += movement.direction;
            continue;
        }
        const index = page.page + movement.direction;
        if (index < 0 || index >= host.pageCount()) return { point, x };
        page = await host.page(index, signal);
        signal.throwIfAborted();
        nextLine = movement.direction < 0 ? page.sel.lines.length / 2 - 1 : 0;
    }
}

/** Install in the focused pane only. Meta/Ctrl+A uses the same shared handler
 * as the classic viewer; Copy remains owned by textCopy, never a second route. */
export function bindPdfTextKeyboard(root: HTMLElement, host: PdfTextKeyboardHost): PdfTextKeyboardBinding {
    let visible = true, closed = false, lifetime = new AbortController(), preferredX: number | undefined;
    let queue: Promise<void> = Promise.resolve();
    const selectAll = bindPdfSelectAll(root, () => {
        if (!visible || !host.isFocused()) return false;
        host.selection.selectAll(host.pageCount());
    });
    const key = (event: KeyboardEvent) => {
        if (!visible || !host.isFocused() || event.defaultPrevented || event.isComposing) return;
        const target = event.target;
        if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select, [role="dialog"], [role="menu"]'))) return;
        if (event.key === 'Escape') {
            if (host.cancelCopy?.()) { event.preventDefault(); return; }
            if (host.findOpen()) { event.preventDefault(); host.closeFindPreservingHit(); }
            else if (host.selection.getSnapshot().selection) { event.preventDefault(); host.selection.clear(); }
            preferredX = undefined;
            return;
        }
        if (!event.shiftKey || event.metaKey || !host.selection.getSnapshot().selection) return;
        let movement: Movement | undefined;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') movement = { kind: event.altKey || event.ctrlKey ? 'word' : 'grapheme', direction: event.key === 'ArrowLeft' ? -1 : 1 };
        else if (!event.altKey && !event.ctrlKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) movement = { kind: 'line', direction: event.key === 'ArrowUp' ? -1 : 1 };
        else if (!event.altKey && !event.ctrlKey && (event.key === 'Home' || event.key === 'End')) movement = { kind: 'edge', direction: event.key === 'Home' ? -1 : 1 };
        if (!movement) return;
        event.preventDefault();
        const requested = movement, signal = lifetime.signal;
        queue = queue.then(async () => {
            const snapshot = host.selection.getSnapshot(), selection = snapshot.selection;
            if (!selection || signal.aborted || closed) return;
            const next = await move(host, selection.focus, requested, signal, preferredX);
            if (signal.aborted || closed || host.selection.getSnapshot().docKey !== snapshot.docKey ||
                host.selection.getSnapshot().selection !== selection) return;
            preferredX = requested.kind === 'line' ? next.x : undefined;
            host.selection.extend(next.point);
        }).catch(() => {});
    };
    root.addEventListener('keydown', key);
    return {
        setVisible(next) { if (visible === next) return; visible = next; if (next) lifetime = new AbortController(); else { lifetime.abort(); preferredX = undefined; } },
        dispose() { if (closed) return; closed = true; lifetime.abort(); selectAll(); root.removeEventListener('keydown', key); },
    };
}
